//! Local application lock. Kept outside the sync/backup database.
use crate::state::AppState;
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockStatus {
    pub enabled: bool,
    pub locked: bool,
    pub retry_after_seconds: u64,
    pub revision: u64,
}

pub struct ScreenLock {
    db: Connection,
    hash: Option<String>,
    locked: bool,
    failures: u32,
    retry_at: Option<Instant>,
    revision: u64,
}

impl ScreenLock {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS screen_lock (id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL);")
            .map_err(|e| e.to_string())?;
        let hash: Option<String> = db
            .query_row("SELECT hash FROM screen_lock WHERE id=1", [], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(hash) = &hash {
            let parsed = PasswordHash::new(hash).map_err(|_| "锁屏密码数据损坏，无法安全启动")?;
            if parsed.algorithm.as_str() != "argon2id" {
                return Err("不支持的锁屏密码格式".into());
            }
        }
        Ok(Self {
            locked: hash.is_some(),
            db,
            hash,
            failures: 0,
            retry_at: None,
            revision: 0,
        })
    }

    pub fn status(&self) -> LockStatus {
        let retry_after_seconds = self
            .retry_at
            .map(|at| at.saturating_duration_since(Instant::now()))
            .filter(|d| !d.is_zero())
            .map(|d| d.as_secs() + 1)
            .unwrap_or(0);
        LockStatus {
            enabled: self.hash.is_some(),
            locked: self.locked,
            retry_after_seconds,
            revision: self.revision,
        }
    }

    pub fn allows(&self, command: &str) -> bool {
        !self.locked
            || matches!(
                command,
                "screen_lock_status" | "screen_lock_unlock" | "screen_lock_now"
            )
    }

    fn verify(&mut self, password: &str) -> Result<()> {
        if self.status().retry_after_seconds > 0 {
            return Err("尝试次数过多，请稍后重试".into());
        }
        let hash = self.hash.as_ref().ok_or("尚未设置锁屏密码")?;
        let parsed = PasswordHash::new(hash).map_err(|_| "锁屏密码数据损坏")?;
        if password.len() <= 512
            && Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        {
            self.failures = 0;
            self.retry_at = None;
            return Ok(());
        }
        self.failures += 1;
        self.revision += 1;
        if self.failures >= 5 {
            self.retry_at = Some(Instant::now() + Duration::from_secs(30));
            self.failures = 0;
        }
        Err("锁屏密码不正确".into())
    }

    pub fn configure(&mut self, current: &str, new_password: Option<&str>) -> Result<LockStatus> {
        if self.locked {
            return Err("请先解锁 TermOne".into());
        }
        if self.hash.is_some() {
            self.verify(current)?;
        }
        let hash = match new_password {
            Some(password) => {
                if !(6..=128).contains(&password.chars().count()) || password.len() > 512 {
                    return Err("锁屏密码需要 6–128 个字符".into());
                }
                let salt = SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes())
                    .map_err(|e| e.to_string())?;
                Some(
                    Argon2::default()
                        .hash_password(password.as_bytes(), &salt)
                        .map_err(|e| e.to_string())?
                        .to_string(),
                )
            }
            None => None,
        };
        if let Some(hash) = &hash {
            self.db.execute("INSERT INTO screen_lock(id,hash) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash", [hash])
                .map_err(|e| e.to_string())?;
        } else {
            self.db
                .execute("DELETE FROM screen_lock WHERE id=1", [])
                .map_err(|e| e.to_string())?;
        }
        self.hash = hash;
        self.failures = 0;
        self.retry_at = None;
        self.revision += 1;
        Ok(self.status())
    }

    pub fn lock(&mut self) -> Result<LockStatus> {
        if self.hash.is_none() {
            return Err("请先在设置中设置锁屏密码".into());
        }
        self.locked = true;
        self.revision += 1;
        Ok(self.status())
    }

    pub fn unlock(&mut self, password: &str) -> Result<LockStatus> {
        if self.locked {
            self.verify(password)?;
            self.locked = false;
            self.revision += 1;
        }
        Ok(self.status())
    }
}

#[tauri::command]
pub async fn screen_lock_status(state: State<'_, AppState>) -> Result<LockStatus> {
    Ok(state
        .screen_lock
        .lock()
        .map_err(|e| e.to_string())?
        .status())
}

#[tauri::command]
pub async fn screen_lock_now(app: AppHandle) -> Result<LockStatus> {
    let status = app
        .state::<AppState>()
        .screen_lock
        .lock()
        .map_err(|e| e.to_string())?
        .lock()?;
    let _ = app.emit("screen-lock:changed", status.clone());
    Ok(status)
}

#[tauri::command]
pub async fn screen_lock_unlock(app: AppHandle, password: String) -> Result<LockStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut lock = state.screen_lock.lock().map_err(|e| e.to_string())?;
        let result = lock.unlock(&password);
        let _ = app.emit("screen-lock:changed", lock.status());
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn screen_lock_configure(
    app: AppHandle,
    window: WebviewWindow,
    current_password: String,
    new_password: Option<String>,
) -> Result<LockStatus> {
    if window.label() != "main" {
        return Err("请在主窗口设置锁屏密码".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut lock = state.screen_lock.lock().map_err(|e| e.to_string())?;
        let result = lock.configure(&current_password, new_password.as_deref());
        let _ = app.emit("screen-lock:changed", lock.status());
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("termone-lock-{}.db", uuid::Uuid::new_v4()))
    }

    #[test]
    fn password_lifecycle_persists_and_never_stores_plaintext() {
        let path = path();
        let mut lock = ScreenLock::open(&path).unwrap();
        assert!(!lock.status().enabled);
        assert!(lock.lock().is_err());
        assert!(lock.configure("", Some("short")).is_err());
        lock.configure("", Some("lock-fixture-123")).unwrap();
        assert!(!lock.status().locked);
        let hash: String = lock
            .db
            .query_row("SELECT hash FROM screen_lock", [], |r| r.get(0))
            .unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(!hash.contains("lock-fixture-123"));
        lock.lock().unwrap();
        assert!(lock.configure("lock-fixture-123", None).is_err());
        assert!(lock.unlock("wrong").is_err());
        assert!(lock.status().locked);
        lock.unlock("lock-fixture-123").unwrap();
        assert!(lock.configure("wrong", Some("new-fixture-456")).is_err());
        lock.configure("lock-fixture-123", Some("new-fixture-456"))
            .unwrap();
        drop(lock);
        let mut lock = ScreenLock::open(&path).unwrap();
        assert!(lock.status().locked);
        assert!(lock.unlock("lock-fixture-123").is_err());
        lock.unlock("new-fixture-456").unwrap();
        assert!(lock.configure("wrong", None).is_err());
        lock.configure("new-fixture-456", None).unwrap();
        drop(lock);
        assert!(!ScreenLock::open(&path).unwrap().status().enabled);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn locked_dispatch_denies_data_and_execution_and_throttles_password_attempts() {
        let path = path();
        let mut lock = ScreenLock::open(&path).unwrap();
        lock.configure("", Some("lock-fixture-123")).unwrap();
        lock.lock().unwrap();
        for command in [
            "session_write",
            "session_open",
            "plugin_call",
            "profile_list",
            "settings_all",
            "backup_import",
            "screen_lock_configure",
            "application_open",
        ] {
            assert!(!lock.allows(command), "{command}");
        }
        for command in [
            "screen_lock_status",
            "screen_lock_now",
            "screen_lock_unlock",
        ] {
            assert!(lock.allows(command));
        }
        for _ in 0..5 {
            assert!(lock.unlock("wrong").is_err());
        }
        assert!(lock.status().retry_after_seconds > 0);
        assert!(lock.unlock("lock-fixture-123").is_err());
        lock.retry_at = Some(Instant::now() - Duration::from_secs(1));
        lock.unlock("lock-fixture-123").unwrap();
        assert_eq!(lock.status().retry_after_seconds, 0);
        assert!(lock.allows("session_write"));
        drop(lock);
        let _ = std::fs::remove_file(path);
    }
}
