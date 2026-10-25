//! Standalone tool windows. No main-window terminal is created or shared here.
use crate::plugins;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use term_core::plugin::ExtensionKind;
type Result<T> = std::result::Result<T, String>;
static OPEN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub fn label(id: &str) -> String {
    format!("application-{}", URL_SAFE_NO_PAD.encode(id))
}
pub fn close(app: &AppHandle, id: &str) {
    if let Some(window) = app.get_webview_window(&label(id)) {
        let _ = window.destroy();
    }
}
#[tauri::command]
pub async fn application_open(app: AppHandle, id: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = OPEN_LOCK.lock().map_err(|e| e.to_string())?;
        let value = plugins::approved(&app, &id, true)?;
        let manifest = plugins::parse(&value["manifest"])?;
        if manifest.kind != ExtensionKind::App {
            return Err("插件附加到主窗口，请从插件入口打开".into());
        }
        let window_label = label(&id);
        if let Some(window) = app.get_webview_window(&window_label) {
            window.show().map_err(|e| e.to_string())?;
            window.unminimize().map_err(|e| e.to_string())?;
            return window.set_focus().map_err(|e| e.to_string());
        }
        WebviewWindowBuilder::new(
            &app,
            &window_label,
            WebviewUrl::App(format!("index.html?application={id}").into()),
        )
        .title(format!("{} · TermOne", manifest.name))
        .inner_size(1100.0, 760.0)
        .min_inner_size(680.0, 480.0)
        .decorations(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    #[test]
    fn application_labels_are_unique_for_ids_with_dots_and_hyphens() {
        assert_ne!(
            super::label("org.example-a.b"),
            super::label("org.example.a-b")
        );
        assert!(super::label("com.termone.sftp")
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
