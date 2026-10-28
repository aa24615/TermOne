//! Independent, bounded Linux monitoring over system OpenSSH. No main-terminal access.
use crate::{
    metrics::{self, DiskUsage, LoadAvg, NetInterface, NetRate, SizeUnit},
    SessionManager, SessionRequest, SshAuth,
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
type Result<T> = std::result::Result<T, String>;
const MAX_FRAME: usize = 512 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorTarget {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub auth: SshAuth,
    pub proxy_jump: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSample {
    pub sequence: u64,
    pub sampled_at: u64,
    pub cpu_pct: Option<f64>,
    pub memory_total: u64,
    pub memory_used: u64,
    pub memory_pct: f64,
    pub uptime_seconds: f64,
    pub load: Option<LoadAvg>,
    pub disks: Vec<DiskUsage>,
    pub network: Vec<NetRate>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorStatus {
    pub phase: String,
    pub sample: Option<MonitorSample>,
    pub error: Option<String>,
}

/// Only a validated interval and generated hexadecimal framing token enter this script.
pub fn collection_command(interval: u32, token: &str) -> Result<String> {
    if ![2, 5, 10, 30].contains(&interval)
        || token.len() != 32
        || !token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("无效的监控采样参数".into());
    }
    let script = format!(
        r#"LC_ALL=C; export LC_ALL
if [ "$(uname -s)" != Linux ] || [ ! -r /proc/stat ]; then printf 'TMON_{token}_UNSUPPORTED\n'; exit 1; fi
trap 'exit 0' HUP INT TERM
while :; do
printf 'TMON_{token}_BEGIN\n' || exit
printf '#CPU\n'; head -n 1 /proc/stat
printf '#UPTIME\n'; cat /proc/uptime
printf '#MEM\n'; cat /proc/meminfo
printf '#NET\n'; head -n 1026 /proc/net/dev
printf '#DISK\n'; df -Pk -l 2>/dev/null | head -n 257
printf '#LOAD\n'; cat /proc/loadavg
printf 'TMON_{token}_END\n' || exit
sleep {interval} || exit
done"#
    );
    Ok(format!("sh -c '{}'", script.replace('\'', "'\\''")))
}
#[derive(Clone, Debug)]
struct RawSample {
    cpu: (u64, u64),
    uptime: f64,
    total: u64,
    used: u64,
    disks: Vec<DiskUsage>,
    net: Vec<NetInterface>,
    load: Option<LoadAvg>,
}
fn parse_frame(text: &str) -> Result<RawSample> {
    let text = text.replace('\r', "");
    let section = |name: &str, next: &str| -> Result<&str> {
        text.split_once(name)
            .and_then(|(_, tail)| tail.split_once(next).map(|(v, _)| v))
            .ok_or_else(|| "监控数据不完整".into())
    };
    let cpu = section("#CPU\n", "#UPTIME\n")?
        .split_whitespace()
        .skip(1)
        .take(8)
        .map(|v| v.parse::<u64>().map_err(|_| "CPU 数据无效"))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if cpu.len() < 4 {
        return Err("CPU 数据不完整".into());
    }
    let total_ticks = cpu
        .iter()
        .try_fold(0u64, |a, b| a.checked_add(*b))
        .ok_or("CPU 计数溢出")?;
    let idle_ticks = cpu[3]
        .checked_add(*cpu.get(4).unwrap_or(&0))
        .ok_or("CPU 计数溢出")?;
    let uptime = section("#UPTIME\n", "#MEM\n")?
        .split_whitespace()
        .next()
        .unwrap_or("")
        .parse::<f64>()
        .map_err(|_| "运行时间无效")?;
    if !uptime.is_finite() || uptime < 0.0 {
        return Err("运行时间无效".into());
    }
    let mem =
        metrics::parse_proc_meminfo(section("#MEM\n", "#NET\n")?).map_err(|e| e.to_string())?;
    if mem.total_bytes == 0 {
        return Err("内存数据无效".into());
    }
    let used = mem.total_bytes.saturating_sub(mem.available_bytes);
    let net = metrics::parse_net_dev(section("#NET\n", "#DISK\n")?).map_err(|e| e.to_string())?;
    let disks = metrics::parse_df(section("#DISK\n", "#LOAD\n")?, SizeUnit::Kib)
        .map_err(|e| e.to_string())?;
    if disks.is_empty() || net.is_empty() {
        return Err("无法读取磁盘或网卡数据，请检查 df 与 /proc 权限".into());
    }
    let load =
        metrics::parse_load_avg(text.split_once("#LOAD\n").map(|(_, v)| v).unwrap_or("")).ok();
    Ok(RawSample {
        cpu: (total_ticks, idle_ticks),
        uptime,
        total: mem.total_bytes,
        used,
        disks,
        net,
        load,
    })
}

pub struct MonitorDecoder {
    buffer: Vec<u8>,
    begin: Vec<u8>,
    end: Vec<u8>,
    previous: Option<RawSample>,
    sequence: u64,
}
impl MonitorDecoder {
    pub fn new(token: &str) -> Self {
        Self {
            buffer: vec![],
            begin: format!("TMON_{token}_BEGIN").into_bytes(),
            end: format!("TMON_{token}_END").into_bytes(),
            previous: None,
            sequence: 0,
        }
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<MonitorSample>> {
        self.buffer.extend_from_slice(bytes);
        let mut samples = vec![];
        loop {
            let Some(start) = self
                .buffer
                .windows(self.begin.len())
                .position(|v| v == self.begin)
            else {
                let keep = self.begin.len();
                if self.buffer.len() > keep {
                    self.buffer.drain(..self.buffer.len() - keep);
                }
                break;
            };
            if start > 0 {
                self.buffer.drain(..start);
            }
            let Some(end) = self
                .buffer
                .windows(self.end.len())
                .position(|v| v == self.end)
            else {
                if self.buffer.len() > MAX_FRAME {
                    self.buffer.clear();
                    return Err("监控数据超过 512 KiB 上限".into());
                }
                break;
            };
            if end > MAX_FRAME {
                self.buffer.clear();
                return Err("监控数据超过 512 KiB 上限".into());
            }
            let raw = parse_frame(&String::from_utf8_lossy(
                &self.buffer[self.begin.len()..end],
            ))?;
            self.buffer.drain(..end + self.end.len());
            let cpu_pct = self.previous.as_ref().and_then(|prev| {
                let total = raw.cpu.0.checked_sub(prev.cpu.0)?;
                let idle = raw.cpu.1.checked_sub(prev.cpu.1)?;
                (total > 0).then(|| 100.0 * total.saturating_sub(idle) as f64 / total as f64)
            });
            let network = self
                .previous
                .as_ref()
                .filter(|prev| raw.uptime > prev.uptime)
                .map(|prev| metrics::net_rate(&prev.net, &raw.net, raw.uptime - prev.uptime))
                .unwrap_or_default();
            self.sequence += 1;
            samples.push(MonitorSample {
                sequence: self.sequence,
                sampled_at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                cpu_pct,
                memory_total: raw.total,
                memory_used: raw.used,
                memory_pct: raw.used as f64 / raw.total as f64 * 100.0,
                uptime_seconds: raw.uptime,
                load: raw.load,
                disks: raw.disks.clone(),
                network,
            });
            self.previous = Some(raw);
        }
        Ok(samples)
    }
}

struct Stream {
    decoder: MonitorDecoder,
    auth_buffer: String,
}
struct Inner {
    sessions: SessionManager,
    session_id: Mutex<Option<uuid::Uuid>>,
    status: Mutex<MonitorStatus>,
    stream: Mutex<Stream>,
    progress: Mutex<Instant>,
    stopped: AtomicBool,
}
impl Inner {
    fn stop(&self) {
        if !self.stopped.swap(true, Ordering::SeqCst) {
            self.sessions.close_all();
            let mut status = self.status.lock().unwrap();
            if status.phase != "error" {
                status.phase = "stopped".into();
            }
        }
    }
    fn fail(&self, message: &str) {
        if self.stopped.load(Ordering::SeqCst) { return; }
        {
            let mut status = self.status.lock().unwrap();
            status.phase = "error".into();
            status.error = Some(message.into());
        }
        self.stop();
    }
}
pub struct MonitorConnection {
    inner: Arc<Inner>,
}
impl Drop for MonitorConnection {
    fn drop(&mut self) {
        self.inner.stop();
    }
}
impl MonitorConnection {
    pub fn start(target: MonitorTarget, interval: u32) -> Result<Self> {
        if target.host.is_empty()
            || target.host.len() > 512
            || target
                .host
                .chars()
                .any(|c| c.is_control() || c.is_whitespace())
            || target.port == 0
        {
            return Err("SSH 主机地址或端口无效".into());
        }
        let token = uuid::Uuid::new_v4().simple().to_string();
        let command = collection_command(interval, &token)?;
        let inner = Arc::new(Inner {
            sessions: SessionManager::new(),
            session_id: Mutex::new(None),
            status: Mutex::new(MonitorStatus {
                phase: "connecting".into(),
                sample: None,
                error: None,
            }),
            stream: Mutex::new(Stream {
                decoder: MonitorDecoder::new(&token),
                auth_buffer: String::new(),
            }),
            progress: Mutex::new(Instant::now()),
            stopped: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&inner);
        let unsupported = format!("TMON_{token}_UNSUPPORTED");
        let output: crate::OutputSink = Arc::new(move |_, bytes| {
            let Some(inner) = weak.upgrade() else {
                return;
            };
            if inner.stopped.load(Ordering::SeqCst) {
                return;
            }
            let mut stream = inner.stream.lock().unwrap();
            let samples = match stream.decoder.push(&bytes) {
                Ok(samples) => samples,
                Err(error) => {
                    drop(stream);
                    inner.fail(&error);
                    return;
                }
            };
            let mut status = inner.status.lock().unwrap();
            if inner.stopped.load(Ordering::SeqCst) { return; }
            if let Some(sample) = samples.last() {
                status.phase = "running".into();
                status.sample = Some(sample.clone());
                status.error = None;
                stream.auth_buffer.clear();
                *inner.progress.lock().unwrap() = Instant::now();
            } else if status.sample.is_none() {
                stream
                    .auth_buffer
                    .push_str(&String::from_utf8_lossy(&bytes));
                if stream.auth_buffer.len() > 8192 {
                    stream.auth_buffer.clear();
                }
                let text = stream.auth_buffer.to_lowercase();
                if text.contains(&unsupported.to_lowercase()) {
                    drop(status);
                    drop(stream);
                    inner.fail("此监控应用目前支持 Linux 服务器，需要可读取 /proc 并提供 df 命令");
                    return;
                }
                if [
                    "password:",
                    "password：",
                    "passphrase",
                    "verification code",
                    "enter pin",
                    "密码：",
                    "密码:",
                ]
                .iter()
                .any(|word| text.contains(word))
                {
                    status.phase = "auth".into();
                }
            }
        });
        let weak = Arc::downgrade(&inner);
        let exit: crate::ExitSink = Arc::new(move |_, _| {
            if let Some(inner) = weak.upgrade() {
                if !inner.stopped.load(Ordering::SeqCst) {
                    inner.fail("SSH 监控连接已断开。请检查登录凭据、网络、主机指纹或 Linux 采集权限后重连。");
                }
            }
        });
        let info = inner
            .sessions
            .open(
                SessionRequest::Ssh {
                    host: target.host,
                    port: target.port,
                    user: target.user,
                    auth: target.auth,
                    proxy_jump: target.proxy_jump,
                    command: Some(command),
                    local_forward: None,
                    remote_forward: None,
                    dynamic_forward: None,
                },
                output,
                exit,
            )
            .map_err(|e| e.to_string())?;
        *inner.session_id.lock().unwrap() = Some(info.id);
        if inner.stopped.load(Ordering::SeqCst) {
            inner.sessions.close_all();
        }
        let weak = Arc::downgrade(&inner);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(250));
            let Some(inner) = weak.upgrade() else {
                break;
            };
            if inner.stopped.load(Ordering::SeqCst) {
                break;
            }
            let phase = inner.status.lock().unwrap().phase.clone();
            let timeout = if phase == "auth" {
                180
            } else if phase == "connecting" {
                30
            } else {
                u64::from(interval) * 3 + 20
            };
            let elapsed = inner.progress.lock().unwrap().elapsed();
            if elapsed > Duration::from_secs(timeout) {
                inner.fail("监控连接或采样超时，已停止采集。请检查网络后重新开始。");
                break;
            }
        });
        Ok(Self { inner })
    }
    pub fn status(&self) -> MonitorStatus {
        self.inner.status.lock().unwrap().clone()
    }
    /// Authentication input is never accepted after the first metric sample.
    pub fn authenticate(&self, secret: &str) -> Result<()> {
        if secret.is_empty() || secret.len() > 512 || secret.chars().any(char::is_control) {
            return Err("认证输入为空、过长或包含控制字符".into());
        }
        {
            let mut status = self.inner.status.lock().unwrap();
            if self.inner.stopped.load(Ordering::SeqCst)
                || status.phase != "auth"
                || status.sample.is_some()
            {
                return Err("当前不处于 SSH 认证阶段".into());
            }
            status.phase = "connecting".into();
        }
        self.inner.stream.lock().unwrap().auth_buffer.clear();
        *self.inner.progress.lock().unwrap() = Instant::now();
        let id = self
            .inner
            .session_id
            .lock()
            .unwrap()
            .ok_or("监控尚未就绪")?;
        self.inner
            .sessions
            .write(id, format!("{secret}\r").as_bytes())
            .map_err(|e| e.to_string())
    }
    pub fn stop(&self) {
        self.inner.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const TOKEN: &str = "0123456789abcdef0123456789abcdef";
    fn frame(user: u64, idle: u64, uptime: u64, received: u64) -> String {
        format!("TMON_{TOKEN}_BEGIN\n#CPU\ncpu {user} 0 0 {idle} 0 0 0 0 {user} 0\n#UPTIME\n{uptime}.00 0\n#MEM\nMemTotal: 8192 kB\nMemAvailable: 4096 kB\n#NET\neth0: {received} 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0\n#DISK\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda 10000 4000 6000 40% /数据\n#LOAD\n0.1 0.2 0.3 1/99 42\nTMON_{TOKEN}_END\n")
    }
    #[test]
    fn streaming_frames_handle_crlf_utf8_banners_and_interval_rates() {
        let mut decoder = MonitorDecoder::new(TOKEN);
        assert!(decoder.push(b"SSH banner\r\n").unwrap().is_empty());
        let mut rows = vec![];
        for byte in frame(100, 100, 10, 1000).replace('\n', "\r\n").bytes() { rows.extend(decoder.push(&[byte]).unwrap()); }
        assert_eq!(rows.len(), 1);
        assert!(rows[0].cpu_pct.is_none()); assert!(rows[0].network.is_empty());
        assert_eq!(rows[0].disks[0].mountpoint, "/数据");
        let row = decoder.push(frame(150, 150, 12, 2000).as_bytes()).unwrap().remove(0);
        assert_eq!(row.cpu_pct, Some(50.0)); // guest is already counted in user
        assert_eq!(row.memory_pct, 50.0);
        assert_eq!(row.network[0].rx_bytes_per_sec, 500.0);
        assert_eq!(row.sequence, 2);
    }
    #[test]
    fn counter_resets_and_reboots_do_not_create_rate_spikes() {
        let mut decoder = MonitorDecoder::new(TOKEN);
        decoder.push(frame(100, 100, 50, 9999).as_bytes()).unwrap();
        let row = decoder.push(frame(1, 1, 1, 1).as_bytes()).unwrap().remove(0);
        assert!(row.cpu_pct.is_none()); assert!(row.network.is_empty());
        let row = decoder.push(frame(1, 1, 3, 0).as_bytes()).unwrap().remove(0);
        assert!(row.cpu_pct.is_none()); assert_eq!(row.network[0].rx_bytes_per_sec, 0.0);
    }
    #[test]
    fn malformed_overflow_and_oversized_frames_fail_without_panics() {
        for raw in [frame(1, 1, 1, 1).replace("MemTotal: 8192", "MemTotal: 18446744073709551615"), frame(1, 1, 1, 1).replace("cpu 1", "cpu bad"), frame(1, 1, 1, 1).replace("1.00 0", "NaN 0")] {
            assert!(MonitorDecoder::new(TOKEN).push(raw.as_bytes()).is_err());
        }
        let mut decoder = MonitorDecoder::new(TOKEN);
        let huge = format!("TMON_{TOKEN}_BEGIN{}", "x".repeat(MAX_FRAME));
        assert!(decoder.push(huge.as_bytes()).is_err());
        assert!(decoder.buffer.is_empty());
    }
    #[test]
    fn collection_parameters_cannot_inject_commands() {
        for interval in [0, 1, 3, 60, u32::MAX] { assert!(collection_command(interval, TOKEN).is_err()); }
        assert!(collection_command(2, "'; touch /tmp/injected; '").is_err());
        assert!(collection_command(5, TOKEN).unwrap().contains("sleep 5"));
    }
}
