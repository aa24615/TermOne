//! TermOne 核心库：本地 PTY / SSH / 串口会话、SQLite 存储与系统密钥环。

pub mod error;
pub mod secrets;
pub mod session;
pub mod storage;

pub use error::{Result, TermError};
pub use session::{
    default_shell, list_ports, ExitSink, OutputSink, PortInfo, SessionId, SessionInfo,
    SessionKind, SessionManager, SessionRequest, SshAuth,
};
pub use storage::{BackupStats, Db, ProfileRow, SettingRow, SyncItem};
