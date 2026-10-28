use crate::state::AppState;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use term_core::{
    monitor::{MonitorConnection, MonitorTarget},
    SshAuth,
};

pub const ID: &str = "com.termone.server-monitor";
#[derive(Default)]
pub struct MonitorRegistry {
    active: Option<(String, MonitorConnection)>,
}
impl MonitorRegistry {
    pub fn stop_all(&mut self) {
        self.active.take();
    }
}
pub fn access(id: &str, source: &str, kind: term_core::plugin::ExtensionKind) -> bool {
    id == ID && source == "builtin" && kind == term_core::plugin::ExtensionKind::App
}
pub fn dispatch(app: &AppHandle, command: &str, args: Value) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let run_id = args["runId"].as_str().ok_or("缺少监控连接标识")?;
    uuid::Uuid::parse_str(run_id).map_err(|_| "监控连接标识无效")?;
    let mut registry = state.monitor.lock().map_err(|e| e.to_string())?;
    if command == "monitor_stop" {
        if registry.active.as_ref().is_some_and(|(id, _)| id == run_id) {
            registry.stop_all();
        }
        return Ok(Value::Null);
    }
    if command == "monitor_start" {
        if app
            .get_webview_window(&crate::applications::label(ID))
            .is_none()
        {
            return Err("监控窗口已关闭".into());
        }
        let interval = args["interval"]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .ok_or("采样间隔无效")?;
        let profiles = state
            .db
            .lock()
            .map_err(|e| e.to_string())?
            .profile_list()
            .map_err(|e| e.to_string())?;
        let profile = profiles
            .iter()
            .find(|p| p.kind == "ssh" && p.id == args["profileId"].as_str().unwrap_or(""))
            .ok_or("SSH 档案不存在")?;
        let config = &profile.config;
        let auth = match config["auth"].as_str() {
            Some("key") => SshAuth::Key {
                identity_file: config["identityFile"]
                    .as_str()
                    .ok_or("缺少私钥路径")?
                    .into(),
            },
            Some("password") => SshAuth::Password,
            _ => SshAuth::Agent,
        };
        let target = MonitorTarget {
            host: config["host"].as_str().ok_or("缺少主机地址")?.into(),
            port: config["port"]
                .as_u64()
                .unwrap_or(22)
                .try_into()
                .map_err(|_| "SSH 端口无效")?,
            user: config["user"].as_str().map(String::from),
            auth,
            proxy_jump: config["proxyJump"].as_str().map(String::from),
        };
        registry.stop_all();
        let connection = MonitorConnection::start(target, interval)?;
        let status = connection.status();
        registry.active = Some((run_id.to_string(), connection));
        return Ok(json!(status));
    }
    let connection = &registry
        .active
        .as_ref()
        .filter(|(id, _)| id == run_id)
        .ok_or("监控已停止或已切换主机")?
        .1;
    match command {
        "monitor_poll" => Ok(json!(connection.status())),
        "monitor_auth" => {
            connection.authenticate(args["secret"].as_str().ok_or("请输入认证信息")?)?;
            Ok(Value::Null)
        }
        _ => Err("未知监控能力".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use term_core::plugin::ExtensionKind;
    #[test]
    fn monitoring_only_accepts_its_official_standalone_application() {
        assert!(access(ID, "builtin", ExtensionKind::App));
        assert!(!access(ID, "local", ExtensionKind::App));
        assert!(!access(ID, "market", ExtensionKind::App));
        assert!(!access(ID, "builtin", ExtensionKind::Plugin));
        assert!(!access("com.termone.sftp", "builtin", ExtensionKind::App));
    }
}
