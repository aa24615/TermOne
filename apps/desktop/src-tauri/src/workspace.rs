use crate::state::AppState;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf> {
    if let Some(dir) = std::env::var_os("TERMONE_DATA_DIR")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
    {
        return Ok(dir);
    }
    app.path().app_data_dir().map_err(err)
}

#[tauri::command]
pub fn group_create(
    state: State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
) -> Result<term_core::GroupRow> {
    let db = state.db.lock().map_err(err)?;
    if let Some(ref id) = parent_id {
        if !db.group_list().map_err(err)?.iter().any(|g| &g.id == id) {
            return Err("父分组不存在".into());
        }
    }
    db.group_create(uuid::Uuid::new_v4().to_string(), name, parent_id, 0)
        .map_err(err)
}
#[tauri::command]
pub fn group_rename(state: State<'_, AppState>, id: String, name: String) -> Result<()> {
    state
        .db
        .lock()
        .map_err(err)?
        .group_rename(&id, name)
        .map_err(err)
}
#[tauri::command]
pub fn group_set_collapsed(state: State<'_, AppState>, id: String, collapsed: bool) -> Result<()> {
    state
        .db
        .lock()
        .map_err(err)?
        .group_set_collapsed(&id, collapsed)
        .map_err(err)
}
#[tauri::command]
pub fn group_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.db.lock().map_err(err)?.group_delete(&id).map_err(err)
}
#[tauri::command]
pub fn group_move(state: State<'_, AppState>, id: String, parent_id: Option<String>) -> Result<()> {
    let db = state.db.lock().map_err(err)?;
    let groups = db.group_list().map_err(err)?;
    let group = groups.iter().find(|g| g.id == id).ok_or("分组不存在")?;
    let mut parent = parent_id.clone();
    let mut visited = std::collections::HashSet::new();
    while let Some(ref p) = parent {
        if p == &id || !visited.insert(p.clone()) {
            return Err("分组不能移入自身或子分组".into());
        }
        parent = groups
            .iter()
            .find(|g| &g.id == p)
            .ok_or("父分组不存在")?
            .parent_id
            .clone();
    }
    db.group_create(
        group.id.clone(),
        group.name.clone(),
        parent_id,
        group.sort_order,
    )
    .map_err(err)?;
    Ok(())
}
#[tauri::command]
pub fn profile_recent(state: State<'_, AppState>) -> Result<Vec<term_core::ProfileRow>> {
    state
        .db
        .lock()
        .map_err(err)?
        .profile_list_recent(10)
        .map_err(err)
}
#[tauri::command]
pub fn profile_touch(state: State<'_, AppState>, id: String) -> Result<()> {
    state
        .db
        .lock()
        .map_err(err)?
        .profile_touch(&id)
        .map_err(err)
}
#[tauri::command]
pub fn sync_requeue_all(state: State<'_, AppState>) -> Result<()> {
    state
        .db
        .lock()
        .map_err(err)?
        .sync_requeue_all()
        .map_err(err)
}

#[tauri::command]
pub fn quake_set(app: AppHandle, shortcut: Option<String>) -> Result<()> {
    // Local plugin approval is checked before either registering or removing the shortcut.
    let plugins = crate::plugins::plugin_list(app.clone())?;
    if shortcut.is_some()
        && !plugins
            .iter()
            .any(|p| p.id == "com.termone.quake" && p.enabled && p.source == "builtin")
    {
        return Err("请先启用官方全局热键插件".into());
    }
    app.global_shortcut().unregister_all().map_err(err)?;
    if let Some(shortcut) = shortcut {
        app.global_shortcut()
            .on_shortcut(shortcut.as_str(), |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    if let Some(win) = app.get_webview_window("main") {
                        if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
                            let _ = win.hide();
                        } else {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                }
            })
            .map_err(err)?;
    }
    Ok(())
}
