//! R-37 本地服务器资源监控：命令输出解析（纯逻辑，可单元测试）。
//!
//! 监控面板通过 SSH 周期执行 `free` / `df` / `top -bn1` / `cat /proc/meminfo` /
//! `cat /proc/net/dev` 等命令，本模块把这些**文本输出**解析为结构化指标。
//! 解析本身不依赖网络、不触隐私红线，是「纯本地监控」的可测试核心层。
//!
//! 设计要点：
//! - 所有解析函数接收 `&str`、返回 `Result<T>`，错误用 `TermError::Other` 携带上下文。
//! - 支持 `free` / `df` 的常见尺寸单位（`-b`/`-k`/`-m`/`-g`/`-h`）与容量百分比。
//! - 兼容新旧 `free` 列布局（合并的 `buff/cache` 与分离的 `buffers`+`cache`）。
//! - CPU 支持聚合行 `%Cpu(s):` 与逐核 `%Cpu0:` 求平均；内存兼容 `top` 的 `KiB/MiB/GiB` 标注。

use crate::error::{Result, TermError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// `free` / `df` 等命令产出的尺寸单位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SizeUnit {
    /// 字节（`free -b`）
    Bytes,
    /// KiB = 1024（`free` 默认 / `df -k`）
    Kib,
    /// MiB = 1024^2
    Mib,
    /// GiB = 1024^3
    Gib,
    /// TiB = 1024^4
    Tib,
    /// 自动按每个值的后缀识别（Ki/Mi/Gi/Ti 走 1024，K/M/G/T 走 1000）
    Human,
}

impl SizeUnit {
    /// 由 `free` 的命令行参数推导尺寸单位。
    pub fn from_free_flags(flags: &str) -> SizeUnit {
        let f = flags.replace(['-', ' '], "");
        if f.contains("b") {
            return SizeUnit::Bytes;
        }
        if f.contains("m") {
            return SizeUnit::Mib;
        }
        if f.contains("g") {
            return SizeUnit::Gib;
        }
        if f.contains("h") {
            return SizeUnit::Human;
        }
        SizeUnit::Kib
    }

    /// 由 `df` 的命令行参数推导尺寸单位。
    pub fn from_df_flags(flags: &str) -> SizeUnit {
        let f = flags.replace(['-', ' '], "");
        if f.contains("m") {
            return SizeUnit::Mib;
        }
        if f.contains("g") {
            return SizeUnit::Gib;
        }
        if f.contains("h") {
            return SizeUnit::Human;
        }
        if f.contains("b") {
            return SizeUnit::Bytes;
        }
        SizeUnit::Kib
    }
}

fn unit_multiplier(u: SizeUnit) -> u64 {
    match u {
        SizeUnit::Bytes => 1,
        SizeUnit::Kib => 1024,
        SizeUnit::Mib => 1024 * 1024,
        SizeUnit::Gib => 1024 * 1024 * 1024,
        SizeUnit::Tib => 1024 * 1024 * 1024 * 1024,
        SizeUnit::Human => 1,
    }
}

/// 解析尺寸后缀。约定（与 GNU `free -h` / `df -h` 行为一致）：
/// 裸 `K/M/G/T` 与 `Ki/Mi/Gi/Ti` 均按二进制 1024 计算；
/// 仅显式带 `B` 的 `KB/MB/GB/TB`（对应 `--si`）按十进制 1000 计算。
fn suffix_multiplier(suffix: &str) -> Result<u64> {
    let s = suffix.trim().to_ascii_uppercase();
    let mult = match s.as_str() {
        "" | "B" => 1,
        "K" => 1024,
        "KB" => 1_000,
        "KI" | "KIB" => 1024,
        "M" => 1024 * 1024,
        "MB" => 1_000_000,
        "MI" | "MIB" => 1024 * 1024,
        "G" => 1024 * 1024 * 1024,
        "GB" => 1_000_000_000,
        "GI" | "GIB" => 1024 * 1024 * 1024,
        "T" => 1024 * 1024 * 1024 * 1024,
        "TB" => 1_000_000_000_000,
        "TI" | "TIB" => 1024 * 1024 * 1024 * 1024,
        "P" => 1024 * 1024 * 1024 * 1024 * 1024,
        "PB" => 1_000_000_000_000_000,
        "PI" | "PIB" => 1024 * 1024 * 1024 * 1024 * 1024,
        _ => {
            return Err(TermError::Other(format!(
                "unknown size suffix: {suffix}"
            )))
        }
    };
    Ok(mult)
}

/// 解析单个尺寸 token。空或 `-`（free 占位）按 0 处理；`Human` 或带后缀时按后缀换算。
pub fn parse_size_token(token: &str, unit: SizeUnit) -> Result<u64> {
    let t = token.trim();
    if t.is_empty() || t == "-" {
        return Ok(0);
    }
    let split = t.find(|c: char| !(c.is_ascii_digit() || c == '.'));
    let (num, suffix) = match split {
        Some(i) => (t[..i].trim(), t[i..].trim()),
        None => (t, ""),
    };
    let value: f64 = num
        .parse()
        .map_err(|_| TermError::Other(format!("invalid number in size token: {token}")))?;
    let mult = if unit == SizeUnit::Human {
        suffix_multiplier(suffix)?
    } else if !suffix.is_empty() {
        // 容错：固定单位下若 token 仍带后缀，优先采用后缀（让 free -h 文本也能被解析）
        suffix_multiplier(suffix).unwrap_or(unit_multiplier(unit))
    } else {
        unit_multiplier(unit)
    };
    Ok((value * mult as f64).round() as u64)
}

// ---------------------------------------------------------------------------
// 内存（free / top / /proc/meminfo）
// ---------------------------------------------------------------------------

/// 内存快照（字节）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySnapshot {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub free_bytes: u64,
    pub shared_bytes: u64,
    pub buff_cache_bytes: u64,
    pub available_bytes: u64,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
    pub swap_free_bytes: u64,
}

fn header_names(line: &str) -> Vec<String> {
    line.split_whitespace()
        .map(|s| s.to_lowercase())
        .collect()
}

/// 依据表头列名取值；找不到时回退到默认现代列序。
fn free_mem_from_line(line: &str, header: &[String], unit: SizeUnit) -> Result<MemorySnapshot> {
    let cols: Vec<&str> = line.split_whitespace().collect();
    let names: Vec<String> = if header.is_empty() {
        vec![
            "total".into(),
            "used".into(),
            "free".into(),
            "shared".into(),
            "buff/cache".into(),
            "available".into(),
        ]
    } else {
        header.to_vec()
    };
    let get = |name: &str, syns: &[&str]| -> Option<u64> {
        for (j, n) in names.iter().enumerate() {
            if n == name || syns.contains(&n.as_str()) {
                // 数据行以 "Mem:"/"Swap:" 开头，值从 cols[1] 起与 names[0] 对齐
                return cols.get(j + 1).and_then(|t| parse_size_token(t, unit).ok());
            }
        }
        None
    };
    let total = get("total", &[])
        .ok_or_else(|| TermError::Other("free: missing total column".into()))?;
    let used = get("used", &[])
        .ok_or_else(|| TermError::Other("free: missing used column".into()))?;
    let free = get("free", &[])
        .ok_or_else(|| TermError::Other("free: missing free column".into()))?;
    let shared = get("shared", &[]).unwrap_or(0);
    let buff_cache = match get("buff/cache", &["buff_cache", "buffcache"]) {
        Some(v) => v,
        None => get("buffers", &[]).unwrap_or(0) + get("cache", &[]).unwrap_or(0),
    };
    let available = match get("available", &[]) {
        Some(v) => v,
        None => free + buff_cache, // 旧版 free 无 available 列，用 free+buff/cache 估算
    };
    Ok(MemorySnapshot {
        total_bytes: total,
        used_bytes: used,
        free_bytes: free,
        shared_bytes: shared,
        buff_cache_bytes: buff_cache,
        available_bytes: available,
        swap_total_bytes: 0,
        swap_used_bytes: 0,
        swap_free_bytes: 0,
    })
}

/// 解析 `free` 输出（可含 Mem 与 Swap 两行）。
pub fn parse_free(text: &str, unit: SizeUnit) -> Result<MemorySnapshot> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let mut header: Vec<String> = Vec::new();
    for l in &lines {
        if l.contains("total")
            && l.contains("used")
            && l.contains("free")
            && !l.to_lowercase().starts_with("mem")
            && !l.to_lowercase().starts_with("swap")
        {
            header = header_names(l);
            break;
        }
    }
    let mut mem: Option<MemorySnapshot> = None;
    let mut swap: (u64, u64, u64) = (0, 0, 0);
    for l in &lines {
        let lower = l.to_lowercase();
        if lower.starts_with("mem") {
            mem = Some(free_mem_from_line(l, &header, unit)?);
        } else if lower.starts_with("swap") {
            let s = free_mem_from_line(l, &header, unit)?;
            swap = (
                s.total_bytes,
                s.used_bytes,
                s.free_bytes,
            );
        }
    }
    let mut mem = mem.ok_or_else(|| TermError::Other("free output missing Mem line".into()))?;
    mem.swap_total_bytes = swap.0;
    mem.swap_used_bytes = swap.1;
    mem.swap_free_bytes = swap.2;
    Ok(mem)
}

/// 解析 `top` 的 `KiB Mem :` / `MiB Swap :` 行，返回 (total, free, used, buff_cache, available) 字节。
fn top_mem_line(line: &str, mult: u64) -> (u64, u64, u64, u64, u64) {
    let mut last: Option<f64> = None;
    let mut vals: HashMap<&str, u64> = HashMap::new();
    for tok in line.split_whitespace() {
        let t = tok.trim_end_matches(|c| c == ',' || c == '.' || c == ':');
        if let Ok(v) = t.parse::<f64>() {
            last = Some(v);
        } else if let Some(v) = last.take() {
            let bytes = (v * mult as f64).round() as u64;
            match t {
                "total" => {
                    vals.insert("total", bytes);
                }
                "free" => {
                    vals.insert("free", bytes);
                }
                "used" => {
                    vals.insert("used", bytes);
                }
                "buff/cache" | "cache" => {
                    vals.insert("buffcache", bytes);
                }
                "available" | "avail" => {
                    vals.insert("available", bytes);
                }
                _ => {}
            }
        }
    }
    let total = *vals.get("total").unwrap_or(&0);
    let free = *vals.get("free").unwrap_or(&0);
    let used = *vals.get("used").unwrap_or(&0);
    let buff = *vals.get("buffcache").unwrap_or(&0);
    let avail = *vals.get("available").unwrap_or(&(free + buff));
    (total, free, used, buff, avail)
}

/// 解析 `top` 输出中的内存（含 Swap）；找不到返回 None。
pub fn parse_top_memory(text: &str) -> Option<MemorySnapshot> {
    let mut mem: Option<MemorySnapshot> = None;
    let mut swap: (u64, u64, u64) = (0, 0, 0);
    for line in text.lines() {
        let t = line.trim();
        if !t.contains(':') || !(t.contains("Mem") || t.contains("Swap")) {
            continue;
        }
        let mult = if t.contains("KiB") {
            1024
        } else if t.contains("MiB") {
            1024 * 1024
        } else if t.contains("GiB") {
            1024 * 1024 * 1024
        } else if t.contains("TiB") {
            1024 * 1024 * 1024 * 1024
        } else {
            1
        };
        let (total, free, used, buff, avail) = top_mem_line(t, mult);
        if t.contains("Swap") {
            swap = (total, used, free.saturating_sub(used));
        } else {
            mem = Some(MemorySnapshot {
                total_bytes: total,
                used_bytes: used,
                free_bytes: free,
                shared_bytes: 0,
                buff_cache_bytes: buff,
                available_bytes: avail,
                swap_total_bytes: 0,
                swap_used_bytes: 0,
                swap_free_bytes: 0,
            });
        }
    }
    let mut m = mem?;
    m.swap_total_bytes = swap.0;
    m.swap_used_bytes = swap.1;
    m.swap_free_bytes = swap.2;
    Some(m)
}

/// 解析 `/proc/meminfo`。
pub fn parse_proc_meminfo(text: &str) -> Result<MemInfo> {
    let mut map: HashMap<String, u64> = HashMap::new();
    for line in text.lines() {
        let (key, rest) = match line.split_once(':') {
            Some(x) => x,
            None => continue,
        };
        let rest = rest.trim();
        let mut it = rest.split_whitespace();
        let val: u64 = match it.next() {
            Some(v) => v
                .parse()
                .map_err(|_| TermError::Other(format!("meminfo bad value: {line}")))?,
            None => continue,
        };
        let unit = it.next().unwrap_or("").to_ascii_lowercase();
        let mult = match unit.as_str() {
            "" => 1,
            "kb" => 1024,
            "mb" => 1024 * 1024,
            "gb" => 1024 * 1024 * 1024,
            _ => 1,
        };
        map.insert(key.trim().to_ascii_lowercase(), val * mult);
    }
    let total = map
        .get("memtotal")
        .copied()
        .ok_or_else(|| TermError::Other("meminfo missing MemTotal".into()))?;
    let free = map.get("memfree").copied().unwrap_or(0);
    let available = map.get("memavailable").copied().unwrap_or(free);
    let buffers = map.get("buffers").copied().unwrap_or(0);
    let cached = map.get("cached").copied().unwrap_or(0);
    Ok(MemInfo {
        total_bytes: total,
        free_bytes: free,
        available_bytes: available,
        buffers_bytes: buffers,
        cached_bytes: cached,
    })
}

/// `/proc/meminfo` 解析结果（字节）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemInfo {
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub available_bytes: u64,
    pub buffers_bytes: u64,
    pub cached_bytes: u64,
}

// ---------------------------------------------------------------------------
// 磁盘（df）
// ---------------------------------------------------------------------------

/// 单个文件系统的磁盘用量。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiskUsage {
    pub filesystem: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    /// 已用百分比 0..=100
    pub capacity_pct: u8,
    pub mountpoint: String,
}

/// 解析 `df` 输出（推荐 `df -Pk` 以避免折行；`-h` 亦支持）。
pub fn parse_df(text: &str, unit: SizeUnit) -> Result<Vec<DiskUsage>> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("Filesystem") && trimmed.contains("Mounted") {
            continue; // 表头
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 6 {
            continue; // 折行续行或异常行，跳过
        }
        let total = parse_size_token(parts[1], unit)?;
        let used = parse_size_token(parts[2], unit)?;
        let avail = parse_size_token(parts[3], unit)?;
        let cap_str = parts[4].trim_end_matches('%');
        let digits: String = cap_str.chars().filter(|c| c.is_ascii_digit()).collect();
        let capacity_pct: u8 = if digits.is_empty() {
            0
        } else {
            digits.parse().unwrap_or(0)
        };
        let mountpoint = parts[5..].join(" ");
        out.push(DiskUsage {
            filesystem: parts[0].to_string(),
            total_bytes: total,
            used_bytes: used,
            available_bytes: avail,
            capacity_pct: capacity_pct.min(100),
            mountpoint,
        });
    }
    // 一条有效数据行都没有 = 命令失败或输出异常：显式报错，
    // 避免上层把「没输出」误显示为「没有磁盘」（与 parse_free 等保持一致）。
    if out.is_empty() {
        return Err(TermError::Other("df output has no filesystem rows".into()));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// CPU / 负载（top / /proc/loadavg）
// ---------------------------------------------------------------------------

/// CPU 各占比（百分比，0..100）与综合使用率。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CpuSnapshot {
    pub usage_pct: f64,
    pub user_pct: f64,
    pub system_pct: f64,
    pub nice_pct: f64,
    pub idle_pct: f64,
    pub wait_pct: f64,
    pub hi_pct: f64,
    pub si_pct: f64,
    pub steal_pct: f64,
}

impl CpuSnapshot {
    fn zero() -> Self {
        CpuSnapshot {
            usage_pct: 0.0,
            user_pct: 0.0,
            system_pct: 0.0,
            nice_pct: 0.0,
            idle_pct: 0.0,
            wait_pct: 0.0,
            hi_pct: 0.0,
            si_pct: 0.0,
            steal_pct: 0.0,
        }
    }

    fn add(&self, o: &CpuSnapshot) -> CpuSnapshot {
        CpuSnapshot {
            usage_pct: self.usage_pct + o.usage_pct,
            user_pct: self.user_pct + o.user_pct,
            system_pct: self.system_pct + o.system_pct,
            nice_pct: self.nice_pct + o.nice_pct,
            idle_pct: self.idle_pct + o.idle_pct,
            wait_pct: self.wait_pct + o.wait_pct,
            hi_pct: self.hi_pct + o.hi_pct,
            si_pct: self.si_pct + o.si_pct,
            steal_pct: self.steal_pct + o.steal_pct,
        }
    }

    fn scale(&self, n: f64) -> CpuSnapshot {
        CpuSnapshot {
            usage_pct: self.usage_pct / n,
            user_pct: self.user_pct / n,
            system_pct: self.system_pct / n,
            nice_pct: self.nice_pct / n,
            idle_pct: self.idle_pct / n,
            wait_pct: self.wait_pct / n,
            hi_pct: self.hi_pct / n,
            si_pct: self.si_pct / n,
            steal_pct: self.steal_pct / n,
        }
    }
}

fn cpu_from_line(line: &str) -> Option<CpuSnapshot> {
    let idx = line.find(':')?;
    let rest = &line[idx + 1..];
    let mut map: HashMap<&str, f64> = HashMap::new();
    for tok in rest.split(',') {
        let tok = tok.trim();
        if tok.is_empty() {
            continue;
        }
        let end = tok.find(|c: char| !(c.is_ascii_digit() || c == '.'));
        if let Some(e) = end {
            let val: f64 = tok[..e].trim().parse().ok()?;
            let label = tok[e..].trim().trim_end_matches(|c: char| c.is_ascii_punctuation()).trim();
            match label {
                "us" => {
                    map.insert("us", val);
                }
                "sy" => {
                    map.insert("sy", val);
                }
                "ni" => {
                    map.insert("ni", val);
                }
                "id" => {
                    map.insert("id", val);
                }
                "wa" => {
                    map.insert("wa", val);
                }
                "hi" => {
                    map.insert("hi", val);
                }
                "si" => {
                    map.insert("si", val);
                }
                "st" => {
                    map.insert("st", val);
                }
                _ => {}
            }
        }
    }
    if map.is_empty() {
        return None;
    }
    let user = map.get("us").copied().unwrap_or(0.0);
    let system = map.get("sy").copied().unwrap_or(0.0);
    let nice = map.get("ni").copied().unwrap_or(0.0);
    let idle = map.get("id").copied().unwrap_or(0.0);
    let wait = map.get("wa").copied().unwrap_or(0.0);
    let hi = map.get("hi").copied().unwrap_or(0.0);
    let si = map.get("si").copied().unwrap_or(0.0);
    let steal = map.get("st").copied().unwrap_or(0.0);
    let usage = (100.0 - idle).max(0.0).min(100.0);
    Some(CpuSnapshot {
        usage_pct: usage,
        user_pct: user,
        system_pct: system,
        nice_pct: nice,
        idle_pct: idle,
        wait_pct: wait,
        hi_pct: hi,
        si_pct: si,
        steal_pct: steal,
    })
}

/// 解析 `top` 的 CPU 占比：优先聚合行 `%Cpu(s):`，否则对逐核求平均。
pub fn parse_top_cpu(text: &str) -> Result<CpuSnapshot> {
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with("%Cpu(s):") {
            if let Some(cpu) = cpu_from_line(t) {
                return Ok(cpu);
            }
        }
    }
    let mut sum = CpuSnapshot::zero();
    let mut count = 0u64;
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with("%Cpu") && !t.starts_with("%Cpu(s):") {
            if let Some(cpu) = cpu_from_line(t) {
                sum = sum.add(&cpu);
                count += 1;
            }
        }
    }
    if count > 0 {
        Ok(sum.scale(count as f64))
    } else {
        Err(TermError::Other("top output missing %Cpu line".into()))
    }
}

/// 系统平均负载。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LoadAvg {
    pub one: f64,
    pub five: f64,
    pub fifteen: f64,
}

/// 解析负载：支持 `/proc/loadavg` 数字三元组与 top 的 `load average:` 文本。
pub fn parse_load_avg(text: &str) -> Result<LoadAvg> {
    let s = text.trim();
    let toks: Vec<&str> = s.split_whitespace().collect();
    if toks.len() >= 3 {
        if let (Ok(a), Ok(b), Ok(c)) = (
            toks[0].parse::<f64>(),
            toks[1].parse::<f64>(),
            toks[2].parse::<f64>(),
        ) {
            return Ok(LoadAvg {
                one: a,
                five: b,
                fifteen: c,
            });
        }
    }
    parse_load_avg_from_text(text)
}

fn parse_load_avg_from_text(text: &str) -> Result<LoadAvg> {
    for line in text.lines() {
        if let Some(idx) = line.find("load average") {
            let rest = &line[idx..];
            let nums: Vec<f64> = rest
                .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E'))
                .filter_map(|t| t.trim_matches(',').parse::<f64>().ok())
                .collect();
            if nums.len() >= 3 {
                return Ok(LoadAvg {
                    one: nums[0],
                    five: nums[1],
                    fifteen: nums[2],
                });
            }
        }
    }
    Err(TermError::Other("load average not found".into()))
}

/// `top -bn1` 的整体快照。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TopSnapshot {
    pub cpu: CpuSnapshot,
    pub load: LoadAvg,
    pub memory: Option<MemorySnapshot>,
    pub tasks_total: Option<u32>,
    pub tasks_running: Option<u32>,
}

/// 解析 `top -bn1` 单帧输出。
pub fn parse_top(text: &str) -> Result<TopSnapshot> {
    let cpu = parse_top_cpu(text)?;
    let load = parse_load_avg(text)?;
    let memory = parse_top_memory(text);
    let mut tasks_total: Option<u32> = None;
    let mut tasks_running: Option<u32> = None;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("Tasks:") {
            let words: Vec<&str> = t.split_whitespace().collect();
            for i in 0..words.len() {
                if let Ok(v) = words[i].replace(',', "").parse::<u32>() {
                    if let Some(nxt) = words.get(i + 1) {
                        if nxt.contains("total") {
                            tasks_total = Some(v);
                        } else if nxt.contains("running") {
                            tasks_running = Some(v);
                        }
                    }
                }
            }
        }
    }
    Ok(TopSnapshot {
        cpu,
        load,
        memory,
        tasks_total,
        tasks_running,
    })
}

// ---------------------------------------------------------------------------
// 网络（/proc/net/dev）
// ---------------------------------------------------------------------------

/// 单网卡收发统计。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetInterface {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_packets: u64,
    pub tx_packets: u64,
}

/// 解析 `/proc/net/dev`。
pub fn parse_net_dev(text: &str) -> Result<Vec<NetInterface>> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim_start();
        let (name, rest) = match t.split_once(':') {
            Some(x) => x,
            None => continue,
        };
        let name = name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let nums: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|s| s.parse::<u64>().ok())
            .collect();
        if nums.len() < 16 {
            continue; // 表头或异常行
        }
        out.push(NetInterface {
            name,
            rx_bytes: nums[0],
            rx_packets: nums[1],
            tx_bytes: nums[8],
            tx_packets: nums[9],
        });
    }
    Ok(out)
}

/// 两次快照之间的速率（字节/秒）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NetRate {
    pub name: String,
    pub rx_bytes_per_sec: f64,
    pub tx_bytes_per_sec: f64,
}

/// 由前后两次 `parse_net_dev` 快照计算速率。
pub fn net_rate(prev: &[NetInterface], cur: &[NetInterface], dt_secs: f64) -> Vec<NetRate> {
    if dt_secs <= 0.0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for c in cur {
        if let Some(p) = prev.iter().find(|p| p.name == c.name) {
            let rx = (c.rx_bytes as f64 - p.rx_bytes as f64).max(0.0) / dt_secs;
            let tx = (c.tx_bytes as f64 - p.tx_bytes as f64).max(0.0) / dt_secs;
            out.push(NetRate {
                name: c.name.clone(),
                rx_bytes_per_sec: rx,
                tx_bytes_per_sec: tx,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===================== P0 正常路径 =====================
    #[test]
    fn p0_free_modern_kib() {
        let out = "\
               total        used        free      shared  buff/cache   available
Mem:        8000000     4000000     1000000      100000     3000000     4500000
Swap:       2000000           0     2000000
";
        let m = parse_free(out, SizeUnit::Kib).unwrap();
        assert_eq!(m.total_bytes, 8_000_000 * 1024);
        assert_eq!(m.used_bytes, 4_000_000 * 1024);
        assert_eq!(m.free_bytes, 1_000_000 * 1024);
        assert_eq!(m.buff_cache_bytes, 3_000_000 * 1024);
        assert_eq!(m.available_bytes, 4_500_000 * 1024);
        assert_eq!(m.swap_total_bytes, 2_000_000 * 1024);
        assert_eq!(m.swap_used_bytes, 0);
    }

    #[test]
    fn p0_df_posix_k() {
        let out = "\
Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/sda1       10255636  8234567    1234567      87% /
tmpfs            1024000        0    1024000       0% /dev/shm
";
        let disks = parse_df(out, SizeUnit::Kib).unwrap();
        assert_eq!(disks.len(), 2);
        assert_eq!(disks[0].filesystem, "/dev/sda1");
        assert_eq!(disks[0].total_bytes, 10255636 * 1024);
        assert_eq!(disks[0].used_bytes, 8234567 * 1024);
        assert_eq!(disks[0].available_bytes, 1234567 * 1024);
        assert_eq!(disks[0].capacity_pct, 87);
        assert_eq!(disks[0].mountpoint, "/");
        assert_eq!(disks[1].mountpoint, "/dev/shm");
    }

    #[test]
    fn p0_top_basic() {
        let out = "\
top - 12:00:00 up 10 days,  1:00,  2 users,  load average: 0.50, 0.75, 1.00
Tasks: 200 total,   1 running, 199 sleeping
%Cpu(s):  5.0 us,  2.0 sy,  0.0 ni, 93.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
MiB Mem :   8000.0 total,   2000.0 free,   4000.0 used,   2000.0 buff/cache
MiB Swap:   4000.0 total,   3500.0 free,    500.0 used.  100.0 avail Mem
";
        let top = parse_top(out).unwrap();
        assert!((top.cpu.usage_pct - 7.0).abs() < 1e-6);
        assert!((top.cpu.idle_pct - 93.0).abs() < 1e-6);
        assert!((top.load.one - 0.50).abs() < 1e-9);
        assert!((top.load.five - 0.75).abs() < 1e-9);
        assert!((top.load.fifteen - 1.00).abs() < 1e-9);
        assert_eq!(top.tasks_total, Some(200));
        assert_eq!(top.tasks_running, Some(1));
        let m = top.memory.unwrap();
        assert_eq!(m.total_bytes, (8000.0f64 * 1024.0 * 1024.0).round() as u64);
        assert_eq!(m.swap_total_bytes, (4000.0f64 * 1024.0 * 1024.0).round() as u64);
        assert_eq!(m.swap_used_bytes, (500.0f64 * 1024.0 * 1024.0).round() as u64);
    }

    #[test]
    fn p0_load_avg_proc() {
        let la = parse_load_avg("0.50 0.75 1.00 1/200 12345").unwrap();
        assert!((la.one - 0.50).abs() < 1e-9);
        assert!((la.five - 0.75).abs() < 1e-9);
        assert!((la.fifteen - 1.00).abs() < 1e-9);
    }

    #[test]
    fn p0_proc_meminfo() {
        let out = "\
MemTotal:       16384000 kB
MemFree:         2000000 kB
MemAvailable:   12000000 kB
Buffers:          100000 kB
Cached:          5000000 kB
";
        let info = parse_proc_meminfo(out).unwrap();
        assert_eq!(info.total_bytes, 16384000 * 1024);
        assert_eq!(info.free_bytes, 2000000 * 1024);
        assert_eq!(info.available_bytes, 12000000 * 1024);
        assert_eq!(info.buffers_bytes, 100000 * 1024);
        assert_eq!(info.cached_bytes, 5000000 * 1024);
    }

    #[test]
    fn p0_net_dev() {
        let out = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0: 1234567    1000    0    0    0     0          0         0  987654    800    0    0    0     0       0          0
    lo: 555       5    0    0    0     0          0         0    555       5    0    0    0     0       0          0
";
        let ifaces = parse_net_dev(out).unwrap();
        assert_eq!(ifaces.len(), 2);
        assert_eq!(ifaces[0].name, "eth0");
        assert_eq!(ifaces[0].rx_bytes, 1234567);
        assert_eq!(ifaces[0].tx_bytes, 987654);
        assert_eq!(ifaces[1].name, "lo");
    }

    // ===================== P1 核心指标 =====================
    #[test]
    fn p1_free_human() {
        let out = "\
               total        used        free      shared  buff/cache   available
Mem:           7.7Gi       3.9Gi       1.0Gi      100Mi       2.8Gi       4.5Gi
Swap:          2.0Gi          0B       2.0Gi
";
        let m = parse_free(out, SizeUnit::Human).unwrap();
        assert_eq!(m.total_bytes, (7.7f64 * 1024.0 * 1024.0 * 1024.0).round() as u64);
        assert_eq!(m.free_bytes, (1.0f64 * 1024.0 * 1024.0 * 1024.0).round() as u64);
        assert_eq!(m.buff_cache_bytes, (2.8f64 * 1024.0 * 1024.0 * 1024.0).round() as u64);
        assert_eq!(m.available_bytes, (4.5f64 * 1024.0 * 1024.0 * 1024.0).round() as u64);
        assert_eq!(m.swap_total_bytes, (2.0f64 * 1024.0 * 1024.0 * 1024.0).round() as u64);
    }

    #[test]
    fn p1_free_old_layout_separate_buffers_cache() {
        // 旧版 free 把 buffers / cache 拆成两列，且没有 available 列
        let out = "\
             total       used       free     shared    buffers     cache   available
Mem:       8000000    4000000    1000000     100000     200000    2800000
Swap:      2000000          0    2000000
";
        // 旧版无 available 列：用 free+buff/cache 估算
        let m = parse_free(out, SizeUnit::Kib).unwrap();
        assert_eq!(m.buff_cache_bytes, (200000 + 2800000) * 1024);
        // available 估算 = free + buff/cache
        assert_eq!(m.available_bytes, (1000000 + 200000 + 2800000) * 1024);
    }

    #[test]
    fn p1_df_human() {
        let out = "\
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        10G  7.9G  1.2G  87% /
";
        let disks = parse_df(out, SizeUnit::Human).unwrap();
        assert_eq!(disks.len(), 1);
        assert_eq!(disks[0].total_bytes, (10.0f64 * 1024.0 * 1024.0 * 1024.0).round() as u64);
        assert_eq!(disks[0].capacity_pct, 87);
    }

    #[test]
    fn p1_top_multi_core_averaged() {
        let out = "\
top - 12:00:00 up 1 day,  0 users,  load average: 1.00, 1.00, 1.00
%Cpu0  : 10.0 us,  0.0 sy,  0.0 ni, 90.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
%Cpu1  : 30.0 us,  0.0 sy,  0.0 ni, 70.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
";
        let cpu = parse_top_cpu(out).unwrap();
        // 平均使用率 = (10 + 30) / 2 = 20
        assert!((cpu.usage_pct - 20.0).abs() < 1e-6);
        assert!((cpu.idle_pct - 80.0).abs() < 1e-6);
    }

    #[test]
    fn p1_net_rate() {
        let prev = parse_net_dev("  eth0: 1000 10 0 0 0 0 0 0 500 5 0 0 0 0 0 0\n").unwrap();
        let cur = parse_net_dev("  eth0: 3000 30 0 0 0 0 0 0 1500 15 0 0 0 0 0 0\n").unwrap();
        let rates = net_rate(&prev, &cur, 2.0);
        assert_eq!(rates.len(), 1);
        assert!((rates[0].rx_bytes_per_sec - 1000.0).abs() < 1e-6);
        assert!((rates[0].tx_bytes_per_sec - 500.0).abs() < 1e-6);
    }

    // ===================== P2 边界 =====================
    #[test]
    fn p2_free_missing_available_estimated() {
        let out = "Mem: 8000000 4000000 1000000 100000 3000000\n";
        // 无表头、无 available：available = free + buff/cache
        let m = parse_free(out, SizeUnit::Kib).unwrap();
        assert_eq!(m.available_bytes, (1000000 + 3000000) * 1024);
    }

    #[test]
    fn p2_free_dash_placeholder_zero() {
        let out = "\
               total        used        free      shared  buff/cache   available
Mem:        8000000     4000000     1000000      100000     3000000          -
";
        let m = parse_free(out, SizeUnit::Kib).unwrap();
        assert_eq!(m.available_bytes, 0);
    }

    #[test]
    fn p2_df_capacity_100() {
        let out = "Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/full       1000   1000          0     100% /full
";
        let disks = parse_df(out, SizeUnit::Kib).unwrap();
        assert_eq!(disks[0].capacity_pct, 100);
        assert_eq!(disks[0].available_bytes, 0);
    }

    #[test]
    fn p2_df_wrapped_lines_skipped() {
        // 非 -P 时挂载点可能折行，续行字段不足，应被跳过
        let out = "\
Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/sda1       10255636  8234567    1234567      87% /mnt/very/long/
 mountpoint/that/wraps
";
        let disks = parse_df(out, SizeUnit::Kib).unwrap();
        assert_eq!(disks.len(), 1);
        assert_eq!(disks[0].mountpoint, "/mnt/very/long/");
    }

    #[test]
    fn p2_load_avg_from_top_text() {
        let la = parse_load_avg("top - 12:00:00 up 1 day, load average: 2.50, 1.75, 1.00").unwrap();
        assert!((la.one - 2.50).abs() < 1e-9);
        assert!((la.five - 1.75).abs() < 1e-9);
        assert!((la.fifteen - 1.00).abs() < 1e-9);
    }

    #[test]
    fn p2_top_missing_tasks() {
        let out = "\
top - 12:00:00 up 1 day,  0 users,  load average: 0.00, 0.00, 0.00
%Cpu(s):  2.0 us,  1.0 sy,  0.0 ni, 97.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
";
        let top = parse_top(out).unwrap();
        assert_eq!(top.tasks_total, None);
        assert_eq!(top.tasks_running, None);
        assert!((top.cpu.usage_pct - 3.0).abs() < 1e-6);
    }

    #[test]
    fn p2_net_dev_skips_headers() {
        let out = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
";
        let ifaces = parse_net_dev(out).unwrap();
        assert!(ifaces.is_empty());
    }

    #[test]
    fn p2_empty_input_errors() {
        assert!(parse_free("", SizeUnit::Kib).is_err());
        assert!(parse_df("", SizeUnit::Kib).is_err());
        assert!(parse_top_cpu("").is_err());
        assert!(parse_load_avg("").is_err());
        assert!(parse_proc_meminfo("").is_err());
    }

    // ===================== P3 组合 / 单位 =====================
    #[test]
    fn p3_free_flags_units() {
        assert_eq!(SizeUnit::from_free_flags("-b"), SizeUnit::Bytes);
        assert_eq!(SizeUnit::from_free_flags("free"), SizeUnit::Kib);
        assert_eq!(SizeUnit::from_free_flags("-k"), SizeUnit::Kib);
        assert_eq!(SizeUnit::from_free_flags("-m"), SizeUnit::Mib);
        assert_eq!(SizeUnit::from_free_flags("-g"), SizeUnit::Gib);
        assert_eq!(SizeUnit::from_free_flags("-h"), SizeUnit::Human);
        assert_eq!(SizeUnit::from_free_flags("-w"), SizeUnit::Kib);
    }

    #[test]
    fn p3_df_flags_units() {
        assert_eq!(SizeUnit::from_df_flags("df"), SizeUnit::Kib);
        assert_eq!(SizeUnit::from_df_flags("-k"), SizeUnit::Kib);
        assert_eq!(SizeUnit::from_df_flags("-m"), SizeUnit::Mib);
        assert_eq!(SizeUnit::from_df_flags("-g"), SizeUnit::Gib);
        assert_eq!(SizeUnit::from_df_flags("-h"), SizeUnit::Human);
    }

    #[test]
    fn p3_free_bytes_unit() {
        let out = "Mem: 8000000 4000000 1000000 100000 3000000 4500000\n";
        let m = parse_free(out, SizeUnit::Bytes).unwrap();
        assert_eq!(m.total_bytes, 8_000_000);
        assert_eq!(m.available_bytes, 4_500_000);
    }

    #[test]
    fn p3_size_token_suffixes() {
        // 1024 系：裸 K/M/G/T 与 Ki/Mi/Gi/Ti 均按二进制（对齐 GNU free -h / df -h）
        assert_eq!(parse_size_token("1Ki", SizeUnit::Human).unwrap(), 1024);
        assert_eq!(parse_size_token("1K", SizeUnit::Human).unwrap(), 1024);
        assert_eq!(parse_size_token("1Mi", SizeUnit::Human).unwrap(), 1024 * 1024);
        assert_eq!(parse_size_token("1M", SizeUnit::Human).unwrap(), 1024 * 1024);
        assert_eq!(
            parse_size_token("1Gi", SizeUnit::Human).unwrap(),
            1024 * 1024 * 1024
        );
        assert_eq!(
            parse_size_token("1G", SizeUnit::Human).unwrap(),
            1024 * 1024 * 1024
        );
        assert_eq!(
            parse_size_token("1Ti", SizeUnit::Human).unwrap(),
            1024 * 1024 * 1024 * 1024
        );
        assert_eq!(
            parse_size_token("1.5G", SizeUnit::Human).unwrap(),
            (1.5 * 1024.0 * 1024.0 * 1024.0) as u64
        );
        // 1000 系：仅显式带 B 的后缀（对应 --si）走十进制
        assert_eq!(parse_size_token("1KB", SizeUnit::Human).unwrap(), 1_000);
        assert_eq!(parse_size_token("1MB", SizeUnit::Human).unwrap(), 1_000_000);
        assert_eq!(
            parse_size_token("1.5GB", SizeUnit::Human).unwrap(),
            1_500_000_000
        );
        // 无单位走默认
        assert_eq!(parse_size_token("4096", SizeUnit::Kib).unwrap(), 4096 * 1024);
    }

    #[test]
    fn p3_top_mem_and_swap_populated() {
        let out = "\
KiB Mem :  8000000 total,  4000000 free,  3000000 used,  1000000 buff/cache
KiB Swap:  2000000 total,  1500000 free,   500000 used.
";
        let m = parse_top_memory(out).unwrap();
        assert_eq!(m.total_bytes, 8_000_000 * 1024);
        assert_eq!(m.swap_total_bytes, 2_000_000 * 1024);
        assert_eq!(m.swap_used_bytes, 500_000 * 1024);
    }

    // ===================== P4 防误报 / 鲁棒性 =====================
    #[test]
    fn p4_size_token_unknown_suffix_errors() {
        assert!(parse_size_token("10X", SizeUnit::Human).is_err());
        assert!(parse_size_token("abc", SizeUnit::Human).is_err());
    }

    #[test]
    fn p4_free_tolerates_whitespace_and_blank_lines() {
        let out = "\n\n   Mem:   8000000   4000000   1000000   100000   3000000   4500000   \n\n";
        let m = parse_free(out, SizeUnit::Kib).unwrap();
        assert_eq!(m.total_bytes, 8_000_000 * 1024);
        assert_eq!(m.available_bytes, 4_500_000 * 1024);
    }

    #[test]
    fn p4_df_tolerates_extra_spaces() {
        let out = "Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/sda1      10255636    8234567    1234567      87%      /
";
        let disks = parse_df(out, SizeUnit::Kib).unwrap();
        assert_eq!(disks.len(), 1);
        assert_eq!(disks[0].capacity_pct, 87);
    }

    #[test]
    fn p4_net_dev_ignores_short_interface() {
        // 字段不足 16 的异常行不应被当作接口
        let out = "  badif: 1 2 3 4 5\n";
        let ifaces = parse_net_dev(out).unwrap();
        assert!(ifaces.is_empty());
    }

    #[test]
    fn p4_cpu_missing_fields_default_zero() {
        // 只给 us / id，其余应为 0，usage 仍由 idle 推导
        let out = "%Cpu(s):  20.0 us, 80.0 id\n";
        let cpu = parse_top_cpu(out).unwrap();
        assert!((cpu.usage_pct - 20.0).abs() < 1e-6);
        assert!((cpu.system_pct - 0.0).abs() < 1e-6);
        assert!((cpu.wait_pct - 0.0).abs() < 1e-6);
    }

    // ===================== P5 极端 / 回归 =====================
    #[test]
    fn p5_size_token_terabyte_no_overflow() {
        assert_eq!(
            parse_size_token("4Ti", SizeUnit::Human).unwrap(),
            4 * 1024 * 1024 * 1024 * 1024
        );
    }

    #[test]
    fn p5_df_many_filesystems() {
        let mut out = String::from(
            "Filesystem     1024-blocks    Used Available Capacity Mounted on\n",
        );
        for i in 0..50 {
            out.push_str(&format!(
                "/dev/sd{}       1024000   512000    512000      50% /mnt/{}\n",
                i, i
            ));
        }
        let disks = parse_df(&out, SizeUnit::Kib).unwrap();
        assert_eq!(disks.len(), 50);
        assert_eq!(disks[49].mountpoint, "/mnt/49");
    }

    #[test]
    fn p5_net_dev_many_interfaces() {
        let mut out = String::new();
        for i in 0..100 {
            out.push_str(&format!(
                "  eth{}: {} 1 0 0 0 0 0 0 {} 1 0 0 0 0 0 0\n",
                i,
                i * 1000,
                i * 500
            ));
        }
        let ifaces = parse_net_dev(&out).unwrap();
        assert_eq!(ifaces.len(), 100);
        assert_eq!(ifaces[99].name, "eth99");
    }

    #[test]
    fn p5_df_unicode_mountpoint_preserved() {
        let out = "Filesystem     1024-blocks    Used Available Capacity Mounted on
/dev/sda1       10255636  8234567    1234567      87% /数据/项目
";
        let disks = parse_df(out, SizeUnit::Kib).unwrap();
        assert_eq!(disks[0].mountpoint, "/数据/项目");
    }

    #[test]
    fn p5_crlf_line_endings() {
        let out = "Mem: 8000000 4000000 1000000 100000 3000000 4500000\r\nSwap: 2000000 0 2000000\r\n";
        let m = parse_free(out, SizeUnit::Kib).unwrap();
        assert_eq!(m.total_bytes, 8_000_000 * 1024);
        assert_eq!(m.swap_total_bytes, 2_000_000 * 1024);
    }

    #[test]
    fn p5_cpu_idle_extremes() {
        let idle100 = parse_top_cpu("%Cpu(s):  0.0 us,  0.0 sy,  0.0 ni, 100.0 id, 0.0 wa, 0.0 hi, 0.0 si, 0.0 st\n").unwrap();
        assert!((idle100.usage_pct - 0.0).abs() < 1e-6);
        let idle0 = parse_top_cpu("%Cpu(s):  100.0 us,  0.0 sy,  0.0 ni, 0.0 id, 0.0 wa, 0.0 hi, 0.0 si, 0.0 st\n").unwrap();
        assert!((idle0.usage_pct - 100.0).abs() < 1e-6);
    }

    #[test]
    fn p5_proc_meminfo_large_no_overflow() {
        // 1 TiB 级别总内存（kB 计）不溢出
        let out = "MemTotal: 1099511627776 kB\nMemFree: 549755813888 kB\n";
        let info = parse_proc_meminfo(out).unwrap();
        assert_eq!(info.total_bytes, 1099511627776u64 * 1024);
        assert_eq!(info.free_bytes, 549755813888u64 * 1024);
    }
}
