//! User-selected SSH configuration files, read locally with fixed resource limits.
use crate::state::AppState;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    collections::HashSet,
    io::Read,
    path::{Path, PathBuf},
};
use tauri::{State, WebviewWindow};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    name: String,
    data_b64: String,
}
#[derive(Default, Serialize)]
pub struct ImportFiles {
    files: Vec<ImportFile>,
    warnings: Vec<String>,
}
const MAX_FILE: usize = 16 * 1024 * 1024;
const MAX_TOTAL: usize = 32 * 1024 * 1024;
fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("SSH 配置导入仅限主窗口".into());
    }
    Ok(())
}
fn supported(path: &Path) -> bool {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if ["config", "sshconfig", "ssh_config"].contains(&name.as_str()) {
        return true;
    }
    matches!(
        path.extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "xsh"
            | "xts"
            | "ini"
            | "json"
            | "xml"
            | "yaml"
            | "yml"
            | "reg"
            | "sessions"
            | "mxtsessions"
            | "mxtsession"
            | "mobaconf"
            | "remmina"
            | "csv"
            | "conf"
            | "config"
            | "zip"
            | "plist"
    )
}
fn read_paths(paths: Vec<String>) -> Result<ImportFiles, String> {
    if paths.is_empty() || paths.len() > 1000 {
        return Err("请选择 1～1000 个文件或目录".into());
    }
    let mut out = ImportFiles::default();
    let mut total = 0;
    let mut seen = HashSet::new();
    let mut stack: Vec<(PathBuf, PathBuf, usize, bool)> = paths
        .into_iter()
        .map(|s| {
            let p = PathBuf::from(s);
            let base = if p.is_dir() {
                p.clone()
            } else {
                p.parent().unwrap_or(Path::new("")).to_path_buf()
            };
            (p, base, 0, true)
        })
        .collect();
    stack.reverse();
    let mut visited = 0;
    while let Some((path, base, depth, explicit)) = stack.pop() {
        visited += 1;
        if visited > 20000 || out.files.len() >= 1000 || depth > 16 {
            return Err("目录过大、层级过深或配置超过 1000 个，请缩小选择范围".into());
        }
        let name = path
            .strip_prefix(&base)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(v) => v,
            Err(_) => {
                out.warnings.push(format!("{name}：无法读取文件信息"));
                continue;
            }
        };
        if meta.file_type().is_symlink() {
            out.warnings.push(format!("{name}：已跳过符号链接"));
            continue;
        }
        if !seen.insert(
            path.canonicalize()
                .map_err(|_| format!("{name}：无法读取路径"))?,
        ) {
            continue;
        }
        if meta.is_dir() {
            let mut entries = std::fs::read_dir(&path)
                .map_err(|_| format!("{name}：无法读取目录"))?
                .take(20001)
                .map(|e| e.map(|e| e.path()))
                .collect::<std::io::Result<Vec<_>>>()
                .map_err(|_| format!("{name}：无法读取目录项"))?;
            if entries.len() + visited + stack.len() > 20000 {
                return Err("目录过大，请选择软件的会话配置子目录".into());
            }
            entries.sort();
            for entry in entries.into_iter().rev() {
                stack.push((entry, base.clone(), depth + 1, false));
            }
            continue;
        }
        if !meta.is_file() || (!explicit && !supported(&path)) {
            continue;
        }
        if meta.len() > MAX_FILE as u64 {
            out.warnings.push(format!("{name}：超过 16 MiB，已跳过"));
            continue;
        }
        let file = match std::fs::File::open(&path) {
            Ok(v) => v,
            Err(_) => {
                out.warnings.push(format!("{name}：无法读取文件"));
                continue;
            }
        };
        let mut bytes = Vec::new();
        file.take((MAX_FILE + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| format!("{name}：读取失败"))?;
        total += bytes.len();
        if bytes.len() > MAX_FILE || total > MAX_TOTAL {
            return Err("导入数据过大（单文件 16 MiB，合计 32 MiB）".into());
        }
        let raw_size = bytes.len();
        let bytes = match normalize_iterm_plist(&path, bytes) {
            Ok(v) => v,
            Err(_) => {
                out.warnings.push(format!(
                    "{name}：无法读取 iTerm2 plist，请使用导出的 Profile JSON"
                ));
                continue;
            }
        };
        if bytes.len() > MAX_FILE {
            return Err("转换后的配置超过 16 MiB，请只导出所需的 SSH Profile".into());
        }
        total = total - raw_size + bytes.len();
        if total > MAX_TOTAL {
            return Err("转换后的配置合计超过 32 MiB，请缩小选择范围".into());
        }
        out.files.push(ImportFile {
            name,
            data_b64: STANDARD.encode(bytes),
        });
    }
    Ok(out)
}

/// iTerm2 stores preferences as binary/XML property lists. Only expose profile fields needed
/// for SSH migration, never the rest of the user's terminal settings or embedded data.
fn normalize_iterm_plist(path: &Path, bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let plist = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("plist"))
        || bytes.starts_with(b"bplist");
    if !plist || bytes.iter().copied().find(|b| !b.is_ascii_whitespace()) == Some(b'{') {
        return Ok(bytes);
    }
    let value =
        plist::Value::from_reader(std::io::Cursor::new(bytes)).map_err(|_| "plist 格式无效")?;
    let dict = value.as_dictionary().ok_or("plist 根节点不是字典")?;
    let profiles = dict
        .get("Profiles")
        .or_else(|| dict.get("New Bookmarks"))
        .and_then(|v| v.as_array())
        .ok_or("plist 没有 Profile 列表")?;
    let keys = [
        "Name",
        "Guid",
        "Tags",
        "Custom Command",
        "Command",
        "Initial Text",
        "Dynamic Profile Parent GUID",
        "Dynamic Profile Parent Name",
    ];
    let mut clean_profiles = Vec::new();
    for profile in profiles {
        if let Some(p) = profile.as_dictionary() {
            let mut selected = serde_json::Map::new();
            for key in keys {
                if let Some(value) = p.get(key) {
                    selected.insert(
                        key.to_string(),
                        serde_json::to_value(value).map_err(|_| "Profile 字段无效")?,
                    );
                }
            }
            clean_profiles.push(serde_json::Value::Object(selected));
        }
    }
    serde_json::to_vec(&serde_json::json!({"Profiles":clean_profiles,"Default Bookmark Guid":dict.get("Default Bookmark Guid").and_then(|v| v.as_string())})).map_err(|_| "plist 转换失败".into())
}
#[tauri::command]
pub async fn ssh_import_read(
    window: WebviewWindow,
    paths: Vec<String>,
) -> Result<ImportFiles, String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || read_paths(paths))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn ssh_import_apply(
    window: WebviewWindow,
    state: State<'_, AppState>,
    entries: Vec<term_core::ssh_import::SshImportEntry>,
    skip_duplicates: bool,
    parent_id: Option<String>,
) -> Result<term_core::ssh_import::SshImportStats, String> {
    main_only(&window)?;
    state
        .db
        .lock()
        .map_err(|e| e.to_string())?
        .ssh_import(entries, skip_duplicates, parent_id)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn iterm_binary_and_xml_plist_convert_only_profile_fields() {
        let root: plist::Value = plist::to_value(&serde_json::json!({
            "New Bookmarks":[{"Name":"远程", "Guid":"ssh", "Command":"ssh -p2222 ops@app.example", "Custom Command":"Yes", "Tags":["生产"], "Password":"do-not-expose", "Background Image Location":"private-path"}],
            "Default Bookmark Guid":"ssh", "Other Secret":"do-not-expose"
        })).unwrap();
        for binary in [false, true] {
            let mut bytes = Vec::new();
            if binary {
                root.to_writer_binary(&mut bytes).unwrap();
            } else {
                root.to_writer_xml(&mut bytes).unwrap();
            }
            let converted =
                normalize_iterm_plist(Path::new("com.googlecode.iterm2.plist"), bytes).unwrap();
            let value: serde_json::Value = serde_json::from_slice(&converted).unwrap();
            assert_eq!(value["Profiles"][0]["Name"], "远程");
            assert_eq!(
                value["Profiles"][0]["Command"],
                "ssh -p2222 ops@app.example"
            );
            assert_eq!(value["Profiles"][0]["Tags"][0], "生产");
            assert!(!String::from_utf8(converted)
                .unwrap()
                .contains("do-not-expose"));
            assert!(value["Profiles"][0]
                .get("Background Image Location")
                .is_none());
        }
    }
    #[test]
    fn iterm_plist_is_discovered_in_directories() {
        let root =
            std::env::temp_dir().join(format!("termone-iterm-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let value: plist::Value = plist::to_value(
            &serde_json::json!({"Profiles":[{"Name":"server", "Command":"ssh server.example"}]}),
        )
        .unwrap();
        value
            .to_file_binary(root.join("com.googlecode.iterm2.plist"))
            .unwrap();
        let out = read_paths(vec![root.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(out.files.len(), 1);
        let bytes = STANDARD.decode(&out.files[0].data_b64).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["Profiles"][0]["Name"],
            "server"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn reads_only_configuration_files_preserving_relative_groups_and_deduplicates_paths() {
        let root =
            std::env::temp_dir().join(format!("termone-import-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("生产")).unwrap();
        let config = root.join("生产/app.xsh");
        std::fs::write(&config, "[CONNECTION]\nHost=app.example").unwrap();
        std::fs::write(root.join("id_ed25519"), "private-key-not-imported").unwrap();
        let out = read_paths(vec![
            root.to_string_lossy().into_owned(),
            config.to_string_lossy().into_owned(),
        ])
        .unwrap();
        assert_eq!(out.files.len(), 1);
        assert!(out.files[0].name.ends_with("app.xsh"));
        assert!(!STANDARD
            .decode(&out.files[0].data_b64)
            .unwrap()
            .starts_with(b"private"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn limits_files_and_reports_unreadable_paths() {
        assert!(read_paths(vec![]).is_err());
        let out = read_paths(vec!["/this-path-does-not-exist/termone-import.json".into()]).unwrap();
        assert!(out.files.is_empty());
        assert_eq!(out.warnings.len(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks() {
        let root =
            std::env::temp_dir().join(format!("termone-import-links-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink("/etc/hosts", root.join("outside.conf")).unwrap();
        let out = read_paths(vec![root.to_string_lossy().into_owned()]).unwrap();
        assert!(out.files.is_empty());
        assert_eq!(out.warnings.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
