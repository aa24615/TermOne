//! SSH 会话：通过 PTY 驱动系统 OpenSSH 客户端。
//!
//! 复用系统 ssh 的密钥/代理/known_hosts 体系，避免重复实现协议栈；
//! 密码认证时由 ssh 在终端内提示输入（会话有真实 PTY）。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use super::local::spawn_pty;
use super::{ExitSink, OutputSink, SessionId, SessionKind, Spawned, SshAuth};
use crate::error::Result;

#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn(
    id: SessionId,
    host: String,
    port: u16,
    user: Option<String>,
    auth: SshAuth,
    command: Option<String>,
    closing: Arc<AtomicBool>,
    output: OutputSink,
    exit: ExitSink,
) -> Result<Spawned> {
    let mut argv: Vec<String> = vec![
        "ssh".into(),
        "-p".into(),
        port.to_string(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
        "-o".into(),
        "ServerAliveInterval=30".into(),
    ];
    if let SshAuth::Key { identity_file } = &auth {
        if !identity_file.is_empty() {
            argv.push("-i".into());
            argv.push(identity_file.clone());
            argv.push("-o".into());
            argv.push("IdentitiesOnly=yes".into());
        }
    }
    argv.push(match &user {
        Some(u) if !u.is_empty() => format!("{u}@{host}"),
        _ => host.clone(),
    });
    if let Some(cmd) = command {
        if !cmd.is_empty() {
            argv.push(cmd);
        }
    }

    let title = match &user {
        Some(u) if !u.is_empty() => format!("{u}@{host}:{port}"),
        _ => format!("{host}:{port}"),
    };

    spawn_pty(
        id,
        argv,
        None,
        title,
        SessionKind::Ssh,
        closing,
        output,
        exit,
    )
}
