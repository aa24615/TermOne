//! SFTP 图形化文件管理（R-01）：复用系统 `sftp` 客户端批处理模式。
//!
//! 设计原则与 `ssh.rs` 一致——不重复实现 SFTP 协议栈，而是驱动系统 OpenSSH
//! 的 `sftp -b -` 批处理会话：命令经 stdin 下发，stdout 捕获后解析。
//! 这样无需引入任何新的 Rust 依赖（仅用 `std::process`），也天然支持
//! 系统 ssh 的密钥 / 代理 / known_hosts / ProxyJump 体系。
//!
//! 限制：批处理模式无法交互输入口令，因此 **密码认证** 不适用于 SFTP
//! （会触发 `BatchMode=yes` 快速失败）；SFTP 仅支持 `agent` 与 `key` 认证，
//! 受口令保护的私钥需先经 ssh-agent 解锁。这与「复用系统 ssh」的取舍一致。

use std::io::Write;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::error::{Result, TermError};

fn default_ssh_port() -> u16 {
    22
}

/// 展开 `~` / `~/` 开头的路径为绝对路径（-i 参数不经过 shell，无自动展开）。
fn expand_tilde(path: &str) -> String {
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().into_owned();
        }
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

/// 把路径包成双引号参数并转义内部的引号/反斜杠，使含空格的路径可被 sftp 正确解析。
fn quote(p: &str) -> String {
    format!("\"{}\"", p.replace('\\', "\\\\").replace('"', "\\\""))
}

/// 远端认证方式。密码认证被刻意排除（见模块文档）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SftpAuth {
    Agent,
    Key { identity_file: String },
}

/// 一次 SFTP 连接所需的全部参数（由前端从 SSH 档案组装后下发）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpRequest {
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub user: Option<String>,
    pub auth: SftpAuth,
    #[serde(default)]
    pub proxy_jump: Option<String>,
}

/// 远端目录项。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    pub mode: String,
    pub owner: String,
    pub group: String,
    /// 人类可读的修改时间（来自 sftp `ls -la` 的月/日/时:分 或 月/日/年）。
    pub mtime: String,
    /// 符号链接指向的目标（仅软链接有值）。
    #[serde(default)]
    pub target: Option<String>,
}

impl SftpRequest {
    /// 构造 `sftp` 进程参数（不含程序名本身）。
    fn base_args(&self) -> Vec<String> {
        let mut a: Vec<String> = vec![
            "-P".into(),
            self.port.to_string(),
            "-o".into(),
            "StrictHostKeyChecking=accept-new".into(),
            "-o".into(),
            "BatchMode=yes".into(),
        ];
        if let SftpAuth::Key { identity_file } = &self.auth {
            if !identity_file.is_empty() {
                a.push("-i".into());
                a.push(expand_tilde(identity_file));
                a.push("-o".into());
                a.push("IdentitiesOnly=yes".into());
            }
        }
        if let Some(pj) = &self.proxy_jump {
            if !pj.is_empty() {
                a.push("-J".into());
                a.push(pj.clone());
            }
        }
        let target = match &self.user {
            Some(u) if !u.is_empty() => format!("{u}@{}", self.host),
            _ => self.host.clone(),
        };
        a.push(target);
        a
    }

    /// 启动 `sftp -b -`，将批处理命令写入 stdin，返回 stdout；失败时将 stderr 并入错误。
    fn run_batch(&self, cmds: &[String]) -> Result<String> {
        let args = self.base_args();
        // 命令形如：sftp -b - -P <port> -o ... [-i ...] [-J ...] <user@host>
        let mut child = Command::new("sftp")
            .arg("-b")
            .arg("-")
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| TermError::Other(format!("无法启动 sftp 客户端: {e}")))?;

        {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| TermError::Other("无法获取 sftp stdin".into()))?;
            for c in cmds {
                writeln!(stdin, "{c}").map_err(TermError::Io)?;
            }
            // 显式 drop 以关闭 stdin，通知 sftp 批处理结束
            drop(stdin);
        }

        let out = child.wait_with_output().map_err(TermError::Io)?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(TermError::Other(format!(
                "sftp 执行失败（退出码 {:?}）: {}",
                out.status.code(),
                stderr.trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// 解析 sftp `ls -la` 的输出为结构化目录项。
    /// 空 `path` 表示远端家目录（不带参数执行 `ls -la`）。
    pub fn list(&self, path: &str) -> Result<Vec<SftpEntry>> {
        let script = if path.is_empty() {
            vec!["ls -la".to_string()]
        } else {
            vec![format!("ls -la {}", quote(&normalize_remote(path)))]
        };
        let out = self.run_batch(&script)?;
        Ok(parse_ls(&out))
    }

    /// 远端新建目录。
    pub fn mkdir(&self, path: &str) -> Result<()> {
        let remote = normalize_remote(path);
        self.run_batch(&[format!("mkdir {}", quote(&remote))])
            .map(|_| ())
    }

    /// 删除远端文件（`rm`）。
    pub fn remove_file(&self, path: &str) -> Result<()> {
        let remote = normalize_remote(path);
        self.run_batch(&[format!("rm {}", quote(&remote))]).map(|_| ())
    }

    /// 删除远端空目录（`rmdir`）。非空目录需先清空——为安全起见不递归删除。
    pub fn remove_dir(&self, path: &str) -> Result<()> {
        let remote = normalize_remote(path);
        self.run_batch(&[format!("rmdir {}", quote(&remote))])
            .map(|_| ())
    }

    /// 远端重命名 / 移动。
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let from = normalize_remote(from);
        let to = normalize_remote(to);
        self.run_batch(&[format!("rename {} {}", quote(&from), quote(&to))])
            .map(|_| ())
    }

    /// 下载：远端 -> 本地。
    pub fn download(&self, remote: &str, local: &str) -> Result<()> {
        let remote = normalize_remote(remote);
        self.run_batch(&[format!("get {} {}", quote(&remote), quote(local))])
            .map(|_| ())
    }

    /// 上传：本地 -> 远端。
    pub fn upload(&self, local: &str, remote: &str) -> Result<()> {
        let remote = normalize_remote(remote);
        self.run_batch(&[format!("put {} {}", quote(local), quote(&remote))])
            .map(|_| ())
    }
}

/// 远端路径统一为正向斜杠（Windows 本地路径不在此处理）。
fn normalize_remote(p: &str) -> String {
    p.replace('\\', "/")
}

/// 解析 `sftp -b` 的 `ls -la` 输出。
///
/// 典型每行形如：
/// `drwxr-xr-x 2 user group 4096 Jan 1 12:00 dirname`
/// `-rw-r--r-- 1 user group 123 Jan 1 12:00 file.txt`
/// 非目录项行（如 `sftp>` 提示符、连接横幅、`total N`）被忽略。
fn parse_ls(output: &str) -> Vec<SftpEntry> {
    let mut entries = Vec::new();
    for raw in output.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(perm) = parts.next() else { continue };
        let Some(kind_char) = perm.chars().next() else {
            continue;
        };
        // 仅接受标准 ls 长格式的首字符（目录 / 文件 / 符号链接）
        if !matches!(kind_char, 'd' | '-' | 'l') {
            continue;
        }
        // perms links owner group size month day time|year name...
        let _links = parts.next();
        let owner = parts.next().unwrap_or("").to_string();
        let group = parts.next().unwrap_or("").to_string();
        let size_s = parts.next().unwrap_or("0");
        let month = parts.next().unwrap_or("");
        let day = parts.next().unwrap_or("");
        let time_or_year = parts.next().unwrap_or("");
        let raw_name = parts.collect::<Vec<_>>().join(" ");
        // 符号链接形如 `name -> target`，需剥离目标部分，仅保留链接名
        let (name, target) = if kind_char == 'l' {
            if let Some(idx) = raw_name.find(" -> ") {
                (
                    raw_name[..idx].to_string(),
                    Some(raw_name[idx + 4..].to_string()),
                )
            } else {
                (raw_name, None)
            }
        } else {
            (raw_name, None)
        };
        if name.is_empty() || name == "." || name == ".." {
            continue;
        }
        let size = size_s.parse::<u64>().unwrap_or(0);
        entries.push(SftpEntry {
            name,
            is_dir: kind_char == 'd',
            is_link: kind_char == 'l',
            size,
            mode: perm.to_string(),
            owner,
            group,
            mtime: format!("{month} {day} {time_or_year}").trim().to_string(),
            target,
        });
    }
    entries.sort_by(|a, b| {
        // 目录优先，再按名称排序，体验更贴近常规文件管理器
        (b.is_dir, a.name.to_lowercase()).cmp(&(a.is_dir, b.name.to_lowercase()))
    });
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ls_basic() {
        let out = "\
sftp> ls -la /tmp
drwxr-xr-x 2 alice staff 4096 Jan  1 12:00 docs
-rw-r--r-- 1 alice staff  123 Jan  1 09:30 note.txt
lrwxrwxrwx 1 alice staff    7 Jan  1 09:30 link -> docs
total 4096
";
        let e = parse_ls(out);
        assert_eq!(e.len(), 3);
        // 排序约定：目录优先；其余按名称字母序（"link" < "note.txt"）
        assert!(e[0].is_dir && e[0].name == "docs");
        assert!(e[1].is_link && e[1].name == "link" && e[1].target.as_deref() == Some("docs"));
        assert!(!e[2].is_dir && e[2].name == "note.txt" && e[2].size == 123);
    }

    #[test]
    fn parse_ls_name_with_spaces() {
        let out = "-rw-r--r-- 1 u g 42 Dec 25 23:59 my report.pdf\n";
        let e = parse_ls(out);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].name, "my report.pdf");
        assert_eq!(e[0].size, 42);
    }

    #[test]
    fn quote_escapes() {
        assert_eq!(quote("a b"), "\"a b\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
    }
}
