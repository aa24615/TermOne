//! 基于 OS 密钥环的机密存储（Windows Credential Manager / macOS Keychain /
//! Linux Secret Service）。SSH 密码、密钥口令等敏感信息只在本地保存，绝不随配置同步。

use crate::error::{Result, TermError};

const SERVICE: &str = "termone";

fn entry(account: &str) -> std::result::Result<keyring::Entry, TermError> {
    keyring::Entry::new(SERVICE, account).map_err(|e| TermError::Keyring(e.to_string()))
}

/// 机密的 keyring 账户名，例如 `profile:<uuid>:password`。
pub fn secret_account(profile_id: &str, field: &str) -> String {
    format!("profile:{profile_id}:{field}")
}

pub fn set_secret(account: &str, value: &str) -> Result<()> {
    entry(account)?
        .set_password(value)
        .map_err(|e| TermError::Keyring(e.to_string()))
}

pub fn get_secret(account: &str) -> Result<Option<String>> {
    match entry(account)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(TermError::Keyring(e.to_string())),
    }
}

pub fn delete_secret(account: &str) -> Result<()> {
    match entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(TermError::Keyring(e.to_string())),
    }
}
