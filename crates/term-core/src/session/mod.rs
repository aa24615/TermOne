//! 会话管理：本地 Shell / SSH / 串口的统一抽象。
//!
//! 每个会话由独立线程读取输出并通过 `OutputSink` 回调；
//! 写入走会话内保存的 writer；PTY 会话支持 resize 与 kill。

mod local;
mod serial;
mod shells;
mod ssh;
pub mod sftp;

pub use serial::{list_ports, PortInfo};
pub use shells::{list_shells, ShellInfo};
pub use sftp::{SftpAuth, SftpEntry, SftpRequest};

use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{Result, TermError};

pub type SessionId = Uuid;

/// 输出回调：会话产生的原始字节。
pub type OutputSink = Arc<dyn Fn(SessionId, Vec<u8>) + Send + Sync>;
/// 退出回调：会话结束，携带退出码（串口会话为 None）。
pub type ExitSink = Arc<dyn Fn(SessionId, Option<i32>) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Local,
    Ssh,
    Serial,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: SessionId,
    pub title: String,
    pub kind: SessionKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SshAuth {
    Agent,
    Password,
    Key {
        identity_file: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SessionRequest {
    Local {
        shell: Option<String>,
        #[serde(default)]
        args: Vec<String>,
        cwd: Option<String>,
    },
    Ssh {
        host: String,
        #[serde(default = "default_ssh_port")]
        port: u16,
        user: Option<String>,
        auth: SshAuth,
        command: Option<String>,
        #[serde(default)]
        proxy_jump: Option<String>,
        #[serde(default)]
        local_forward: Option<String>,
        #[serde(default)]
        remote_forward: Option<String>,
        #[serde(default)]
        dynamic_forward: Option<u16>,
    },
    Serial {
        path: String,
        #[serde(default = "default_baud")]
        baud: u32,
        #[serde(default = "default_data_bits")]
        data_bits: u8,
        #[serde(default = "default_parity")]
        parity: String,
        #[serde(default = "default_stop_bits")]
        stop_bits: u8,
        #[serde(default = "default_flow_control")]
        flow_control: String,
    },
}

fn default_ssh_port() -> u16 {
    22
}
fn default_baud() -> u32 {
    115200
}
fn default_data_bits() -> u8 {
    8
}
fn default_parity() -> String {
    "none".into()
}
fn default_stop_bits() -> u8 {
    1
}
fn default_flow_control() -> String {
    "none".into()
}

pub(crate) struct Spawned {
    pub title: String,
    pub kind: SessionKind,
    pub writer: Box<dyn Write + Send>,
    pub master: Option<Box<dyn portable_pty::MasterPty + Send>>,
    /// 用于关闭会话（kill 子进程）；读取线程持有 Child 本体负责 wait。
    pub killer: Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

struct SessionInner {
    #[allow(dead_code)]
    title: String,
    #[allow(dead_code)]
    kind: SessionKind,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Option<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    killer: Option<Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    closing: Arc<AtomicBool>,
}

/// 系统默认 Shell。
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        if std::path::Path::new(r"C:\Program Files\PowerShell\7\pwsh.exe").exists() {
            return r"C:\Program Files\PowerShell\7\pwsh.exe".to_string();
        }
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|s| std::path::Path::new(s).exists())
            .or_else(|| {
                ["/bin/zsh", "/bin/bash", "/bin/sh"]
                    .iter()
                    .find(|p| std::path::Path::new(p).exists())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| "/bin/sh".to_string())
    }
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<SessionId, SessionInner>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn open(
        &self,
        req: SessionRequest,
        output: OutputSink,
        exit: ExitSink,
    ) -> Result<SessionInfo> {
        let id = Uuid::new_v4();
        let closing = Arc::new(AtomicBool::new(false));
        let spawned = match req {
            SessionRequest::Local { shell, args, cwd } => {
                local::spawn(id, shell, args, cwd, closing.clone(), output, exit)?
            }
            SessionRequest::Ssh {
                host,
                port,
                user,
                auth,
                command,
                proxy_jump,
                local_forward,
                remote_forward,
                dynamic_forward,
            } => ssh::spawn(
                id,
                host,
                port,
                user,
                auth,
                command,
                proxy_jump,
                local_forward,
                remote_forward,
                dynamic_forward,
                closing.clone(),
                output,
                exit,
            )?,
            SessionRequest::Serial {
                path,
                baud,
                data_bits,
                parity,
                stop_bits,
                flow_control,
            } => serial::spawn(
                id,
                path,
                baud,
                data_bits,
                parity,
                stop_bits,
                flow_control,
                closing.clone(),
                output,
                exit,
            )?,
        };
        let info = SessionInfo {
            id,
            title: spawned.title.clone(),
            kind: spawned.kind,
        };
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(
            id,
            SessionInner {
                title: spawned.title,
                kind: spawned.kind,
                writer: Mutex::new(spawned.writer),
                master: spawned.master.map(Mutex::new),
                killer: spawned.killer.map(Mutex::new),
                closing,
            },
        );
        Ok(info)
    }

    pub fn write(&self, id: SessionId, data: &[u8]) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(&id)
            .ok_or_else(|| TermError::SessionNotFound(id.to_string()))?;
        let mut writer = session.writer.lock().unwrap();
        writer.write_all(data).map_err(TermError::Io)?;
        writer.flush().map_err(TermError::Io)?;
        Ok(())
    }

    pub fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(&id)
            .ok_or_else(|| TermError::SessionNotFound(id.to_string()))?;
        if let Some(master) = &session.master {
            master
                .lock()
                .unwrap()
                .resize(portable_pty::PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| TermError::Pty(e.to_string()))?;
        }
        Ok(())
    }

    pub fn close(&self, id: SessionId) -> Result<()> {
        let session = self.sessions.lock().unwrap().remove(&id);
        if let Some(session) = session {
            session.closing.store(true, Ordering::Relaxed);
            if let Some(killer) = &session.killer {
                let _ = killer.lock().unwrap().kill();
            }
            // 主动丢弃 session（含 master），读取线程随即收到 EOF 并触发 exit 回调
            drop(session);
        }
        Ok(())
    }

    pub fn exists(&self, id: SessionId) -> bool {
        self.sessions.lock().unwrap().contains_key(&id)
    }
}
