//! 本地 Shell 会话：通过 portable-pty 启动系统默认（或指定）Shell。

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use super::{ExitSink, OutputSink, SessionId, SessionKind, Spawned};
use crate::error::{Result, TermError};

pub(crate) fn spawn(
    id: SessionId,
    shell: Option<String>,
    args: Vec<String>,
    cwd: Option<String>,
    closing: Arc<AtomicBool>,
    output: OutputSink,
    exit: ExitSink,
) -> Result<Spawned> {
    let shell = shell.unwrap_or_else(super::default_shell);
    let mut argv = vec![shell];
    argv.extend(args);
    let title = argv[0]
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(&argv[0])
        .to_string();
    spawn_pty(
        id, argv, cwd, title, SessionKind::Local, closing, output, exit,
    )
}

/// 通过 PTY 启动程序；本地 Shell 与 SSH 会话共用。
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_pty(
    id: SessionId,
    argv: Vec<String>,
    cwd: Option<String>,
    title: String,
    kind: SessionKind,
    closing: Arc<AtomicBool>,
    output: OutputSink,
    exit: ExitSink,
) -> Result<Spawned> {
    let (program, args) = argv
        .split_first()
        .ok_or_else(|| TermError::Other("argv is empty".into()))?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| TermError::Pty(e.to_string()))?;

    let mut cmd = CommandBuilder::new(program);
    for a in args {
        cmd.arg(a);
    }
    if let Some(dir) = cwd.as_deref() {
        cmd.cwd(dir);
    }
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| TermError::Pty(e.to_string()))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| TermError::Pty(e.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| TermError::Pty(e.to_string()))?;
    let killer = child.clone_killer();

    {
        let closing = closing.clone();
        std::thread::spawn(move || {
            let mut child = child;
            let mut buf = [0u8; 8192];
            loop {
                if closing.load(Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => output(id, buf[..n].to_vec()),
                    Err(_) => break,
                }
            }
            let code = child
                .wait()
                .ok()
                .and_then(|s| i32::try_from(s.exit_code()).ok());
            exit(id, code);
        });
    }

    Ok(Spawned {
        title,
        kind,
        writer,
        master: Some(pair.master),
        killer: Some(killer),
    })
}
