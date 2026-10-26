//! Normalized SSH import data. Passwords and source-client executable hooks are never persisted.
use crate::{Result, TermError};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSshConfig {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub user: String,
    pub auth: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_jump: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_forward: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_forward: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dynamic_forward: Option<u16>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshImportEntry {
    pub name: String,
    #[serde(default)]
    pub group: Vec<String>,
    pub config: ImportedSshConfig,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshImportStats {
    pub imported: usize,
    pub skipped: usize,
    pub groups: usize,
}

pub(crate) fn connection_key(config: &serde_json::Value) -> String {
    serde_json::json!([
        config["host"]
            .as_str()
            .unwrap_or("")
            .trim()
            .trim_matches(&['[', ']'][..])
            .to_lowercase(),
        config["port"].as_u64().filter(|n| *n > 0).unwrap_or(22),
        config["user"].as_str().unwrap_or("").trim(),
        config["proxyJump"].as_str().unwrap_or("").trim()
    ])
    .to_string()
}
impl SshImportEntry {
    pub fn validate(&self) -> Result<()> {
        let valid_text =
            |s: &str, limit: usize| s.len() <= limit && !s.chars().any(char::is_control);
        let c = &self.config;
        if self.name.trim().is_empty()
            || !valid_text(&self.name, 1024)
            || c.host.trim().is_empty()
            || !valid_text(&c.host, 1024)
            || c.host.starts_with('-')
            || c.host
                .chars()
                .any(|v| v.is_whitespace() || "/@*?!".contains(v))
            || !valid_text(&c.user, 1024)
            || c.user.chars().any(|v| v.is_whitespace() || v == '@')
            || c.port == 0
            || !["password", "key", "agent"].contains(&c.auth.as_str())
            || self.group.len() > 16
            || self
                .group
                .iter()
                .any(|v| v.trim().is_empty() || !valid_text(v, 800))
            || [
                &c.identity_file,
                &c.proxy_jump,
                &c.local_forward,
                &c.remote_forward,
            ]
            .iter()
            .any(|v| v.as_ref().is_some_and(|s| !valid_text(s, 4096)))
            || c.dynamic_forward == Some(0)
            || (c.auth == "key" && c.identity_file.as_ref().is_none_or(|s| s.trim().is_empty()))
        {
            return Err(TermError::Other("导入的 SSH 参数无效".into()));
        }
        Ok(())
    }
}
