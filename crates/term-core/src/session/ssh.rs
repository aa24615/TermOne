//! SSH 会话：通过 PTY 驱动系统 OpenSSH 客户端。
//!
//! 复用系统 ssh 的密钥/代理/known_hosts 体系，避免重复实现协议栈；
//! 密码认证时由 ssh 在终端内提示输入（会话有真实 PTY）。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use super::local::spawn_pty;
use super::{ExitSink, OutputSink, SessionId, SessionKind, Spawned, SshAuth};
use crate::error::Result;

/// 展开 `~` / `~/` 开头的路径为绝对路径（-i 参数不经过 shell，无自动展开）。
fn expand_tilde(path: &str) -> String {
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().into_owned();
        }
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn(
    id: SessionId,
    host: String,
    port: u16,
    user: Option<String>,
    auth: SshAuth,
    command: Option<String>,
    proxy_jump: Option<String>,
    local_forward: Option<String>,
    remote_forward: Option<String>,
    dynamic_forward: Option<u16>,
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
            // 手动输入的 ~ 路径没有 shell 展开，这里补齐
            argv.push(expand_tilde(identity_file));
            argv.push("-o".into());
            argv.push("IdentitiesOnly=yes".into());
        }
    }
    // R-10 Jump Host / ProxyJump
    if let Some(pj) = &proxy_jump {
        if !pj.is_empty() {
            argv.push("-J".into());
            argv.push(pj.clone());
        }
    }
    // R-06 端口转发 / 隧道
    if let Some(lf) = &local_forward {
        if !lf.is_empty() {
            argv.push("-L".into());
            argv.push(lf.clone());
        }
    }
    if let Some(rf) = &remote_forward {
        if !rf.is_empty() {
            argv.push("-R".into());
            argv.push(rf.clone());
        }
    }
    if let Some(dp) = dynamic_forward {
        argv.push("-D".into());
        argv.push(dp.to_string());
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
