#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;

use std::sync::Mutex;

use term_core::{Db, SessionManager};

fn main() {
    let db = match Db::open() {
        Ok(db) => Mutex::new(db),
        Err(e) => {
            eprintln!("无法打开本地数据库: {e}");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .manage(state::AppState {
            sessions: SessionManager::new(),
            db,
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::default_shell,
            commands::serial_list_ports,
            commands::session_open,
            commands::session_write,
            commands::session_resize,
            commands::session_close,
            commands::profile_list,
            commands::profile_save,
            commands::profile_delete,
            commands::settings_all,
            commands::setting_set,
            commands::secret_set,
            commands::sync_export_dirty,
            commands::sync_apply_pull,
            commands::sync_mark_pushed,
            commands::sync_last_pull,
            commands::sync_set_last_pull,
        ])
        .setup(|app| {
            // Windows 隐藏系统标题栏由前端自绘；macOS 使用 Overlay 保留交通灯
            #[cfg(target_os = "windows")]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_decorations(false);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TermOne");
}
