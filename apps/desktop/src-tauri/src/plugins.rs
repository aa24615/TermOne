//! Plugin files are local authority. Synced metadata never grants execution permission.
use crate::state::AppState;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use term_core::{
    plugin::{safe_package_path, validate_tpk},
    HostApiVersion, PluginManifest, PluginPermission, PluginRow, SftpAuth, SftpRequest, SnippetRow,
};

type Result<T> = std::result::Result<T, String>;
const CATALOG: &str = include_str!("../../src/plugin/catalog.json");
const MAX_BYTES: usize = 16 * 1024 * 1024;
static AUDIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static INFLIGHT: std::sync::Mutex<BTreeMap<String, usize>> = std::sync::Mutex::new(BTreeMap::new());
struct CallGuard(String);
impl CallGuard {
    fn acquire(id: &str) -> Result<Self> {
        let mut calls = INFLIGHT.lock().map_err(err)?;
        if calls.get(id).copied().unwrap_or(0) >= 4 || calls.values().sum::<usize>() >= 32 {
            return Err("扩展并发操作超限，请稍后重试".into());
        }
        *calls.entry(id.to_owned()).or_default() += 1;
        Ok(Self(id.to_owned()))
    }
}
impl Drop for CallGuard {
    fn drop(&mut self) {
        if let Ok(mut calls) = INFLIGHT.lock() {
            if let Some(count) = calls.get_mut(&self.0) {
                *count -= 1;
                if *count == 0 {
                    calls.remove(&self.0);
                }
            }
        }
    }
}
const IPC: &[&str] = &[
    "monitor_start", "monitor_poll", "monitor_auth", "monitor_stop",
    "profile_refs",
    "sftp_list",
    "sftp_mkdir",
    "sftp_remove",
    "sftp_rename",
    "sftp_download",
    "sftp_upload",
    "local_list",
    "local_mkdir",
    "session_log_read",
    "session_log_list",
    "snippet_list",
    "snippet_save",
    "snippet_delete",
    "snippet_group_list",
    "snippet_group_save",
    "snippet_group_delete",
    "theme_install",
    "history_add",
    "history_recent",
    "history_clear",
];

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn root(app: &AppHandle) -> Result<PathBuf> {
    Ok(crate::workspace::data_dir(app)?.join("plugins"))
}
fn valid_id(id: &str) -> Result<()> {
    if id.len() > 200
        || !id.contains('.')
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
        || id.split('.').any(|p| p.is_empty())
    {
        return Err("扩展 ID 非法".into());
    }
    Ok(())
}
fn path(app: &AppHandle, id: &str) -> Result<PathBuf> {
    valid_id(id)?;
    Ok(root(app)?.join(id))
}
pub(crate) fn parse(value: &Value) -> Result<PluginManifest> {
    let m = PluginManifest::from_json(&serde_json::to_vec(value).map_err(err)?).map_err(err)?;
    if !HostApiVersion::new(1, 1, 0).satisfies(&m.host_api) {
        return Err("扩展需要更高版本的 Host API".into());
    }
    for p in &m.permissions {
        if let PluginPermission::Ipc { command } = p {
            if !IPC.contains(&command.as_str()) {
                return Err(format!("不支持的扩展 IPC 权限: {command}"));
            }
        }
    }
    Ok(m)
}
fn read_json(p: &Path) -> Result<Value> {
    serde_json::from_slice(&fs::read(p).map_err(err)?).map_err(err)
}
fn write_json(p: &Path, v: &Value) -> Result<()> {
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let temp = p.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temp, serde_json::to_vec(v).map_err(err)?).map_err(err)?;
    fs::rename(temp, p).map_err(err)
}
pub(crate) fn approved(app: &AppHandle, id: &str, enabled: bool) -> Result<Value> {
    let local = read_json(&path(app, id)?.join("approval.json"))?;
    let manifest = parse(&local["manifest"])?;
    if enabled && !can_run(manifest.kind, local["enabled"] == true) {
        return Err("扩展未启用".into());
    }
    Ok(local)
}
fn can_run(kind: term_core::plugin::ExtensionKind, enabled: bool) -> bool {
    kind == term_core::plugin::ExtensionKind::App || enabled
}
fn audit(app: &AppHandle, id: &str, action: &str, allowed: bool) {
    let Ok(_guard) = AUDIT_LOCK.lock() else {
        return;
    };
    let action: String = action.chars().take(200).collect();
    // Values/arguments are deliberately excluded: they may contain terminal text or keys.
    let event = json!({"at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,"pluginId":id,"action":action,"allowed":allowed});
    if let Ok(dir) = root(app) {
        let p = dir.join("audit.jsonl");
        let _ = fs::create_dir_all(&dir);
        if fs::metadata(&p).map(|m| m.len() > 512_000).unwrap_or(false) {
            let _ = fs::rename(&p, dir.join("audit.previous.jsonl"));
        }
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(p) {
            let _ = writeln!(f, "{event}");
        }
    }
}

fn migrate_builtin(value: &mut Value) -> bool {
    if value["source"] != "builtin" {
        return false;
    }
    let catalog: Vec<Value> = serde_json::from_str(CATALOG).unwrap_or_default();
    if let Some(current) = catalog.iter().find(|m| m["id"] == value["manifest"]["id"]) {
        let mut changed = false;
        for key in ["kind", "hostApi"] {
            if value["manifest"][key] != current[key] {
                value["manifest"][key] = current[key].clone();
                changed = true;
            }
        }
        return changed;
    }
    false
}
fn changed(app: &AppHandle, id: &str) {
    let _ = app.emit("extensions:changed", json!({"id":id}));
}
fn context_allowed(kind: term_core::plugin::ExtensionKind, window: &str, id: &str) -> bool {
    match kind {
        term_core::plugin::ExtensionKind::Plugin => window == "main",
        term_core::plugin::ExtensionKind::App => window == crate::applications::label(id),
    }
}
fn ensure_context(app: &AppHandle, window: &WebviewWindow, id: &str) -> Result<()> {
    let value = approved(app, id, true)?;
    let manifest = parse(&value["manifest"])?;
    let allowed = context_allowed(manifest.kind, window.label(), id);
    if !allowed {
        audit(app, id, "window-context-denied", false);
        return Err("扩展只能在自己的运行窗口中调用能力".into());
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub id: String,
    pub manifest: Value,
    pub enabled: bool,
    pub source: String,
}

#[tauri::command]
pub fn plugin_list(app: AppHandle) -> Result<Vec<Installed>> {
    let dir = root(&app)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for entry in fs::read_dir(dir).map_err(err)? {
        let p = entry.map_err(err)?.path();
        if p.is_dir()
            && !p
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .starts_with('.')
        {
            if let Ok(mut v) = read_json(&p.join("approval.json")) {
                if migrate_builtin(&mut v) {
                    write_json(&p.join("approval.json"), &v)?;
                    let state = app.state::<AppState>();
                    let db = state.db.lock().map_err(err)?;
                    if let Some(mut row) = db
                        .plugin_get(v["manifest"]["id"].as_str().unwrap_or(""))
                        .map_err(err)?
                    {
                        row.manifest = v["manifest"].to_string();
                        db.plugin_save(row).map_err(err)?;
                    }
                }
                if let Ok(m) = parse(&v["manifest"]) {
                    out.push(Installed {
                        id: m.id,
                        manifest: v["manifest"].clone(),
                        enabled: can_run(m.kind, v["enabled"] == true),
                        source: v["source"].as_str().unwrap_or("local").into(),
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
pub fn plugin_install(
    app: AppHandle,
    state: State<'_, AppState>,
    manifest: Value,
    files: BTreeMap<String, String>,
    source: String,
    dev_path: Option<String>,
) -> Result<()> {
    let (manifest, files) = if source == "builtin" {
        let catalog: Vec<Value> = serde_json::from_str(CATALOG).map_err(err)?;
        let entry = catalog
            .into_iter()
            .find(|m| m["id"] == manifest["id"])
            .ok_or("未知官方扩展")?;
        (entry, BTreeMap::new())
    } else {
        (manifest, files)
    };
    if !["builtin", "local", "market", "dev"].contains(&source.as_str()) {
        return Err("扩展来源非法".into());
    }
    let m = parse(&manifest)?;
    crate::applications::close(&app, &m.id);
    let mut decoded = BTreeMap::new();
    let mut size = 0;
    if source != "builtin" {
        if files.len() > 256 {
            return Err("扩展文件过多".into());
        }
        for (name, data) in files {
            if !safe_package_path(&name) || name == "approval.json" || name == ".dev-path" {
                return Err("不安全的扩展路径".into());
            }
            let bytes = B64.decode(data).map_err(err)?;
            size += bytes.len();
            if size > MAX_BYTES {
                return Err("扩展解压后不能超过 16 MiB".into());
            }
            decoded.insert(name, bytes);
        }
        validate_tpk(
            &serde_json::to_vec(&manifest).map_err(err)?,
            &decoded.keys().cloned().collect::<Vec<_>>(),
        )
        .map_err(err)?;
    }
    let target = path(&app, &m.id)?;
    fs::create_dir_all(root(&app)?).map_err(err)?;
    let stage = root(&app)?.join(format!(".stage-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&stage).map_err(err)?;
    let result = (|| {
        for (name, bytes) in decoded {
            let p = stage.join(name);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).map_err(err)?;
            }
            fs::write(p, bytes).map_err(err)?;
        }
        write_json(
            &stage.join("approval.json"),
            &json!({"manifest":manifest,"enabled":m.kind == term_core::plugin::ExtensionKind::App,"source":source}),
        )?;
        if source == "dev" {
            let p = PathBuf::from(dev_path.ok_or("开发目录未选择")?)
                .canonicalize()
                .map_err(err)?;
            write_json(&stage.join("dev.json"), &json!(p))?;
        }
        let old = root(&app)?.join(format!(".old-{}", uuid::Uuid::new_v4()));
        if target.exists() {
            fs::rename(&target, &old).map_err(err)?;
        }
        if let Err(e) = fs::rename(&stage, &target) {
            let _ = fs::rename(&old, &target);
            return Err(err(e));
        }
        let saved = state
            .db
            .lock()
            .map_err(err)?
            .plugin_save(PluginRow {
                id: m.id.clone(),
                name: m.name,
                version: m.version,
                state: "installed".into(),
                source,
                manifest: manifest.to_string(),
                installed_at: 0,
                updated_at: 0,
                created_at: 0,
                deleted: false,
                dirty: true,
            })
            .map_err(err);
        if let Err(e) = saved {
            let _ = fs::remove_dir_all(&target);
            if old.exists() {
                let _ = fs::rename(&old, &target);
            }
            return Err(e);
        }
        let _ = fs::remove_dir_all(old);
        audit(&app, &m.id, "install", true);
        changed(&app, &m.id);
        Ok(())
    })();
    if stage.exists() {
        let _ = fs::remove_dir_all(stage);
    }
    result
}

#[tauri::command]
pub fn plugin_set_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<()> {
    let mut v = approved(&app, &id, false)?;
    if parse(&v["manifest"])?.kind == term_core::plugin::ExtensionKind::App {
        return Err("应用安装后即可使用，无需启用或停用".into());
    }
    v["enabled"] = json!(enabled);
    if !enabled {
        crate::applications::close(&app, &id);
        v["paths"] = json!([]);
    }
    write_json(&path(&app, &id)?.join("approval.json"), &v)?;
    if id == "com.termone.quake" && !enabled {
        let _ = crate::workspace::quake_set(app.clone(), None);
    }
    state
        .db
        .lock()
        .map_err(err)?
        .plugin_set_state(&id, if enabled { "enabled" } else { "disabled" })
        .map_err(err)?;
    audit(&app, &id, if enabled { "enable" } else { "disable" }, true);
    changed(&app, &id);
    Ok(())
}

#[tauri::command]
pub fn plugin_uninstall(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    approved(&app, &id, false)?;
    crate::applications::close(&app, &id);
    if id == "com.termone.quake" {
        let _ = crate::workspace::quake_set(app.clone(), None);
    }
    fs::remove_dir_all(path(&app, &id)?).map_err(err)?;
    let data = crate::workspace::data_dir(&app)?
        .join("plugin-data")
        .join(&id);
    if data.exists() {
        fs::remove_dir_all(data).map_err(err)?;
    }
    state
        .db
        .lock()
        .map_err(err)?
        .plugin_delete(&id)
        .map_err(err)?;
    audit(&app, &id, "uninstall", true);
    changed(&app, &id);
    Ok(())
}

fn walk(
    dir: &Path,
    prefix: &str,
    files: &mut BTreeMap<String, String>,
    size: &mut u64,
) -> Result<()> {
    if prefix.split('/').count() > 32 {
        return Err("扩展目录层级过深".into());
    }
    for item in fs::read_dir(dir).map_err(err)? {
        let item = item.map_err(err)?;
        let meta = item.path().symlink_metadata().map_err(err)?;
        let name = format!("{}{}", prefix, item.file_name().to_string_lossy());
        if !safe_package_path(&name) || meta.file_type().is_symlink() {
            return Err("扩展目录含不安全路径或符号链接".into());
        }
        if meta.is_dir() {
            walk(&item.path(), &(name + "/"), files, size)?;
        } else {
            *size += meta.len();
            if *size > MAX_BYTES as u64 || files.len() >= 256 {
                return Err("扩展目录过大".into());
            }
            files.insert(name, B64.encode(fs::read(item.path()).map_err(err)?));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installed_apps_ignore_legacy_enable_flags_but_plugins_still_require_enable() {
        use term_core::plugin::ExtensionKind::{App, Plugin};
        assert!(can_run(App, false));
        assert!(can_run(App, true));
        assert!(!can_run(Plugin, false));
        assert!(can_run(Plugin, true));
    }
    #[test]
    fn legacy_builtin_application_migrates_without_changing_approval() {
        let mut manifest: Value = serde_json::from_str::<Vec<Value>>(CATALOG)
            .unwrap()
            .remove(0);
        manifest.as_object_mut().unwrap().remove("kind");
        manifest["hostApi"]["minor"] = json!(0);
        let permissions = manifest["permissions"].clone();
        let mut approval =
            json!({"manifest":manifest,"source":"builtin","enabled":true,"paths":["/tmp/example"]});
        assert!(migrate_builtin(&mut approval));
        assert_eq!(approval["manifest"]["kind"], "app");
        assert_eq!(approval["manifest"]["permissions"], permissions);
        assert_eq!(approval["enabled"], true);
        assert_eq!(approval["paths"], json!(["/tmp/example"]));
        assert!(!migrate_builtin(&mut approval));
    }
    #[test]
    fn imported_packages_cannot_gain_builtin_application_classification() {
        let mut approval =
            json!({"manifest":{"id":"com.termone.sftp"},"source":"local","enabled":true});
        assert!(!migrate_builtin(&mut approval));
        assert!(approval["manifest"]["kind"].is_null());
    }
    #[test]
    fn capabilities_are_bound_to_extension_kind_and_own_window() {
        use term_core::plugin::ExtensionKind::{App, Plugin};
        let id = "com.termone.sftp";
        assert!(context_allowed(App, &crate::applications::label(id), id));
        assert!(!context_allowed(App, "main", id));
        assert!(!context_allowed(
            App,
            &crate::applications::label("com.termone.ai-assist"),
            id
        ));
        assert!(context_allowed(Plugin, "main", "org.example.plugin"));
        assert!(!context_allowed(
            Plugin,
            &crate::applications::label(id),
            "org.example.plugin"
        ));
    }
    #[test]
    fn plugin_native_calls_are_bounded_and_slots_are_released() {
        let id = "org.example.concurrent-test";
        let mut guards: Vec<_> = (0..4).map(|_| CallGuard::acquire(id).unwrap()).collect();
        assert!(CallGuard::acquire(id).is_err());
        guards.pop();
        assert!(CallGuard::acquire(id).is_ok());
        drop(guards);
        assert!(!INFLIGHT.lock().unwrap().contains_key(id));
    }
    #[test]
    fn command_history_is_only_accessible_to_its_bundled_plugin() {
        assert!(history_access("com.termone.command-history", "builtin"));
        assert!(!history_access("com.termone.command-history", "local"));
        assert!(!history_access("com.termone.command-history", "market"));
        assert!(!history_access("com.termone.sftp", "builtin"));
    }
    #[test]
    fn every_bundled_manifest_is_valid_and_does_not_request_secrets() {
        let catalog: Vec<Value> = serde_json::from_str(CATALOG).unwrap();
        assert_eq!(catalog.len(), 11);
        for value in catalog {
            let m = parse(&value).unwrap();
            assert!(!m
                .permissions
                .iter()
                .any(|p| matches!(p,PluginPermission::Ipc{command} if command.contains("secret"))));
        }
    }
    #[test]
    fn manifest_cannot_authorize_arbitrary_native_commands() {
        let mut value: Value = serde_json::from_str::<Vec<Value>>(CATALOG)
            .unwrap()
            .remove(0);
        value["permissions"] = json!([{"type":"ipc","command":"backup_export"}]);
        assert!(parse(&value).is_err());
        value["permissions"] = json!([{"type":"ipc","command":"secret_set"}]);
        assert!(parse(&value).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn directory_import_never_follows_symlinks() {
        let dir =
            std::env::temp_dir().join(format!("termone-import-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", dir.join("stolen.txt")).unwrap();
        assert!(walk(&dir, "", &mut BTreeMap::new(), &mut 0).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
#[tauri::command]
pub fn plugin_read_package(path: String) -> Result<Value> {
    let p = PathBuf::from(path);
    let meta = fs::metadata(&p).map_err(err)?;
    if meta.is_dir() {
        let mut files = BTreeMap::new();
        walk(&p, "", &mut files, &mut 0)?;
        Ok(json!({"files":files}))
    } else {
        if meta.len() > 4 * 1024 * 1024 {
            return Err("压缩包不能超过 4 MiB".into());
        }
        Ok(json!({"archive":B64.encode(fs::read(p).map_err(err)?)}))
    }
}
#[tauri::command]
pub fn plugin_load(app: AppHandle, window: WebviewWindow, id: String) -> Result<Value> {
    ensure_context(&app, &window, &id)?;
    let v = approved(&app, &id, true)?;
    let m = parse(&v["manifest"])?;
    if v["source"] == "builtin" {
        return Ok(json!({"code":"","manifest":v["manifest"]}));
    }
    let dir = if v["source"] == "dev" {
        PathBuf::from(
            read_json(&path(&app, &id)?.join("dev.json"))?
                .as_str()
                .ok_or("开发目录损坏")?,
        )
    } else {
        path(&app, &id)?
    };
    let mut files = BTreeMap::new();
    walk(&dir, "", &mut files, &mut 0)?;
    // A changed manifest requires another install/permission approval; hot reload cannot escalate.
    if v["source"] == "dev" {
        let raw = files.get("termone.plugin.json").ok_or("缺少扩展清单")?;
        let current: Value = serde_json::from_slice(&B64.decode(raw).map_err(err)?).map_err(err)?;
        if current != v["manifest"] {
            return Err("开发扩展权限或清单已改变，请重新导入并确认".into());
        }
    }
    let code = String::from_utf8(
        B64.decode(files.get(&m.entry).ok_or("入口文件缺失")?)
            .map_err(err)?,
    )
    .map_err(err)?;
    Ok(json!({"code":code,"files":files,"manifest":v["manifest"]}))
}

#[tauri::command]
pub fn plugin_audit(app: AppHandle) -> Result<Vec<Value>> {
    let text = fs::read_to_string(root(&app)?.join("audit.jsonl")).unwrap_or_default();
    Ok(text
        .lines()
        .rev()
        .take(500)
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect())
}
#[tauri::command]
pub fn plugin_authorize(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    permission: PluginPermission,
    action: String,
) -> Result<()> {
    ensure_context(&app, &window, &id)?;
    let v = approved(&app, &id, true)?;
    let m = parse(&v["manifest"])?;
    let allowed = m.permissions.contains(&permission);
    audit(&app, &id, &action, allowed);
    if allowed {
        Ok(())
    } else {
        Err(format!("扩展未获授权: {action}"))
    }
}

#[tauri::command]
pub async fn plugin_call(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    command: String,
    args: Value,
) -> Result<Value> {
    ensure_context(&app, &window, &id)?;
    let v = approved(&app, &id, true)?;
    let m = parse(&v["manifest"])?;
    let allowed = IPC.contains(&command.as_str()) && m.allows_ipc(&command)
        && (!command.starts_with("monitor_") || crate::monitor::access(&id, v["source"].as_str().unwrap_or(""), m.kind))
        && (!command.starts_with("history_") || history_access(&id, v["source"].as_str().unwrap_or("")));
    audit(&app, &id, &command, allowed);
    if !allowed {
        return Err(format!("扩展无权调用: {command}"));
    }
    let guard = CallGuard::acquire(&id).map_err(|e| {
        audit(&app, &id, "concurrency-denied", false);
        e
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        dispatch(&app, &id, &command, args)
    })
    .await
    .map_err(err)?
}

fn field<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str().ok_or_else(|| format!("参数缺失: {k}"))
}

fn protected_path(app: &AppHandle, path: &Path) -> Result<bool> {
    let home = app.path().home_dir().map_err(err)?;
    let mut protected = vec![
        home.join(".ssh"),
        home.join(".gnupg"),
        home.join("Library/Keychains"),
        home.join("Library/WebKit"),
        home.join(".local/share/keyrings"),
        home.join(".config/kwalletd"),
        home.join("AppData/Local/Microsoft/Credentials"),
        home.join("AppData/Roaming/Microsoft/Credentials"),
        home.join("AppData/Local/Microsoft/Vault"),
        crate::workspace::data_dir(app)?,
        term_core::storage::default_db_path()
            .parent()
            .ok_or("数据库路径无效")?
            .to_path_buf(),
    ];
    let profiles = app
        .state::<AppState>()
        .db
        .lock()
        .map_err(err)?
        .profile_list()
        .map_err(err)?;
    for profile in profiles {
        if let Some(identity) = profile.config["identityFile"].as_str() {
            let p = if let Some(tail) = identity.strip_prefix("~/") {
                home.join(tail)
            } else {
                PathBuf::from(identity)
            };
            if let Ok(p) = p.canonicalize() {
                protected.push(p);
            }
        }
    }
    Ok(protected
        .into_iter()
        .any(|p| path.starts_with(p.canonicalize().unwrap_or(p))))
}
fn canonical_path(raw: &str, write: bool) -> Result<PathBuf> {
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("本地路径须为绝对路径".into());
    }
    if path.exists() {
        path.canonicalize().map_err(err)
    } else if write {
        Ok(path
            .parent()
            .ok_or("无效路径")?
            .canonicalize()
            .map_err(err)?
            .join(path.file_name().ok_or("无效文件名")?))
    } else {
        Err("本地路径不存在".into())
    }
}
fn granted_path(app: &AppHandle, id: &str, raw: &str, write: bool) -> Result<PathBuf> {
    let path = canonical_path(raw, write)?;
    let local = approved(app, id, true)?;
    let allowed = local["paths"]
        .as_array()
        .map(|paths| {
            paths.iter().filter_map(|p| p.as_str()).any(|p| {
                let grant = PathBuf::from(p);
                if grant.is_dir() {
                    path.starts_with(&grant)
                } else {
                    path == grant
                }
            })
        })
        .unwrap_or(false)
        && !protected_path(app, &path)?;
    if !allowed {
        audit(app, id, "filesystem-denied", false);
        return Err("路径未授权或属于密钥 / 应用私有目录，请重新选择目录".into());
    }
    Ok(path)
}
#[tauri::command]
pub fn plugin_grant_path(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    path: String,
) -> Result<()> {
    ensure_context(&app, &window, &id)?;
    let mut local = approved(&app, &id, true)?;
    let manifest = parse(&local["manifest"])?;
    if !manifest.permissions.contains(&PluginPermission::DialogOpen) {
        return Err("扩展没有文件选择权限".into());
    }
    let p = canonical_path(&path, false)?;
    if protected_path(&app, &p)? {
        audit(&app, &id, "filesystem-denied", false);
        return Err("密钥和应用私有目录不能授权给扩展".into());
    }
    let mut paths: Vec<String> = serde_json::from_value(local["paths"].clone()).unwrap_or_default();
    let text = p.to_string_lossy().into_owned();
    if !paths.contains(&text) {
        paths.push(text);
    }
    if paths.len() > 8 {
        paths.remove(0);
    }
    local["paths"] = json!(paths);
    write_json(
        &crate::plugins::path(&app, &id)?.join("approval.json"),
        &local,
    )?;
    audit(&app, &id, "filesystem-grant", true);
    Ok(())
}
#[tauri::command]
pub fn plugin_denied(app: AppHandle, id: String, action: String) -> Result<()> {
    approved(&app, &id, false)?;
    audit(&app, &id, &action, false);
    Ok(())
}
fn history_access(id: &str, source: &str) -> bool {
    id == "com.termone.command-history" && source == "builtin"
}
fn dispatch(app: &AppHandle, id: &str, cmd: &str, args: Value) -> Result<Value> {
    if cmd.starts_with("monitor_") {
        let approval = approved(app, id, true)?;
        let manifest = parse(&approval["manifest"])?;
        if !crate::monitor::access(id, approval["source"].as_str().unwrap_or(""), manifest.kind) { return Err("监控能力仅对内置服务器监控应用开放".into()); }
        return crate::monitor::dispatch(app, cmd, args);
    }
    let state = app.state::<AppState>();
    if cmd.starts_with("history_") {
        let approval = approved(app, id, true)?;
        if !history_access(id, approval["source"].as_str().unwrap_or("")) {
            return Err("命令历史仅对内置历史命令插件开放".into());
        }
        let db = state.db.lock().map_err(err)?;
        return match cmd {
            "history_add" => {
                let session = uuid::Uuid::parse_str(field(&args, "sessionId")?).map_err(err)?;
                if !state.sessions.exists(session) { return Err("会话已结束".into()); }
                db.history_add(field(&args, "command")?, args["hostId"].as_str()).map_err(err)?;
                Ok(Value::Null)
            }
            "history_recent" => Ok(json!(db.history_recent(args["query"].as_str().unwrap_or(""), 500).map_err(err)?)),
            "history_clear" => { db.history_clear().map_err(err)?; Ok(Value::Null) }
            _ => Err("未知历史命令能力".into()),
        };
    }
    if cmd == "profile_refs" {
        let rows = state.db.lock().map_err(err)?.profile_list().map_err(err)?;
        return Ok(json!(rows
            .into_iter()
            .filter(|p| p.kind == "ssh")
            .map(|p| json!({"id":p.id,"name":p.name}))
            .collect::<Vec<_>>()));
    }
    if cmd.starts_with("snippet_") {
        let db = state.db.lock().map_err(err)?;
        return match cmd {
            "snippet_list" => Ok(json!(db.snippet_list().map_err(err)?)),
            "snippet_group_list" => Ok(json!(db.snippet_groups().map_err(err)?)),
            "snippet_group_save" => Ok(json!(db.snippet_group_save(field(&args, "id")?, field(&args, "name")?).map_err(err)?)),
            "snippet_group_delete" => Ok(json!(db.snippet_group_delete(field(&args, "id")?).map_err(err)?)),
            "snippet_save" => {
                let s: SnippetRow = serde_json::from_value(args["snippet"].clone()).map_err(err)?;
                Ok(json!(db.snippet_save(s).map_err(err)?))
            }
            "snippet_delete" => {
                db.snippet_delete(field(&args, "id")?).map_err(err)?;
                Ok(Value::Null)
            }
            _ => Err("未知命令".into()),
        };
    }
    if cmd.starts_with("session_log_") {
        let dir = crate::workspace::data_dir(app)?.join("logs");
        if cmd == "session_log_list" {
            let mut logs = vec![];
            if dir.exists() {
                for e in fs::read_dir(dir).map_err(err)? {
                    let p = e.map_err(err)?.path();
                    if p.extension().and_then(|s| s.to_str()) == Some("log") {
                        let meta = fs::metadata(&p).map_err(err)?;
                        logs.push(json!({"id":p.file_stem().unwrap_or_default().to_string_lossy(),"size":meta.len(),"modified":meta.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_millis() as u64).unwrap_or(0)}));
                    }
                }
            }
            logs.sort_by_key(|v| std::cmp::Reverse(v["modified"].as_u64().unwrap_or(0)));
            logs.truncate(500);
            return Ok(json!(logs));
        }
        let id = uuid::Uuid::parse_str(field(&args, "id")?).map_err(err)?;
        let p = dir.join(format!("{id}.log"));
        if fs::metadata(&p).map_err(err)?.len() > 8 * 1024 * 1024 {
            return Err("日志超过 8 MiB，请直接打开日志目录查看".into());
        }
        return Ok(json!(String::from_utf8_lossy(&fs::read(p).map_err(err)?)));
    }
    if cmd == "local_list" {
        let directory = granted_path(app, id, field(&args, "path")?, false)?;
        let mut rows = vec![];
        for e in fs::read_dir(directory).map_err(err)? {
            let e = e.map_err(err)?;
            let m = e.metadata().map_err(err)?;
            rows.push(
                json!({"name":e.file_name().to_string_lossy(),"isDir":m.is_dir(),"size":m.len()}),
            );
        }
        return Ok(json!(rows));
    }
    if cmd == "local_mkdir" {
        fs::create_dir_all(granted_path(app, id, field(&args, "path")?, true)?).map_err(err)?;
        return Ok(Value::Null);
    }
    if cmd == "theme_install" {
        let theme = &args["theme"];
        let text = theme.to_string();
        if text.len() > 16000 {
            return Err("主题过大".into());
        }
        let colors = theme["terminal"]
            .as_object()
            .ok_or("主题缺少 terminal 配色")?;
        if !colors.contains_key("background")
            || !colors.contains_key("foreground")
            || colors.values().any(|v| {
                v.as_str()
                    .map(|s| {
                        s.len() != 7
                            || !s.starts_with('#')
                            || !s[1..].bytes().all(|c| c.is_ascii_hexdigit())
                    })
                    .unwrap_or(true)
            })
        {
            return Err("主题颜色须为 #RRGGBB".into());
        }
        state
            .db
            .lock()
            .map_err(err)?
            .setting_set("customTheme", &text)
            .map_err(err)?;
        return Ok(Value::Null);
    }
    let profile = state
        .db
        .lock()
        .map_err(err)?
        .profile_list()
        .map_err(err)?
        .into_iter()
        .find(|p| p.id == args["profileId"].as_str().unwrap_or("") && p.kind == "ssh")
        .ok_or("SSH 档案不存在")?;
    let c = &profile.config;
    let auth = match c["auth"].as_str() {
        Some("key") => SftpAuth::Key {
            identity_file: c["identityFile"].as_str().unwrap_or("").into(),
        },
        Some("password") => return Err("SFTP 请使用 ssh-agent 或密钥认证".into()),
        _ => SftpAuth::Agent,
    };
    let req = SftpRequest {
        host: field(c, "host")?.into(),
        port: c["port"].as_u64().unwrap_or(22) as u16,
        user: c["user"].as_str().map(String::from),
        auth,
        proxy_jump: c["proxyJump"].as_str().map(String::from),
    };
    match cmd {
        "sftp_list" => Ok(json!(req
            .list(args["path"].as_str().unwrap_or(""))
            .map_err(err)?)),
        "sftp_mkdir" => {
            req.mkdir(field(&args, "path")?).map_err(err)?;
            Ok(Value::Null)
        }
        "sftp_remove" => {
            if args["isDir"] == true {
                req.remove_dir(field(&args, "path")?)
            } else {
                req.remove_file(field(&args, "path")?)
            }
            .map_err(err)?;
            Ok(Value::Null)
        }
        "sftp_rename" => {
            req.rename(field(&args, "from")?, field(&args, "to")?)
                .map_err(err)?;
            Ok(Value::Null)
        }
        "sftp_download" => {
            let local = granted_path(app, id, field(&args, "local")?, true)?;
            req.download(
                field(&args, "remote")?,
                local.to_str().ok_or("本地路径编码无效")?,
            )
            .map_err(err)?;
            Ok(Value::Null)
        }
        "sftp_upload" => {
            let local = granted_path(app, id, field(&args, "local")?, false)?;
            req.upload(
                local.to_str().ok_or("本地路径编码无效")?,
                field(&args, "remote")?,
            )
            .map_err(err)?;
            Ok(Value::Null)
        }
        _ => Err("不支持的扩展命令".into()),
    }
}

#[tauri::command]
pub fn plugin_add_domain(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    domain: String,
) -> Result<()> {
    let mut value = approved(&app, &id, false)?;
    let permission = PluginPermission::Net {
        domain: domain.to_ascii_lowercase(),
    };
    permission.validate().map_err(err)?;
    let mut manifest = parse(&value["manifest"])?;
    if !manifest.permissions.contains(&permission) {
        manifest.permissions.push(permission);
    }
    value["manifest"]["permissions"] = json!(manifest.permissions);
    let application = manifest.kind == term_core::plugin::ExtensionKind::App;
    value["enabled"] = json!(application);
    write_json(&path(&app, &id)?.join("approval.json"), &value)?;
    let row = { state.db.lock().map_err(err)?.plugin_get(&id).map_err(err)? };
    if let Some(mut row) = row {
        row.manifest = value["manifest"].to_string();
        row.state = if application { "installed" } else { "disabled" }.into();
        state
            .db
            .lock()
            .map_err(err)?
            .plugin_save(row)
            .map_err(err)?;
    }
    crate::applications::close(&app, &id);
    audit(&app, &id, "grant-domain", true);
    changed(&app, &id);
    Ok(())
}

#[tauri::command]
pub fn plugin_storage(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    key: String,
    value: Option<Value>,
    remove: bool,
) -> Result<Value> {
    ensure_context(&app, &window, &id)?;
    let v = approved(&app, &id, true)?;
    let m = parse(&v["manifest"])?;
    if !m.permissions.contains(&PluginPermission::Storage) {
        audit(&app, &id, "storage", false);
        return Err("未授权扩展存储".into());
    }
    if key.is_empty()
        || key.len() > 100
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("存储键非法".into());
    }
    let dir = crate::workspace::data_dir(&app)?
        .join("plugin-data")
        .join(&id);
    let p = dir.join(format!("{key}.json"));
    if remove {
        if p.exists() {
            fs::remove_file(p).map_err(err)?;
        }
        return Ok(Value::Null);
    }
    if let Some(value) = value {
        let size = value.to_string().len();
        if size > 1_000_000 {
            return Err("存储值过大".into());
        }
        let entries: Vec<_> = if dir.exists() {
            fs::read_dir(&dir)
                .map_err(err)?
                .filter_map(|e| e.ok())
                .collect()
        } else {
            vec![]
        };
        let total: u64 = entries
            .iter()
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum();
        if (!p.exists() && entries.len() >= 64)
            || total.saturating_sub(fs::metadata(&p).map(|m| m.len()).unwrap_or(0)) + size as u64
                > 8 * 1024 * 1024
        {
            return Err("扩展存储配额为 64 项 / 8 MiB".into());
        }
        write_json(&p, &value)?;
        Ok(Value::Null)
    } else {
        Ok(read_json(&p).unwrap_or(Value::Null))
    }
}
