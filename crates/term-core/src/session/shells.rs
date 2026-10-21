//! 扫描本机可用的 Shell 与常用启动器（Docker / SSH / WSL）。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub name: String,
    pub path: String,
    /// "shell" | "docker" | "ssh" | "wsl"
    pub preset: String,
}

fn find_in_dirs(name: &str, dirs: &[impl AsRef<std::path::Path>]) -> Option<String> {
    let exts: &[&str] = if cfg!(windows) { &["exe"] } else { &[""] };
    for dir in dirs {
        for ext in exts {
            let file = if ext.is_empty() {
                name.to_string()
            } else {
                format!("{name}.{ext}")
            };
            let p = dir.as_ref().join(file);
            if p.is_file() {
                return Some(p.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn find_in_path(name: &str) -> Option<String> {
    let dirs = std::env::var_os("PATH")?;
    let dir_list: Vec<std::path::PathBuf> = std::env::split_paths(&dirs).collect();
    find_in_dirs(name, &dir_list)
}

fn push_shell(out: &mut Vec<ShellInfo>, name: &str, path: String, preset: &str) {
    if out.iter().any(|s| s.path == path) {
        return;
    }
    out.push(ShellInfo {
        name: name.to_string(),
        path,
        preset: preset.to_string(),
    });
}

/// 枚举本机可用的 Shell 与启动器，默认 Shell 排在首位。
pub fn list_shells() -> Vec<ShellInfo> {
    let mut out = Vec::new();

    let default_shell = crate::session::default_shell();
    let display = std::path::Path::new(&default_shell)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| default_shell.clone());
    push_shell(
        &mut out,
        &format!("{display}（默认）"),
        default_shell,
        "shell",
    );

    #[cfg(windows)]
    {
        let ps7: &[&std::path::Path] = &[std::path::Path::new(
            r"C:\Program Files\PowerShell\7",
        )];
        if let Some(p) = find_in_dirs("pwsh", ps7).or_else(|| find_in_path("pwsh")) {
            push_shell(&mut out, "PowerShell 7", p, "shell");
        }
        if let Some(p) = find_in_path("powershell") {
            push_shell(&mut out, "Windows PowerShell", p, "shell");
        }
        if let Some(p) = find_in_path("cmd") {
            push_shell(&mut out, "CMD", p, "shell");
        }
        let git: &[&std::path::Path] = &[
            std::path::Path::new(r"C:\Program Files\Git\bin"),
            std::path::Path::new(r"C:\Program Files\Git\usr\bin"),
        ];
        if let Some(p) = find_in_dirs("bash", git).or_else(|| find_in_path("bash")) {
            push_shell(&mut out, "Git Bash", p, "shell");
        }
        if let Some(p) = find_in_path("nu") {
            push_shell(&mut out, "Nushell", p, "shell");
        }
        if let Some(p) = find_in_path("wsl") {
            push_shell(&mut out, "WSL", p, "wsl");
        }
    }

    #[cfg(not(windows))]
    {
        let dirs: &[&std::path::Path] = &[
            std::path::Path::new("/bin"),
            std::path::Path::new("/usr/bin"),
            std::path::Path::new("/usr/local/bin"),
            std::path::Path::new("/opt/homebrew/bin"),
        ];
        for (name, label) in [
            ("zsh", "Zsh"),
            ("bash", "Bash"),
            ("fish", "Fish"),
            ("sh", "Sh"),
            ("dash", "Dash"),
            ("ksh", "Ksh"),
            ("tcsh", "Tcsh"),
            ("pwsh", "PowerShell"),
            ("nu", "Nushell"),
        ] {
            if let Some(p) = find_in_dirs(name, dirs).or_else(|| find_in_path(name)) {
                push_shell(&mut out, label, p, "shell");
            }
        }
    }

    if let Some(p) = find_in_path("docker") {
        push_shell(&mut out, "Docker 容器", p, "docker");
    }
    if let Some(p) = find_in_path("ssh") {
        push_shell(&mut out, "SSH 快速连接", p, "ssh");
    }

    out
}
