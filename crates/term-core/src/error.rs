use thiserror::Error;

#[derive(Debug, Error)]
pub enum TermError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("pty error: {0}")]
    Pty(String),
    #[error("serial error: {0}")]
    Serial(String),
    #[error("keyring error: {0}")]
    Keyring(String),
    #[error("session not found: {0}")]
    SessionNotFound(String),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, TermError>;
