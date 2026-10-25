//! Tauri 命令层：把前端 invoke 桥接到 term-core。

use std::fs::File;
use std::io::Write;
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use term_core::{
    list_ports, list_shells, secrets, BackupStats, GroupRow, ProfileRow, SessionInfo,
    SessionRequest, SettingRow, SftpEntry, SftpRequest, SyncItem,
};

use crate::state::AppState;

type CmdResult<T> = Result<T, String>;

#[derive(Serialize, Clone)]
struct OutputEvent {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct ExitEvent {
    id: String,
    code: Option<i32>,
}

fn make_sinks(app: &AppHandle) -> (term_core::OutputSink, term_core::ExitSink) {
    let handle = app.clone();
    let output: term_core::OutputSink = Arc::new(move |id, data| {
        let _ = handle.emit(
            "session:output",
            OutputEvent {
                id: id.to_string(),
                data: B64.encode(&data),
            },
        );
    });
    let handle = app.clone();
    let exit: term_core::ExitSink = Arc::new(move |id, code| {
        let _ = handle.emit(
            "session:exit",
            ExitEvent {
                id: id.to_string(),
                code,
            },
        );
    });
    (output, exit)
}

fn parse_id(id: &str) -> CmdResult<uuid::Uuid> {
    uuid::Uuid::parse_str(id).map_err(|e| e.to_string())
}

// ---------------- 应用信息 ----------------

#[derive(Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub os: String,
    pub arch: String,
}

#[tauri::command]
pub async fn app_info(app: AppHandle) -> CmdResult<AppInfo> {
    let pkg = app.package_info();
    Ok(AppInfo {
        name: pkg.name.clone(),
        version: pkg.version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

#[tauri::command]
pub async fn default_shell() -> CmdResult<String> {
    Ok(term_core::default_shell())
}

#[tauri::command]
pub async fn serial_list_ports() -> CmdResult<Vec<term_core::PortInfo>> {
    list_ports().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn shells_list() -> CmdResult<Vec<term_core::ShellInfo>> {
    Ok(list_shells())
}

// ---------------- 会话 ----------------

#[tauri::command]
pub async fn session_open(
    app: AppHandle,
    state: State<'_, AppState>,
    req: SessionRequest,
) -> CmdResult<SessionInfo> {
    let (output, exit) = make_sinks(&app);

    // 会话日志：开启 logSessions 设置时，把输出字节同时写入本地日志文件，供回放。
    let do_log = state
        .db
        .lock()
        .unwrap()
        .setting_get("logSessions")
        .ok()
        .flatten()
        .map(|v| v != "0")
        .unwrap_or(false);
    let output: term_core::OutputSink = if do_log {
        let inner = output.clone();
        let handle = app.clone();
        let log_file: Mutex<Option<File>> = Mutex::new(None);
        Arc::new(move |id, data| {
            inner(id, data.clone());
            if let Ok(mut file) = log_file.lock() {
                if file.is_none() { *file = open_session_log(&handle, id).ok(); }
                if let Some(file) = file.as_mut() {
                    let _ = file.write_all(&data);
                    let _ = file.flush();
                }
            }
        })
    } else { output };

    state
        .sessions
        .open(req, output, exit)
        .map_err(|e| e.to_string())
}

/// 在应用数据目录下创建 `logs/<uuid>.log`，返回可写文件句柄。
fn open_session_log(app: &AppHandle, id: uuid::Uuid) -> Result<File, String> {
    let dir = crate::workspace::data_dir(&app)?.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.log"));
    File::create(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_log_read(app: AppHandle, id: String) -> CmdResult<String> {
    let id = parse_id(&id)?;
    let dir = crate::workspace::data_dir(&app)?.join("logs");
    let path = dir.join(format!("{}.log", id));
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}

#[tauri::command]
pub async fn session_write(
    state: State<'_, AppState>,
    id: String,
    data_b64: String,
) -> CmdResult<()> {
    let bytes = B64.decode(data_b64.as_bytes()).map_err(|e| e.to_string())?;
    state
        .sessions
        .write(parse_id(&id)?, &bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> CmdResult<()> {
    state
        .sessions
        .resize(parse_id(&id)?, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_close(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state
        .sessions
        .close(parse_id(&id)?)
        .map_err(|e| e.to_string())
}

// ---------------- SFTP 图形化文件管理（R-01） ----------------

#[tauri::command]
pub async fn sftp_list(req: SftpRequest, path: String) -> CmdResult<Vec<SftpEntry>> {
    req.list(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_mkdir(req: SftpRequest, path: String) -> CmdResult<()> {
    req.mkdir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_remove(req: SftpRequest, path: String, is_dir: bool) -> CmdResult<()> {
    if is_dir {
        req.remove_dir(&path)
    } else {
        req.remove_file(&path)
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_rename(req: SftpRequest, from: String, to: String) -> CmdResult<()> {
    req.rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_download(req: SftpRequest, remote: String, local: String) -> CmdResult<()> {
    req.download(&remote, &local).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_upload(req: SftpRequest, local: String, remote: String) -> CmdResult<()> {
    req.upload(&local, &remote).map_err(|e| e.to_string())
}

// ---------------- 本地文件浏览（SFTP 面板的本地侧栏） ----------------

#[derive(Serialize)]
pub struct LocalEntry {
    name: String,
    is_dir: bool,
    size: u64,
    /// 修改时间（Unix 毫秒）
    mtime: i64,
}

#[tauri::command]
pub async fn local_list(path: String) -> CmdResult<Vec<LocalEntry>> {
    let p = std::path::Path::new(&path);
    let mut entries = Vec::new();
    let mut read = std::fs::read_dir(p).map_err(|e| format!("无法读取目录 {}: {}", path, e))?;
    while let Some(Ok(e)) = read.next() {
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let size = if is_dir { 0 } else { meta.len() };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        entries.push(LocalEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            is_dir,
            size,
            mtime,
        });
    }
    entries.sort_by(|a, b| {
        (b.is_dir, a.name.to_lowercase()).cmp(&(a.is_dir, b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> CmdResult<()> {
    std::fs::create_dir_all(&path).map_err(|e| format!("无法创建目录 {}: {}", path, e))
}

// ---------------- 档案 ----------------

#[tauri::command]
pub async fn profile_list(state: State<'_, AppState>) -> CmdResult<Vec<ProfileRow>> {
    state
        .db
        .lock()
        .unwrap()
        .profile_list()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn profile_save(
    state: State<'_, AppState>,
    profile: ProfileRow,
) -> CmdResult<ProfileRow> {
    state
        .db
        .lock()
        .unwrap()
        .profile_save(profile)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn profile_delete(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state
        .db
        .lock()
        .unwrap()
        .profile_delete(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn groups_list(state: State<'_, AppState>) -> CmdResult<Vec<GroupRow>> {
    state
        .db
        .lock()
        .unwrap()
        .group_list()
        .map_err(|e| e.to_string())
}

// ---------------- 设置 ----------------

#[tauri::command]
pub async fn settings_all(state: State<'_, AppState>) -> CmdResult<Vec<SettingRow>> {
    state
        .db
        .lock()
        .unwrap()
        .settings_all()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn setting_set(app: AppHandle, state: State<'_, AppState>, key: String, value: String) -> CmdResult<()> {
    state.db.lock().unwrap().setting_set(&key, &value).map_err(|e| e.to_string())?;
    let _=app.emit("settings:changed", &key);
    Ok(())
}

// ---------------- 机密（系统密钥环） ----------------

#[tauri::command]
pub async fn secret_set(
    profile_id: String,
    field: String,
    value: Option<String>,
) -> CmdResult<()> {
    let account = secrets::secret_account(&profile_id, &field);
    match value {
        Some(v) if !v.is_empty() => secrets::set_secret(&account, &v),
        _ => secrets::delete_secret(&account),
    }
    .map_err(|e| e.to_string())
}

// ---------------- 同步 ----------------

#[tauri::command]
pub async fn sync_export_dirty(state: State<'_, AppState>) -> CmdResult<Vec<SyncItem>> {
    state
        .db
        .lock()
        .unwrap()
        .sync_export_dirty()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_apply_pull(state: State<'_, AppState>, items: Vec<SyncItem>) -> CmdResult<u32> {
    state
        .db
        .lock()
        .unwrap()
        .sync_apply_pull(&items)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_mark_pushed(state: State<'_, AppState>, items: Vec<SyncItem>) -> CmdResult<()> {
    state
        .db
        .lock()
        .unwrap()
        .sync_mark_pushed(&items)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_last_pull(state: State<'_, AppState>) -> CmdResult<i64> {
    state
        .db
        .lock()
        .unwrap()
        .sync_last_pull()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_set_last_pull(state: State<'_, AppState>, ts: i64) -> CmdResult<()> {
    state
        .db
        .lock()
        .unwrap()
        .sync_set_last_pull(ts)
        .map_err(|e| e.to_string())
}

// ---------------- 本地备份 ----------------

#[tauri::command]
pub async fn backup_export(state: State<'_, AppState>, path: String) -> CmdResult<BackupStats> {
    state
        .db
        .lock()
        .unwrap()
        .backup_export(std::path::Path::new(&path))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn backup_import(
    state: State<'_, AppState>,
    path: String,
    replace: bool,
) -> CmdResult<BackupStats> {
    state
        .db
        .lock()
        .unwrap()
        .backup_import(std::path::Path::new(&path), replace)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn command_check(input: String) -> CmdResult<term_core::CommandCheck> {
    if input.len() > 1024 * 1024 { return Err("一次输入最多支持 1 MiB 文本".into()); }
    Ok(term_core::safety::classify_command(&input))
}

#[cfg(test)]
mod input_safety_tests {
    #[test]
    fn command_check_rejects_oversized_input_and_classifies_without_execution() {
        assert!(super::command_check("x".repeat(1024 * 1024 + 1)).is_err());
        let check = super::command_check("rm -rf /tmp/termone-never-executed".into()).unwrap();
        assert_eq!(check.risk, term_core::RiskLevel::Danger);
    }
}
