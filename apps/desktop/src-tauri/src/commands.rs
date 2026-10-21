//! Tauri 命令层：把前端 invoke 桥接到 term-core。

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use term_core::{
    list_ports, secrets, ProfileRow, SessionInfo, SessionRequest, SettingRow, SyncItem,
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

// ---------------- 会话 ----------------

#[tauri::command]
pub async fn session_open(
    app: AppHandle,
    state: State<'_, AppState>,
    req: SessionRequest,
) -> CmdResult<SessionInfo> {
    let (output, exit) = make_sinks(&app);
    state
        .sessions
        .open(req, output, exit)
        .map_err(|e| e.to_string())
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
pub async fn setting_set(state: State<'_, AppState>, key: String, value: String) -> CmdResult<()> {
    state
        .db
        .lock()
        .unwrap()
        .setting_set(&key, &value)
        .map_err(|e| e.to_string())
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
