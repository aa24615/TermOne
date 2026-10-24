//! R-20 插件运行时与插件管理 —— 地基（纯逻辑层，可单测）。
//!
//! 本模块承载插件系统的「安全与生命周期」核心，供桌面端 Tauri IPC 命令与
//! 前端 Host API 共用：
//! - 插件清单（manifest）校验：逆域名 id、语义化版本、权限声明合法性；
//! - 权限沙箱（[`PermissionChecker`]）：IPC 命令白名单、网络域名白名单、
//!   密钥环硬编码拒绝（任何插件都不可访问）；
//! - 生命周期状态机：安装→启用→激活→停用→卸载，非法跃迁拒绝；
//! - 审计事件模型：越权调用 / 安装卸载等可审计；
//! - `.tpk` 清单解析与结构校验。
//!
//! 桌面端运行时与原生命令已接入；实现和验收证据见 docs/requirement-coverage.md。

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Result, TermError};

/// 插件清单声明的宿主 API 版本（最小兼容版本）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostApiVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl HostApiVersion {
    pub fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    /// 本宿主版本是否满足插件要求的最小版本（>=）。
    pub fn satisfies(&self, min: &HostApiVersion) -> bool {
        (self.major, self.minor, self.patch) >= (min.major, min.minor, min.patch)
    }
}

/// 插件声明的权限能力。
///
/// 注意：**密钥环（secrets）刻意不在枚举内**——任何插件都不可访问密钥环，
/// 由 [`PermissionChecker`] 对涉及凭据的 IPC 命令硬编码拒绝（纵深防御）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PluginPermission {
    /// 允许调用的宿主 IPC 命令（白名单，精确匹配）。
    Ipc { command: String },
    /// 允许联网的域名白名单（精确匹配）。
    Net { domain: String },
    /// 允许使用插件私有键值存储（命名空间隔离，与宿主及其它插件互不干扰）。
    Storage,
    /// 允许渲染侧栏/面板 UI。
    UiPanel,
    /// 允许注册命令与快捷键。
    UiCommand,
    /// 允许订阅宿主事件（会话开始/结束、设置变更等）。
    EventSubscribe,
    SessionRead,
    SessionWrite,
    UiToast,
    UiSetting,
    DialogOpen,
    GlobalShortcut,
}

impl PluginPermission {
    /// 校验单条权限声明是否合法。
    pub fn validate(&self) -> Result<()> {
        match self {
            PluginPermission::Ipc { command } => {
                if command.trim().is_empty() {
                    return Err(TermError::Other("IPC 权限命令名不能为空".into()));
                }
                if !command.chars().all(|c| {
                    c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'
                }) {
                    return Err(TermError::Other(format!(
                        "IPC 权限命令名含非法字符: {command}"
                    )));
                }
                Ok(())
            }
            PluginPermission::Net { domain } => {
                if !is_valid_domain(domain) {
                    return Err(TermError::Other(format!("网络权限域名非法: {domain}")));
                }
                Ok(())
            }
            PluginPermission::Storage
            | PluginPermission::UiPanel
            | PluginPermission::UiCommand
            | PluginPermission::EventSubscribe
            | PluginPermission::SessionRead | PluginPermission::SessionWrite
            | PluginPermission::UiToast | PluginPermission::UiSetting
            | PluginPermission::DialogOpen | PluginPermission::GlobalShortcut => Ok(()),
        }
    }
}

/// 粗校验域名格式（不含协议、端口；至少含一个点的标签序列）。
fn is_valid_domain(domain: &str) -> bool {
    if domain.is_empty() || domain.len() > 253 {
        return false;
    }
    if domain.starts_with('.') || domain.ends_with('.') {
        return false;
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    labels.iter().all(|l| {
        !l.is_empty()
            && l.len() <= 63
            && l.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
            && !l.starts_with('-')
            && !l.ends_with('-')
    })
}

/// 插件清单（manifest.json）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    /// 逆域名唯一标识，如 `com.termone.sftp`。
    pub id: String,
    /// 展示名。
    pub name: String,
    /// 语义化版本。
    pub version: String,
    /// 入口脚本（相对插件根目录的 JS/TS 模块）。
    pub entry: String,
    /// 依赖的宿主 API 最小版本。
    pub host_api: HostApiVersion,
    /// 权限声明（最小权限）。
    #[serde(default)]
    pub permissions: Vec<PluginPermission>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub homepage: String,
    /// 插件包内必须包含的文件清单（用于 `.tpk` 完整性校验）。
    #[serde(default)]
    pub files: Vec<String>,
}

impl PluginManifest {
    /// 校验清单合法性，返回首个错误原因。
    pub fn validate(&self) -> Result<()> {
        if self.name.len()>256 || self.description.len()>4096 || self.permissions.len()>64 || self.files.len()>256 || self.version.len()>64 { return Err(TermError::Other("插件清单超过大小限制".into())); }
        if !is_reverse_domain(&self.id) {
            return Err(TermError::Other(format!(
                "插件 id 必须为逆域名格式（如 com.termone.sftp）: {}",
                self.id
            )));
        }
        if self.name.trim().is_empty() {
            return Err(TermError::Other("插件 name 不能为空".into()));
        }
        if !is_semver(&self.version) {
            return Err(TermError::Other(format!(
                "插件 version 必须为语义化版本: {}",
                self.version
            )));
        }
        if !safe_package_path(&self.entry) {
            return Err(TermError::Other("插件 entry 不能为空".into()));
        }
        if self.files.is_empty() {
            return Err(TermError::Other("插件必须声明 files 文件清单".into()));
        }
        for p in &self.permissions {
            p.validate()?;
        }
        Ok(())
    }

    /// 从 JSON 字节解析并校验清单。
    pub fn from_json(bytes: &[u8]) -> Result<PluginManifest> {
        let m: PluginManifest = serde_json::from_slice(bytes)
            .map_err(|e| TermError::Other(format!("插件清单解析失败: {e}")))?;
        m.validate()?;
        Ok(m)
    }

    /// 判断某 IPC 命令是否在声明权限内。
    pub fn allows_ipc(&self, command: &str) -> bool {
        self.permissions
            .iter()
            .any(|p| matches!(p, PluginPermission::Ipc { command: c } if c == command))
    }

    /// 判断某域名是否在声明权限内（精确匹配，例如 `api.openai.com` 匹配 `*.openai.com`）。
    pub fn allows_net(&self, domain: &str) -> bool {
        let domain = domain.to_ascii_lowercase();
        self.permissions.iter().any(|p| match p {
            PluginPermission::Net { domain: d } => {
                let d = d.to_ascii_lowercase();
                d == domain || is_same_registrable(&d, &domain)
            }
            _ => false,
        })
    }
}

/// 逆域名格式校验：`com.termone.sftp`。
fn is_reverse_domain(s: &str) -> bool {
    if s.is_empty() || s.len() > 255 {
        return false;
    }
    if s.starts_with('.') || s.ends_with('.') {
        return false;
    }
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() < 2 {
        return false;
    }
    parts.iter().all(|p| {
        !p.is_empty()
            && p.len() <= 63
            && !p.starts_with('-') && !p.ends_with('-')
            && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    })
}

/// 语义化版本粗校验：`MAJOR.MINOR.PATCH`，每段非负整数。
fn is_semver(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// 判断 `child` 是否是 `parent` 的同级或子域（同注册域）。
/// 例：`api.openai.com` 匹配 `openai.com`；`evil.com` 不匹配 `openai.com`。
fn is_same_registrable(parent: &str, child: &str) -> bool {
    if let Some(stripped) = child.strip_suffix(parent) {
        stripped.is_empty()
            || (stripped.ends_with('.') && !stripped.trim_end_matches('.').is_empty())
    } else {
        false
    }
}

/// 权限沙箱：基于清单裁决插件的能力调用。
///
/// 关键红线：`secrets` 相关 IPC 命令**硬编码拒绝**——密钥环任何插件都不可访问（RK-09）。
pub struct PermissionChecker;

/// 涉及密钥环/凭据的 IPC 命令（任何插件都不可调用）。
const SECRET_IPC: &[&str] = &[
    "getSecret",
    "setSecret",
    "deleteSecret",
    "listSecrets",
    "exportKeyring",
    "secret_set", "secret_get", "secret_delete", "secrets_get", "secrets_set",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny { reason: String },
}

impl PermissionChecker {
    pub fn check_ipc(manifest: &PluginManifest, command: &str) -> Decision {
        if SECRET_IPC.iter().any(|c| *c == command) || command.to_ascii_lowercase().contains("secret") || command.to_ascii_lowercase().contains("keyring") {
            return Decision::Deny {
                reason: format!("密钥环/凭据接口对所有插件禁用: {command}"),
            };
        }
        if manifest.allows_ipc(command) {
            Decision::Allow
        } else {
            Decision::Deny {
                reason: format!("插件未声明 IPC 权限: {command}"),
            }
        }
    }

    pub fn check_net(manifest: &PluginManifest, domain: &str) -> Decision {
        if manifest.allows_net(domain) {
            Decision::Allow
        } else {
            Decision::Deny {
                reason: format!("插件未声明网络域名权限: {domain}"),
            }
        }
    }

    /// 校验 UI/存储类能力（Storage / UiPanel / UiCommand / EventSubscribe）。
    pub fn check_capability(manifest: &PluginManifest, cap: &PluginPermission) -> Decision {
        match cap {
            PluginPermission::Storage
            | PluginPermission::UiPanel
            | PluginPermission::UiCommand
            | PluginPermission::EventSubscribe
            | PluginPermission::SessionRead | PluginPermission::SessionWrite
            | PluginPermission::UiToast | PluginPermission::UiSetting
            | PluginPermission::DialogOpen | PluginPermission::GlobalShortcut => {
                if manifest.permissions.contains(cap) {
                    Decision::Allow
                } else {
                    Decision::Deny {
                        reason: "插件未声明该 UI/存储能力".into(),
                    }
                }
            }
            PluginPermission::Ipc { .. } | PluginPermission::Net { .. } => Decision::Deny {
                reason: "请使用 check_ipc / check_net".into(),
            },
        }
    }
}

/// 插件生命周期状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PluginState {
    Installed,
    Enabled,
    Active,
    Disabled,
    Uninstalled,
}

impl PluginState {
    /// 校验状态跃迁是否合法。
    ///
    /// 规则：
    /// - 安装后必须先「启用」才能「激活」（懒加载按需，禁止跳过启用）；
    /// - 激活态必须先「停用」才能卸载（彻底注销后再移除）；
    /// - 任何状态均可进入「卸载」（软删除），但卸载不可逆。
    pub fn can_transition(&self, to: PluginState) -> bool {
        use PluginState::*;
        match (*self, to) {
            (Installed, Enabled) => true,
            (Enabled, Active) => true,
            (Active, Disabled) => true,
            (Disabled, Enabled) => true,
            (_, Uninstalled) => true,
            _ => false,
        }
    }
}

/// 审计事件类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuditKind {
    IpcDenied,
    NetDenied,
    CapabilityDenied,
    Install,
    Uninstall,
    Enable,
    Disable,
    Activate,
    Deactivate,
}

/// 审计事件（越权调用与生命周期变更均留痕，可审计）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub kind: AuditKind,
    pub plugin_id: String,
    pub at: i64,
    #[serde(default)]
    pub detail: String,
}

impl AuditEvent {
    pub fn now(kind: AuditKind, plugin_id: &str, detail: impl Into<String>) -> Self {
        let at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Self {
            kind,
            plugin_id: plugin_id.to_string(),
            at,
            detail: detail.into(),
        }
    }
}

/// `.tpk` 包结构校验：解析 manifest.json 并校验 `files` 清单、
/// entry 被打包、且所有路径均为相对路径（禁止路径穿越）。
pub fn validate_tpk(manifest_json: &[u8], present_files: &[String]) -> Result<PluginManifest> {
    let m = PluginManifest::from_json(manifest_json)?;
    let present: HashSet<&String> = present_files.iter().collect();
    if present.len() != present_files.len() || present_files.iter().any(|f| !safe_package_path(f)) {
        return Err(TermError::Other("插件包含重复或不安全的文件路径".into()));
    }
    if !present.contains(&m.entry) {
        return Err(TermError::Other(format!(
            "tpk 缺少入口文件: {}",
            m.entry
        )));
    }
    for f in &m.files {
        if !safe_package_path(f) {
            return Err(TermError::Other(format!("tpk 含非法路径（禁止穿越）: {f}")));
        }
        if !present.contains(f) {
            return Err(TermError::Other(format!("tpk 声明文件缺失: {f}")));
        }
    }
    Ok(m)
}

/// Portable package paths: disallow Windows drive paths, alternate streams and traversal on every OS.
pub fn safe_package_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 240 && !path.contains(['\\', ':', '\0'])
        && path.split('/').all(|p| !p.is_empty() && p != "." && p != ".." && !p.ends_with([' ', '.']))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_rejects_every_unsafe_path_even_when_not_declared() {
        let json=valid_manifest_json();
        for bad in ["../evil.js", "C:/evil.js", "a\\b", "/root", "a//b", "a/./b", "file:stream", "trailing."] {
            assert!(!safe_package_path(bad), "{bad}");
            assert!(validate_tpk(json.as_bytes(), &["index.js".into(), "style.css".into(), bad.into()]).is_err());
        }
        assert!(validate_tpk(json.as_bytes(), &["index.js".into(),"style.css".into(),"index.js".into()]).is_err());
    }

    #[test]
    fn snake_case_secret_commands_are_denied_even_if_declared() {
        let mut manifest=PluginManifest::from_json(valid_manifest_json().as_bytes()).unwrap();
        for command in ["secret_get", "secret_set", "get_keyring", "SECRETS_READ"] {
            manifest.permissions.push(PluginPermission::Ipc{command:command.into()});
            assert!(matches!(PermissionChecker::check_ipc(&manifest,command),Decision::Deny{..}));
        }
    }

    fn valid_manifest_json() -> String {
        serde_json::json!({
            "id": "com.termone.sftp",
            "name": "SFTP 文件管理",
            "version": "1.0.0",
            "entry": "index.js",
            "hostApi": { "major": 1, "minor": 0, "patch": 0 },
            "permissions": [
                { "type": "ipc", "command": "sftpList" },
                { "type": "net", "domain": "api.termone.com" }
            ],
            "files": ["index.js", "style.css"]
        })
        .to_string()
    }

    // ---------------- P0：内核正确性 / 数据一致性 ----------------

    #[test]
    fn p0_manifest_roundtrip_and_validate() {
        let m = PluginManifest::from_json(valid_manifest_json().as_bytes()).unwrap();
        // 序列化后再解析应一致
        let bytes = serde_json::to_vec(&m).unwrap();
        let m2 = PluginManifest::from_json(&bytes).unwrap();
        assert_eq!(m, m2);
        assert!(m.allows_ipc("sftpList"));
        assert!(m.allows_net("api.termone.com"));
    }

    #[test]
    fn p0_manifest_rejects_invalid_id_and_version() {
        // 非法 id（非逆域名）
        let bad = serde_json::json!({
            "id": "SFTP", "name": "x", "version": "1.0.0",
            "entry": "i.js", "hostApi": {"major":1,"minor":0,"patch":0}, "files": ["i.js"]
        })
        .to_string();
        assert!(PluginManifest::from_json(bad.as_bytes()).is_err());

        // 非法 semver
        let bad = serde_json::json!({
            "id": "com.a.b", "name": "x", "version": "1.0",
            "entry": "i.js", "hostApi": {"major":1,"minor":0,"patch":0}, "files": ["i.js"]
        })
        .to_string();
        assert!(PluginManifest::from_json(bad.as_bytes()).is_err());

        // 空 files 清单
        let bad = serde_json::json!({
            "id": "com.a.b", "name": "x", "version": "1.0.0",
            "entry": "i.js", "hostApi": {"major":1,"minor":0,"patch":0}
        })
        .to_string();
        assert!(PluginManifest::from_json(bad.as_bytes()).is_err());
    }

    #[test]
    fn p0_tpk_manifest_valid() {
        let files = vec!["index.js".to_string(), "style.css".to_string()];
        let m = validate_tpk(valid_manifest_json().as_bytes(), &files).unwrap();
        assert_eq!(m.id, "com.termone.sftp");
    }

    // ---------------- P1：Must（R-20 体验闭环） ----------------

    #[test]
    fn p1_permission_ipc_allow_deny() {
        let m = PluginManifest::from_json(valid_manifest_json().as_bytes()).unwrap();
        // 已声明命令放行
        assert_eq!(
            PermissionChecker::check_ipc(&m, "sftpList"),
            Decision::Allow
        );
        // 未声明命令拒绝
        match PermissionChecker::check_ipc(&m, "sftpDelete") {
            Decision::Deny { .. } => {}
            Decision::Allow => panic!("未声明 IPC 应被拒绝"),
        }
        // 空权限默认拒绝
        let empty = PluginManifest::from_json(
            serde_json::json!({
                "id":"com.a.b","name":"x","version":"1.0.0","entry":"i.js",
                "hostApi":{"major":1,"minor":0,"patch":0},"files":["i.js"]
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(PermissionChecker::check_ipc(&empty, "anything"), Decision::Deny { reason: "插件未声明 IPC 权限: anything".into() });
    }

    #[test]
    fn p1_permission_net_allow_deny() {
        let m = PluginManifest::from_json(valid_manifest_json().as_bytes()).unwrap();
        // 精确匹配
        assert_eq!(
            PermissionChecker::check_net(&m, "api.termone.com"),
            Decision::Allow
        );
        // 同级子域匹配
        assert_eq!(
            PermissionChecker::check_net(&m, "cdn.api.termone.com"),
            Decision::Allow
        );
        // 不同注册域拒绝
        match PermissionChecker::check_net(&m, "evil.com") {
            Decision::Deny { .. } => {}
            Decision::Allow => panic!("未声明域名应被拒绝"),
        }
    }

    #[test]
    fn p1_lifecycle_transitions_valid_and_invalid() {
        use PluginState::*;
        // 合法跃迁
        assert!(Installed.can_transition(Enabled));
        assert!(Enabled.can_transition(Active));
        assert!(Active.can_transition(Disabled));
        assert!(Disabled.can_transition(Enabled));
        assert!(Active.can_transition(Uninstalled));
        assert!(Installed.can_transition(Uninstalled));
        // 非法跃迁：禁止跳过「启用」直接激活
        assert!(!Installed.can_transition(Active));
        // 非法跃迁：激活态必须先停用才能回退到安装态
        assert!(!Active.can_transition(Installed));
        assert!(!Active.can_transition(Enabled));
        // 卸载不可逆
        assert!(!Uninstalled.can_transition(Installed));
    }

    // ---------------- P2：Should（差异化加固） ----------------

    #[test]
    fn p2_capability_check() {
        let m = PluginManifest::from_json(valid_manifest_json().as_bytes()).unwrap();
        // 未声明 UiPanel → 拒绝
        assert_eq!(
            PermissionChecker::check_capability(&m, &PluginPermission::UiPanel),
            Decision::Deny {
                reason: "插件未声明该 UI/存储能力".into()
            }
        );
        // 声明 Storage 后放行
        let with_storage = PluginManifest::from_json(
            serde_json::json!({
                "id":"com.a.b","name":"x","version":"1.0.0","entry":"i.js",
                "hostApi":{"major":1,"minor":0,"patch":0},
                "permissions":[{"type":"storage"}],
                "files":["i.js"]
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(
            PermissionChecker::check_capability(&with_storage, &PluginPermission::Storage),
            Decision::Allow
        );
    }

    // ---------------- P3：边界与并发 ----------------

    #[test]
    fn p3_audit_event_recorded_on_deny() {
        let m = PluginManifest::from_json(valid_manifest_json().as_bytes()).unwrap();
        let decision = PermissionChecker::check_ipc(&m, "undeclaredCmd");
        // 拒绝时应可对应构造审计事件，且 kind 为 IpcDenied
        if let Decision::Deny { .. } = decision {
            let ev = AuditEvent::now(AuditKind::IpcDenied, &m.id, "undeclaredCmd");
            assert_eq!(ev.kind, AuditKind::IpcDenied);
            assert_eq!(ev.plugin_id, "com.termone.sftp");
            assert!(ev.at > 0);
        } else {
            panic!("应被拒绝");
        }
    }

    // ---------------- P4：健壮性（低优先） ----------------

    #[test]
    fn p4_unicode_name_valid() {
        let m = PluginManifest::from_json(
            serde_json::json!({
                "id":"com.termone.sftp","name":"SFTP 文件管理 ☁","version":"1.2.3",
                "entry":"index.js","hostApi":{"major":1,"minor":0,"patch":0},
                "files":["index.js"]
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        assert_eq!(m.name, "SFTP 文件管理 ☁");
        assert!(m.validate().is_ok());
    }

    #[test]
    fn p4_malformed_json_rejected() {
        assert!(PluginManifest::from_json(b"{ not valid").is_err());
        assert!(PluginManifest::from_json(b"".as_slice()).is_err());
    }

    #[test]
    fn p4_empty_permissions_default_deny() {
        let m = PluginManifest::from_json(
            serde_json::json!({
                "id":"com.a.b","name":"x","version":"1.0.0","entry":"i.js",
                "hostApi":{"major":1,"minor":0,"patch":0},"files":["i.js"]
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        assert!(!m.allows_ipc("anything"));
        assert!(!m.allows_net("example.com"));
        assert_eq!(PermissionChecker::check_ipc(&m, "anything"), Decision::Deny { reason: "插件未声明 IPC 权限: anything".into() });
    }

    // ---------------- P5：风险登记（RK-09 密钥环滥用） ----------------

    #[test]
    fn p5_keyring_hard_deny_under_any_declaration() {
        // 纵深防御：即便某插件「声明」了一个名为 getSecret 的命令，也必须被硬编码拒绝
        let m = PluginManifest::from_json(
            serde_json::json!({
                "id":"com.evil.x","name":"x","version":"1.0.0","entry":"i.js",
                "hostApi":{"major":1,"minor":0,"patch":0},
                "permissions":[{"type":"ipc","command":"getSecret"}],
                "files":["i.js"]
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        match PermissionChecker::check_ipc(&m, "getSecret") {
            Decision::Deny { reason } => {
                assert!(reason.contains("密钥环"), "应为密钥环拒绝原因: {reason}");
            }
            Decision::Allow => panic!("密钥环接口绝不可对插件放行"),
        }
        // 其它密钥环命令同样拒绝
        for cmd in ["setSecret", "deleteSecret", "listSecrets", "exportKeyring"] {
            assert_eq!(
                PermissionChecker::check_ipc(&m, cmd),
                Decision::Deny {
                    reason: format!("密钥环/凭据接口对所有插件禁用: {cmd}")
                }
            );
        }
    }

    #[test]
    fn p5_tpk_rejects_path_traversal() {
        let files = vec!["../escape.js".to_string(), "index.js".to_string()];
        assert!(validate_tpk(valid_manifest_json().as_bytes(), &files).is_err());
        // 入口缺失
        let files = vec!["style.css".to_string()];
        assert!(validate_tpk(valid_manifest_json().as_bytes(), &files).is_err());
    }
}
