#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod applications;
mod commands;
mod imports;
mod plugins;
mod state;
mod workspace;

use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use term_core::{Db, SessionManager};

fn main() {
    let db = match Db::open() {
        Ok(db) => {
            // 初次启动默认注入系统自带 Shell 档案（CMD / Git Bash / PowerShell 等），
            // 失败也不影响主流程。
            let _ = db.seed_system_profiles();
            Mutex::new(db)
        }
        Err(e) => {
            eprintln!("无法打开本地数据库: {e}");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(state::AppState {
            sessions: SessionManager::new(),
            db,
        })
        .invoke_handler(tauri::generate_handler![
            applications::application_open,
            commands::app_info,
            commands::command_check,
            commands::default_shell,
            commands::serial_list_ports,
            commands::shells_list,
            commands::session_open,
            commands::session_write,
            commands::session_resize,
            commands::session_close,
            commands::session_log_read,
            commands::sftp_list,
            commands::sftp_mkdir,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_download,
            commands::sftp_upload,
            commands::local_list,
            commands::local_mkdir,
            commands::profile_list,
            commands::profile_save,
            commands::profile_delete,
            imports::ssh_import_read,
            imports::ssh_import_apply,
            commands::groups_list,
            commands::settings_all,
            commands::setting_set,
            commands::secret_set,
            commands::sync_export_dirty,
            commands::sync_apply_pull,
            commands::sync_mark_pushed,
            commands::sync_last_pull,
            commands::sync_set_last_pull,
            commands::backup_export,
            commands::backup_import,
            plugins::plugin_list,
            plugins::plugin_install,
            plugins::plugin_set_enabled,
            plugins::plugin_uninstall,
            plugins::plugin_read_package,
            plugins::plugin_load,
            plugins::plugin_audit,
            plugins::plugin_authorize,
            plugins::plugin_call,
            plugins::plugin_storage,
            plugins::plugin_add_domain,
            plugins::plugin_grant_path,
            plugins::plugin_denied,
            workspace::group_create,
            workspace::group_rename,
            workspace::group_set_collapsed,
            workspace::group_delete,
            workspace::group_move,
            workspace::profile_recent,
            workspace::profile_touch,
            workspace::sync_requeue_all,
            workspace::quake_set,
        ])
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<state::AppState>().sessions.close_all();
                let _ = window.app_handle().global_shortcut().unregister_all();
            }
        })
        .setup(|_app| {
            // Windows 隐藏系统标题栏由前端自绘；macOS 使用 Overlay 保留交通灯
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            if let Some(win) = _app.get_webview_window("main") {
                let _ = win.set_decorations(false);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TermOne");
}
