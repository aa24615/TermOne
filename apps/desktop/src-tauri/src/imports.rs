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
        out.files.push(ImportFile {
            name,
            data_b64: STANDARD.encode(bytes),
        });
    }
    Ok(out)
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
