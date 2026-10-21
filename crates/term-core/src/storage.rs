//! 本地 SQLite 存储：连接档案、应用设置与同步游标。
//!
//! 所有行都带有 `updated_at` / `dirty` / `deleted` 标记，
//! 用于支撑「最后写入胜出（LWW）」的云同步协议。

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::{Result, TermError};

pub fn default_db_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("termone")
        .join("termone.db")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRow {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub config: serde_json::Value,
    pub sort_order: i64,
    pub updated_at: i64,
    pub created_at: i64,
    pub deleted: bool,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingRow {
    pub key: String,
    pub value: String,
    pub updated_at: i64,
    pub dirty: bool,
}

/// 同步协议中的单个变更项。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncItem {
    pub item_id: String,
    /// "profile" | "setting"
    pub kind: String,
    #[serde(default)]
    pub key: Option<String>,
    /// JSON 负载（profile 为对象序列化，setting 为原始字符串值）
    pub data: String,
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: bool,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS profiles (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    config     TEXT NOT NULL DEFAULT '{}',
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    dirty      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    dirty      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open() -> Result<Db> {
        Self::open_at(default_db_path())
    }

    pub fn open_at(path: PathBuf) -> Result<Db> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(TermError::Io)?;
        }
        let conn = Connection::open(&path).map_err(TermError::Db)?;
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        conn.execute_batch(SCHEMA).map_err(TermError::Db)?;
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    // ---------------- profiles ----------------

    pub fn profile_list(&self) -> Result<Vec<ProfileRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, name, config, sort_order, updated_at, created_at, deleted, dirty
                 FROM profiles WHERE deleted = 0
                 ORDER BY sort_order ASC, name ASC",
            )
            .map_err(TermError::Db)?;
        let rows = stmt
            .query_map([], |row| {
                let config_raw: String = row.get(3)?;
                Ok(ProfileRow {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    name: row.get(2)?,
                    config: serde_json::from_str(&config_raw).unwrap_or(serde_json::Value::Null),
                    sort_order: row.get(4)?,
                    updated_at: row.get(5)?,
                    created_at: row.get(6)?,
                    deleted: row.get::<_, i64>(7)? != 0,
                    dirty: row.get::<_, i64>(8)? != 0,
                })
            })
            .map_err(TermError::Db)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(TermError::Db)?);
        }
        Ok(out)
    }

    /// 新增或更新档案。`updated_at` 由本地时间决定，`dirty` 置 1 等待推送。
    pub fn profile_save(&self, mut p: ProfileRow) -> Result<ProfileRow> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<i64> = conn
            .query_row(
                "SELECT created_at FROM profiles WHERE id = ?1",
                params![p.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(TermError::Db)?;
        let now = now_ms();
        p.created_at = match existing {
            Some(created) => created,
            None if p.created_at > 0 => p.created_at,
            None => now,
        };
        p.updated_at = now;
        p.dirty = true;
        let config_raw = serde_json::to_string(&p.config).unwrap_or_else(|_| "{}".into());
        conn.execute(
            "INSERT INTO profiles (id, kind, name, config, sort_order, updated_at, created_at, deleted, dirty)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind, name = excluded.name, config = excluded.config,
               sort_order = excluded.sort_order, updated_at = excluded.updated_at,
               created_at = excluded.created_at, deleted = excluded.deleted, dirty = 1",
            params![
                p.id,
                p.kind,
                p.name,
                config_raw,
                p.sort_order,
                p.updated_at,
                p.created_at,
                p.deleted as i64
            ],
        )
        .map_err(TermError::Db)?;
        Ok(p)
    }

    /// 软删除：保留行用于向其他设备传播删除操作。
    pub fn profile_delete(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE profiles SET deleted = 1, dirty = 1, updated_at = ?1 WHERE id = ?2",
            params![now_ms(), id],
        )
        .map_err(TermError::Db)?;
        Ok(())
    }

    // ---------------- settings ----------------

    pub fn settings_all(&self) -> Result<Vec<SettingRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT key, value, updated_at, dirty FROM settings ORDER BY key")
            .map_err(TermError::Db)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SettingRow {
                    key: row.get(0)?,
                    value: row.get(1)?,
                    updated_at: row.get(2)?,
                    dirty: row.get::<_, i64>(3)? != 0,
                })
            })
            .map_err(TermError::Db)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(TermError::Db)?);
        }
        Ok(out)
    }

    pub fn setting_set(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value, updated_at, dirty) VALUES (?1, ?2, ?3, 1)
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3, dirty = 1",
            params![key, value, now_ms()],
        )
        .map_err(TermError::Db)?;
        Ok(())
    }

    // ---------------- sync ----------------

    /// 导出所有待推送（dirty）的变更。
    pub fn sync_export_dirty(&self) -> Result<Vec<SyncItem>> {
        let conn = self.conn.lock().unwrap();
        let mut items = Vec::new();
        {
            let mut stmt = conn
                .prepare("SELECT id, kind, name, config, sort_order, updated_at, deleted FROM profiles WHERE dirty = 1")
                .map_err(TermError::Db)?;
            let rows = stmt
                .query_map([], |row| {
                    let config_raw: String = row.get(3)?;
                    let payload = serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "kind": row.get::<_, String>(1)?,
                        "name": row.get::<_, String>(2)?,
                        "config": serde_json::from_str::<serde_json::Value>(&config_raw)
                            .unwrap_or(serde_json::Value::Null),
                        "sortOrder": row.get::<_, i64>(4)?,
                    });
                    Ok(SyncItem {
                        item_id: row.get(0)?,
                        kind: "profile".into(),
                        key: None,
                        data: payload.to_string(),
                        updated_at: row.get(5)?,
                        deleted: row.get::<_, i64>(6)? != 0,
                    })
                })
                .map_err(TermError::Db)?;
            for r in rows {
                items.push(r.map_err(TermError::Db)?);
            }
        }
        {
            let mut stmt = conn
                .prepare("SELECT key, value, updated_at FROM settings WHERE dirty = 1")
                .map_err(TermError::Db)?;
            let rows = stmt
                .query_map([], |row| {
                    let key: String = row.get(0)?;
                    Ok(SyncItem {
                        item_id: format!("setting:{key}"),
                        kind: "setting".into(),
                        key: Some(key),
                        data: row.get(1)?,
                        updated_at: row.get(2)?,
                        deleted: false,
                    })
                })
                .map_err(TermError::Db)?;
            for r in rows {
                items.push(r.map_err(TermError::Db)?);
            }
        }
        Ok(items)
    }

    /// 应用服务端下发的变更（LWW：远端 updated_at 更新才覆盖），返回应用条数。
    pub fn sync_apply_pull(&self, items: &[SyncItem]) -> Result<u32> {
        let conn = self.conn.lock().unwrap();
        let mut applied = 0u32;
        for item in items {
            match item.kind.as_str() {
                "profile" => {
                    let payload: serde_json::Value = match serde_json::from_str(&item.data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let id = item.item_id.clone();
                    let kind = payload
                        .get("kind")
                        .and_then(|v| v.as_str())
                        .unwrap_or("local")
                        .to_string();
                    let name = payload
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("未命名")
                        .to_string();
                    let config = payload.get("config").cloned().unwrap_or(serde_json::json!({}));
                    let sort_order = payload
                        .get("sortOrder")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let local_updated: Option<i64> = conn
                        .query_row(
                            "SELECT updated_at FROM profiles WHERE id = ?1",
                            params![id],
                            |r| r.get(0),
                        )
                        .optional()
                        .map_err(TermError::Db)?;
                    if let Some(t) = local_updated {
                        if t >= item.updated_at {
                            continue;
                        }
                    }
                    let config_raw = config.to_string();
                    let created = local_updated.map_or(now_ms(), |_| 0);
                    conn.execute(
                        "INSERT INTO profiles (id, kind, name, config, sort_order, updated_at, created_at, deleted, dirty)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)
                         ON CONFLICT(id) DO UPDATE SET
                           kind = ?2, name = ?3, config = ?4, sort_order = ?5,
                           updated_at = ?6, deleted = ?8, dirty = 0",
                        params![id, kind, name, config_raw, sort_order, item.updated_at, created, item.deleted as i64],
                    )
                    .map_err(TermError::Db)?;
                    applied += 1;
                }
                "setting" => {
                    let Some(key) = item.key.clone() else {
                        continue;
                    };
                    let local_updated: Option<i64> = conn
                        .query_row(
                            "SELECT updated_at FROM settings WHERE key = ?1",
                            params![key],
                            |r| r.get(0),
                        )
                        .optional()
                        .map_err(TermError::Db)?;
                    if let Some(t) = local_updated {
                        if t >= item.updated_at {
                            continue;
                        }
                    }
                    conn.execute(
                        "INSERT INTO settings (key, value, updated_at, dirty) VALUES (?1, ?2, ?3, 0)
                         ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3, dirty = 0",
                        params![key, item.data, item.updated_at],
                    )
                    .map_err(TermError::Db)?;
                    applied += 1;
                }
                _ => {}
            }
        }
        Ok(applied)
    }

    /// 推送成功后清除 dirty 标记（仅当本地在此期间未再修改）。
    pub fn sync_mark_pushed(&self, items: &[SyncItem]) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        for item in items {
            match item.kind.as_str() {
                "profile" => {
                    conn.execute(
                        "UPDATE profiles SET dirty = 0 WHERE id = ?1 AND updated_at <= ?2",
                        params![item.item_id, item.updated_at],
                    )
                    .map_err(TermError::Db)?;
                }
                "setting" => {
                    if let Some(key) = &item.key {
                        conn.execute(
                            "UPDATE settings SET dirty = 0 WHERE key = ?1 AND updated_at <= ?2",
                            params![key, item.updated_at],
                        )
                        .map_err(TermError::Db)?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    pub fn sync_last_pull(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let v: Option<String> = conn
            .query_row(
                "SELECT value FROM sync_state WHERE key = 'last_pull'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(TermError::Db)?;
        Ok(v.and_then(|s| s.parse().ok()).unwrap_or(0))
    }

    pub fn sync_set_last_pull(&self, ts: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sync_state (key, value) VALUES ('last_pull', ?1)
             ON CONFLICT(key) DO UPDATE SET value = ?1",
            params![ts.to_string()],
        )
        .map_err(TermError::Db)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db() -> Db {
        let path = std::env::temp_dir().join(format!("termone-test-{}.db", uuid::Uuid::new_v4()));
        Db::open_at(path).unwrap()
    }

    #[test]
    fn profile_roundtrip() {
        let db = tmp_db();
        let p = ProfileRow {
            id: uuid::Uuid::new_v4().to_string(),
            kind: "ssh".into(),
            name: "test".into(),
            config: serde_json::json!({ "host": "example.com", "port": 22 }),
            sort_order: 0,
            updated_at: 0,
            created_at: 0,
            deleted: false,
            dirty: false,
        };
        let saved = db.profile_save(p).unwrap();
        assert!(saved.dirty);
        assert!(saved.updated_at > 0);

        let list = db.profile_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].config["host"], "example.com");

        db.profile_delete(&saved.id).unwrap();
        assert!(db.profile_list().unwrap().is_empty());

        let dirty = db.sync_export_dirty().unwrap();
        assert_eq!(dirty.len(), 1);
        assert!(dirty[0].deleted);
    }

    #[test]
    fn lww_merge() {
        let db = tmp_db();
        let item = SyncItem {
            item_id: uuid::Uuid::new_v4().to_string(),
            kind: "profile".into(),
            key: None,
            data: serde_json::json!({
                "kind": "local", "name": "from-server", "config": {}, "sortOrder": 1
            })
            .to_string(),
            updated_at: 1000,
            deleted: false,
        };
        assert_eq!(db.sync_apply_pull(std::slice::from_ref(&item)).unwrap(), 1);
        // 更旧/相同时间戳的数据不再覆盖本地
        assert_eq!(db.sync_apply_pull(std::slice::from_ref(&item)).unwrap(), 0);
    }

    #[test]
    fn settings_roundtrip() {
        let db = tmp_db();
        db.setting_set("theme", "midnight").unwrap();
        db.setting_set("theme", "nord").unwrap();
        let all = db.settings_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].value, "nord");
        assert!(all[0].dirty);

        let dirty = db.sync_export_dirty().unwrap();
        assert_eq!(dirty.len(), 1);
        assert_eq!(dirty[0].key.as_deref(), Some("theme"));
        db.sync_mark_pushed(&dirty).unwrap();
        assert!(db.sync_export_dirty().unwrap().is_empty());
    }
}
