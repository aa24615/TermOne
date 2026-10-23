//! TermOne 核心库：本地 PTY / SSH / 串口会话、SQLite 存储与系统密钥环。

pub mod error;
pub mod plugin;
pub mod reconnect;
pub mod secrets;
pub mod session;
pub mod storage;

pub use error::{Result, TermError};
pub use plugin::{
    validate_tpk, AuditEvent, AuditKind, Decision, HostApiVersion, PermissionChecker, PluginManifest,
    PluginPermission, PluginState,
};
pub use reconnect::{KeepAlivePolicy, ReconnectPolicy};
pub use session::{
    default_shell, list_ports, list_shells, ExitSink, OutputSink, PortInfo, SftpAuth, SftpEntry,
    SftpRequest, ShellInfo, SessionId, SessionInfo, SessionKind, SessionManager,
    SessionRequest, SshAuth,
};
pub use storage::{
    BackupStats, Db, GroupRow, PluginRow, ProfileRow, SettingRow, SnippetRow, SyncItem,
};
