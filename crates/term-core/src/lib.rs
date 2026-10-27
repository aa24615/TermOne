//! TermOne 核心库：本地 PTY / SSH / 串口会话、SQLite 存储与系统密钥环。

pub mod error;
pub mod metrics;
pub mod history;
pub mod plugin;
pub mod reconnect;
pub mod safety;
pub mod snippet_vars;
pub mod secrets;
pub mod session;
pub mod storage;
pub mod ssh_import;

pub use error::{Result, TermError};
pub use metrics::{
    CpuSnapshot, DiskUsage, LoadAvg, MemInfo, MemorySnapshot, NetInterface, NetRate, SizeUnit,
    TopSnapshot,
};
pub use history::{matches_query, search_history, HistoryEntry, HistoryQuery};
pub use plugin::{
    validate_tpk, AuditEvent, AuditKind, Decision, HostApiVersion, PermissionChecker, PluginManifest,
    PluginPermission, PluginState,
};
pub use reconnect::{KeepAlivePolicy, ReconnectPolicy};
pub use safety::{CommandCheck, RiskLevel, RiskReason};
pub use snippet_vars::{expand_snippet, expand_snippet_with, ExpandError, ExpandMode, SnippetContext};
pub use session::{
    default_shell, list_ports, list_shells, ExitSink, OutputSink, PortInfo, SftpAuth, SftpEntry,
    SftpRequest, ShellInfo, SessionId, SessionInfo, SessionKind, SessionManager,
    SessionRequest, SshAuth,
};
pub use storage::{
    BackupStats, Db, GroupRow, PluginRow, ProfileRow, SettingRow, SnippetRow, SnippetGroup, SyncItem,
};
