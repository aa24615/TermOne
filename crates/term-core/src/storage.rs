//! 本地 SQLite 存储：连接档案、分组、应用设置与同步游标。
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
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub last_used_at: i64,
    pub sort_order: i64,
    pub updated_at: i64,
    pub created_at: i64,
    pub deleted: bool,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupRow {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
    pub collapsed: bool,
    pub updated_at: i64,
    pub created_at: i64,
    pub deleted: bool,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetRow {
    pub id: String,
    pub title: String,
    pub body: String,
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
    /// "profile" | "setting" | "group"
    pub kind: String,
    #[serde(default)]
    pub key: Option<String>,
    /// JSON 负载（profile/group 为对象序列化，setting 为原始字符串值）
    pub data: String,
    pub updated_at: i64,
    #[serde(default)]
    pub deleted: bool,
}

/// 备份/导入的统计信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStats {
    pub profiles: u32,
    pub groups: u32,
    pub snippets: u32,
    pub settings: u32,
}

const BACKUP_KIND: &str = "termone-backup";
const BACKUP_VERSION: u32 = 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupFile<'a> {
    app: &'a str,
    kind: &'a str,
    version: u32,
    exported_at: i64,
    profiles: &'a [ProfileRow],
    groups: &'a [GroupRow],
    snippets: &'a [SnippetRow],
    settings: &'a [SettingRow],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFileOwned {
    #[serde(default)]
    profiles: Vec<ProfileRow>,
    #[serde(default)]
    groups: Vec<GroupRow>,
    #[serde(default)]
    snippets: Vec<SnippetRow>,
    #[serde(default)]
    settings: Vec<SettingRow>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS profiles (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    config     TEXT NOT NULL DEFAULT '{}',
    group_id   TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL DEFAULT 0,
    deleted    INTEGER NOT NULL DEFAULT 0,
    dirty      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    parent_id  TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    collapsed  INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS snippets (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    dirty      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

/// 为存量数据库补充新列（兼容旧版本 termone.db）。
fn ensure_column(conn: &Connection, table: &str, col: &str, def: &str) -> Result<()> {
    let exists: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{col}'"),
            [],
            |r| r.get(0),
        )
        .map_err(TermError::Db)?;
    if exists == 0 {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {col} {def}"),
            [],
        )
        .map_err(TermError::Db)?;
    }
    Ok(())
}

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
        ensure_column(&conn, "profiles", "group_id", "TEXT")?;
        ensure_column(&conn, "profiles", "last_used_at", "INTEGER NOT NULL DEFAULT 0")?;
        let db = Db {
            conn: Mutex::new(conn),
        };
        Ok(db)
    }

    // ---------------- profiles ----------------

    pub fn profile_list(&self) -> Result<Vec<ProfileRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, kind, name, config, sort_order, group_id, updated_at, created_at, last_used_at, deleted, dirty
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
                    group_id: row.get(5)?,
                    sort_order: row.get(4)?,
                    updated_at: row.get(6)?,
                    created_at: row.get(7)?,
                    last_used_at: row.get(8)?,
                    deleted: row.get::<_, i64>(9)? != 0,
                    dirty: row.get::<_, i64>(10)? != 0,
                })
            })
            .map_err(TermError::Db)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(TermError::Db)?);
        }
        Ok(out)
    }

    /// 跨分组搜索：匹配档案名、主机、用户或所属分组名。
    pub fn profile_search(&self, keyword: &str) -> Result<Vec<ProfileRow>> {
        let kw = keyword.trim().to_lowercase();
        let all = self.profile_list()?;
        if kw.is_empty() {
            return Ok(all);
        }
        let groups = self.group_list()?;
        let group_name = |gid: &Option<String>| -> String {
            gid.as_ref()
                .and_then(|id| groups.iter().find(|g| &g.id == id))
                .map(|g| g.name.to_lowercase())
                .unwrap_or_default()
        };
        Ok(all
            .into_iter()
            .filter(|p| {
                let host = p
                    .config
                    .get("host")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_lowercase();
                let user = p
                    .config
                    .get("user")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_lowercase();
                p.name.to_lowercase().contains(&kw)
                    || host.contains(&kw)
                    || user.contains(&kw)
                    || group_name(&p.group_id).contains(&kw)
            })
            .collect())
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
            "INSERT INTO profiles (id, kind, name, config, group_id, sort_order, updated_at, created_at, last_used_at, deleted, dirty)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1)
             ON CONFLICT(id) DO UPDATE SET
               kind = excluded.kind, name = excluded.name, config = excluded.config,
               group_id = excluded.group_id, sort_order = excluded.sort_order,
               updated_at = excluded.updated_at, created_at = excluded.created_at,
               last_used_at = excluded.last_used_at, deleted = excluded.deleted, dirty = 1",
            params![
                p.id,
                p.kind,
                p.name,
                config_raw,
                p.group_id,
                p.sort_order,
                p.updated_at,
                p.created_at,
                p.last_used_at,
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

    /// 记录一次会话使用，更新最近使用时间戳。
    /// 注意：touch 不置 dirty，避免把本地使用记录误触发云同步。
    pub fn profile_touch(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE profiles SET last_used_at = ?1 WHERE id = ?2",
            params![now_ms(), id],
        )
        .map_err(TermError::Db)?;
        Ok(())
    }

    /// 最近使用过的档案（last_used_at > 0），按使用时间倒序，最多返回 `limit` 条。
    pub fn profile_list_recent(&self, limit: u32) -> Result<Vec<ProfileRow>> {
        let all = self.profile_list()?;
        let mut recent: Vec<ProfileRow> = all.into_iter().filter(|p| p.last_used_at > 0).collect();
        recent.sort_by(|a, b| {
            b.last_used_at
                .cmp(&a.last_used_at)
                .then_with(|| a.sort_order.cmp(&b.sort_order))
        });
        recent.truncate(limit as usize);
        Ok(recent)
    }

    fn profile_exists(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM profiles WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap_or(0);
        n > 0
    }

    /// 把 Shell 路径整理成稳定的档案 ID 片段。
    fn slugify_path(path: &str) -> String {
        path.chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect()
    }

    /// 根据 Shell 信息推断一个干净的默认档案名（cmd → "cmd"）。
    fn shell_default_name(sh: &crate::session::ShellInfo) -> String {
        let p = sh.path.to_lowercase();
        if p.ends_with("cmd.exe") || p == "cmd" {
            "cmd".into()
        } else if p.contains("git") && p.contains("bash") {
            "Git Bash".into()
        } else if p.contains("pwsh") {
            "PowerShell 7".into()
        } else if p.contains("powershell") {
            "PowerShell".into()
        } else if p.contains("nu.exe") || p.ends_with("nu") {
            "Nushell".into()
        } else if p.contains("wsl") {
            "WSL".into()
        } else if let Some(stem) = std::path::Path::new(&sh.path).file_stem() {
            stem.to_string_lossy().into_owned()
        } else {
            sh.name.clone()
        }
    }

    /// 首次启动时，为系统自带 Shell（CMD / Git Bash / PowerShell 等）初始化默认档案，
    /// 并归入「系统终端」分组，做到开箱即用。幂等：分组已存在则跳过。
    pub fn seed_system_profiles(&self) -> Result<()> {
        {
            let conn = self.conn.lock().unwrap();
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM groups WHERE id = 'system' AND deleted = 0",
                    [],
                    |r| r.get(0),
                )
                .map_err(TermError::Db)?;
            if exists > 0 {
                return Ok(());
            }
        }

        self.group_create("system".into(), "系统终端".into(), None, 0)?;

        let shells = crate::session::list_shells();
        let mut sort = 0i64;
        for sh in shells {
            // 跳过「默认 Shell」占位项（其路径会与具体 Shell 重复）
            if sh.name.contains("默认") {
                continue;
            }
            let id = format!("seed://{}", Self::slugify_path(&sh.path));
            if self.profile_exists(&id) {
                continue;
            }
            let profile = ProfileRow {
                id,
                kind: "local".into(),
                name: Self::shell_default_name(&sh),
                config: serde_json::json!({
                    "shell": sh.path,
                    "args": [],
                    "preset": if sh.preset == "wsl" { "wsl" } else { "shell" },
                }),
                group_id: Some("system".into()),
                sort_order: sort,
                updated_at: 0,
                created_at: 0,
                last_used_at: 0,
                deleted: false,
                dirty: true,
            };
            self.profile_save(profile)?;
            sort += 1;
        }
        Ok(())
    }

    // ---------------- groups ----------------

    pub fn group_list(&self) -> Result<Vec<GroupRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, parent_id, sort_order, collapsed, updated_at, created_at, deleted, dirty
                 FROM groups WHERE deleted = 0 ORDER BY sort_order ASC, name ASC",
            )
            .map_err(TermError::Db)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(GroupRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_id: row.get(2)?,
                    sort_order: row.get(3)?,
                    collapsed: row.get::<_, i64>(4)? != 0,
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

    /// 新建分组。返回带时间戳与 dirty 标记的行。
    pub fn group_create(
        &self,
        id: String,
        name: String,
        parent_id: Option<String>,
        sort_order: i64,
    ) -> Result<GroupRow> {
        let conn = self.conn.lock().unwrap();
        if name.trim().is_empty() {
            return Err(TermError::Other("分组名称不能为空".into()));
        }
        let now = now_ms();
        let g = GroupRow {
            id,
            name,
            parent_id,
            sort_order,
            collapsed: false,
            updated_at: now,
            created_at: now,
            deleted: false,
            dirty: true,
        };
        conn.execute(
            "INSERT INTO groups (id, name, parent_id, sort_order, collapsed, updated_at, created_at, deleted, dirty)
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, 0, 1)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, parent_id = excluded.parent_id,
               sort_order = excluded.sort_order, updated_at = excluded.updated_at, dirty = 1",
            params![g.id, g.name, g.parent_id, g.sort_order, g.updated_at, g.created_at],
        )
        .map_err(TermError::Db)?;
        Ok(g)
    }

    pub fn group_rename(&self, id: &str, name: String) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        if name.trim().is_empty() {
            return Err(TermError::Other("分组名称不能为空".into()));
        }
        conn.execute(
            "UPDATE groups SET name = ?1, updated_at = ?2, dirty = 1 WHERE id = ?3 AND deleted = 0",
            params![name, now_ms(), id],
        )
        .map_err(TermError::Db)?;
        Ok(())
    }

    pub fn group_set_collapsed(&self, id: &str, collapsed: bool) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE groups SET collapsed = ?1, updated_at = ?2, dirty = 1 WHERE id = ?3",
            params![collapsed as i64, now_ms(), id],
        )
        .map_err(TermError::Db)?;
        Ok(())
    }

    /// 删除分组：其子分组与成员档案上移到被删分组的父级，随后软删除该分组（便于同步传播）。
    pub fn group_delete(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let parent: Option<String> = conn
            .query_row(
                "SELECT parent_id FROM groups WHERE id = ?1",
                params![id],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(TermError::Db)?
            .flatten();
        conn.execute(
            "UPDATE groups SET parent_id = ?1 WHERE parent_id = ?2",
            params![parent, id],
        )
        .map_err(TermError::Db)?;
        conn.execute(
            "UPDATE profiles SET group_id = ?1, dirty = 1, updated_at = ?2 WHERE group_id = ?3",
            params![parent, now_ms(), id],
        )
        .map_err(TermError::Db)?;
        conn.execute(
            "UPDATE groups SET deleted = 1, dirty = 1, updated_at = ?1 WHERE id = ?2",
            params![now_ms(), id],
        )
        .map_err(TermError::Db)?;
        Ok(())
    }

    // ---------------- snippets ----------------

    pub fn snippet_list(&self) -> Result<Vec<SnippetRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, body, sort_order, updated_at, created_at, deleted, dirty
                 FROM snippets WHERE deleted = 0 ORDER BY sort_order ASC, title ASC",
            )
            .map_err(TermError::Db)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SnippetRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    body: row.get(2)?,
                    sort_order: row.get(3)?,
                    updated_at: row.get(4)?,
                    created_at: row.get(5)?,
                    deleted: row.get::<_, i64>(6)? != 0,
                    dirty: row.get::<_, i64>(7)? != 0,
                })
            })
            .map_err(TermError::Db)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(TermError::Db)?);
        }
        Ok(out)
    }

    /// 新增或更新片段。返回带时间戳与 dirty 标记的行。
    pub fn snippet_save(&self, mut s: SnippetRow) -> Result<SnippetRow> {
        let conn = self.conn.lock().unwrap();
        let existing: Option<i64> = conn
            .query_row(
                "SELECT created_at FROM snippets WHERE id = ?1",
                params![s.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(TermError::Db)?;
        let now = now_ms();
        s.created_at = match existing {
            Some(created) => created,
            None if s.created_at > 0 => s.created_at,
            None => now,
        };
        s.updated_at = now;
        s.dirty = true;
        conn.execute(
            "INSERT INTO snippets (id, title, body, sort_order, updated_at, created_at, deleted, dirty)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title, body = excluded.body, sort_order = excluded.sort_order,
               updated_at = excluded.updated_at, created_at = excluded.created_at,
               deleted = excluded.deleted, dirty = 1",
            params![s.id, s.title, s.body, s.sort_order, s.updated_at, s.created_at, s.deleted as i64],
        )
        .map_err(TermError::Db)?;
        Ok(s)
    }

    /// 软删除片段（保留行用于同步传播删除）。
    pub fn snippet_delete(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE snippets SET deleted = 1, dirty = 1, updated_at = ?1 WHERE id = ?2",
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
                .prepare("SELECT id, kind, name, config, group_id, sort_order, updated_at, deleted FROM profiles WHERE dirty = 1")
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
                        "group_id": row.get::<_, Option<String>>(4)?,
                        "sortOrder": row.get::<_, i64>(5)?,
                    });
                    Ok(SyncItem {
                        item_id: row.get(0)?,
                        kind: "profile".into(),
                        key: None,
                        data: payload.to_string(),
                        updated_at: row.get(6)?,
                        deleted: row.get::<_, i64>(7)? != 0,
                    })
                })
                .map_err(TermError::Db)?;
            for r in rows {
                items.push(r.map_err(TermError::Db)?);
            }
        }
        {
            let mut stmt = conn
                .prepare("SELECT id, name, parent_id, sort_order, collapsed, updated_at, deleted FROM groups WHERE dirty = 1")
                .map_err(TermError::Db)?;
            let rows = stmt
                .query_map([], |row| {
                    let payload = serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "name": row.get::<_, String>(1)?,
                        "parentId": row.get::<_, Option<String>>(2)?,
                        "sortOrder": row.get::<_, i64>(3)?,
                        "collapsed": row.get::<_, i64>(4)? != 0,
                    });
                    Ok(SyncItem {
                        item_id: row.get(0)?,
                        kind: "group".into(),
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
        {
            let mut stmt = conn
                .prepare("SELECT id, title, body, sort_order, updated_at, deleted FROM snippets WHERE dirty = 1")
                .map_err(TermError::Db)?;
            let rows = stmt
                .query_map([], |row| {
                    let payload = serde_json::json!({
                        "id": row.get::<_, String>(0)?,
                        "title": row.get::<_, String>(1)?,
                        "body": row.get::<_, String>(2)?,
                        "sortOrder": row.get::<_, i64>(3)?,
                    });
                    Ok(SyncItem {
                        item_id: row.get(0)?,
                        kind: "snippet".into(),
                        key: None,
                        data: payload.to_string(),
                        updated_at: row.get(4)?,
                        deleted: row.get::<_, i64>(5)? != 0,
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
                    let group_id = payload.get("group_id").and_then(|v| v.as_str()).map(String::from);
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
                        "INSERT INTO profiles (id, kind, name, config, group_id, sort_order, updated_at, created_at, deleted, last_used_at, dirty)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0)
                         ON CONFLICT(id) DO UPDATE SET
                           kind = ?2, name = ?3, config = ?4, group_id = ?5, sort_order = ?6,
                           updated_at = ?7, deleted = ?9, last_used_at = 0, dirty = 0",
                        params![id, kind, name, config_raw, group_id, sort_order, item.updated_at, created, item.deleted as i64],
                    )
                    .map_err(TermError::Db)?;
                    applied += 1;
                }
                "group" => {
                    let payload: serde_json::Value = match serde_json::from_str(&item.data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let id = item.item_id.clone();
                    let name = payload
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("未命名")
                        .to_string();
                    let parent_id = payload
                        .get("parentId")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    let sort_order = payload
                        .get("sortOrder")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let collapsed = payload
                        .get("collapsed")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let local_updated: Option<i64> = conn
                        .query_row(
                            "SELECT updated_at FROM groups WHERE id = ?1",
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
                    let created = local_updated.map_or(now_ms(), |_| 0);
                    conn.execute(
                        "INSERT INTO groups (id, name, parent_id, sort_order, collapsed, updated_at, created_at, deleted, dirty)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)
                         ON CONFLICT(id) DO UPDATE SET
                           name = ?2, parent_id = ?3, sort_order = ?4, collapsed = ?5,
                           updated_at = ?6, deleted = ?8, dirty = 0",
                        params![id, name, parent_id, sort_order, collapsed as i64, item.updated_at, created, item.deleted as i64],
                    )
                    .map_err(TermError::Db)?;
                    applied += 1;
                }
                "snippet" => {
                    let payload: serde_json::Value = match serde_json::from_str(&item.data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let id = item.item_id.clone();
                    let title = payload
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("未命名")
                        .to_string();
                    let body = payload
                        .get("body")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let sort_order = payload
                        .get("sortOrder")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let local_updated: Option<i64> = conn
                        .query_row(
                            "SELECT updated_at FROM snippets WHERE id = ?1",
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
                    let created = local_updated.map_or(now_ms(), |_| 0);
                    conn.execute(
                        "INSERT INTO snippets (id, title, body, sort_order, updated_at, created_at, deleted, dirty)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
                         ON CONFLICT(id) DO UPDATE SET
                           title = ?2, body = ?3, sort_order = ?4, updated_at = ?5, deleted = ?7, dirty = 0",
                        params![id, title, body, sort_order, item.updated_at, created, item.deleted as i64],
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
                "group" => {
                    conn.execute(
                        "UPDATE groups SET dirty = 0 WHERE id = ?1 AND updated_at <= ?2",
                        params![item.item_id, item.updated_at],
                    )
                    .map_err(TermError::Db)?;
                }
                "snippet" => {
                    conn.execute(
                        "UPDATE snippets SET dirty = 0 WHERE id = ?1 AND updated_at <= ?2",
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

    // ---------------- 本地备份 ----------------

    /// 导出全部档案、分组与设置为 JSON 备份文件。
    /// 注意：系统密钥环中的机密（SSH 密码/口令）不会包含在备份里。
    pub fn backup_export(&self, path: &std::path::Path) -> Result<BackupStats> {
        let profiles = self.profile_list()?;
        let groups = self.group_list()?;
        let snippets = self.snippet_list()?;
        let settings = self.settings_all()?;
        let stats = BackupStats {
            profiles: profiles.len() as u32,
            groups: groups.len() as u32,
            snippets: snippets.len() as u32,
            settings: settings.len() as u32,
        };
        let file = BackupFile {
            app: "termone",
            kind: BACKUP_KIND,
            version: BACKUP_VERSION,
            exported_at: now_ms(),
            profiles: &profiles,
            groups: &groups,
            snippets: &snippets,
            settings: &settings,
        };
        let json =
            serde_json::to_string_pretty(&file).map_err(|e| TermError::Other(e.to_string()))?;
        std::fs::write(path, json).map_err(TermError::Io)?;
        Ok(stats)
    }

    /// 从备份文件导入。
    /// - `replace = false`：合并模式，按 LWW 只接受比本地更新的数据，保留本地新增；
    /// - `replace = true`：清空现有档案、分组与设置后整体恢复。
    /// 导入的数据标记 dirty，以便后续登录云同步时推送到服务端。
    pub fn backup_import(&self, path: &std::path::Path, replace: bool) -> Result<BackupStats> {
        let raw = std::fs::read_to_string(path).map_err(TermError::Io)?;
        let file: BackupFileOwned = serde_json::from_str(&raw)
            .map_err(|e| TermError::Other(format!("备份文件格式无效: {e}")))?;
        let conn = self.conn.lock().unwrap();
        let now = now_ms();
        if replace {
            conn.execute_batch(
                "DELETE FROM profiles; DELETE FROM groups; DELETE FROM snippets; DELETE FROM settings;",
            )
            .map_err(TermError::Db)?;
        }
        let mut profiles_count = 0u32;
        let mut groups_count = 0u32;
        let mut snippets_count = 0u32;
        let mut settings_count = 0u32;
        if replace {
            for p in &file.profiles {
                let config_raw =
                    serde_json::to_string(&p.config).unwrap_or_else(|_| "{}".into());
                conn.execute(
                    "INSERT INTO profiles (id, kind, name, config, group_id, sort_order, updated_at, created_at, deleted, last_used_at, dirty)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 1)",
                    params![p.id, p.kind, p.name, config_raw, p.group_id, p.sort_order, now, now, 0i64],
                )
                .map_err(TermError::Db)?;
                profiles_count += 1;
            }
            for g in &file.groups {
                conn.execute(
                    "INSERT INTO groups (id, name, parent_id, sort_order, collapsed, updated_at, created_at, deleted, dirty)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)",
                    params![g.id, g.name, g.parent_id, g.sort_order, g.collapsed as i64, now, now, 0i64],
                )
                .map_err(TermError::Db)?;
                groups_count += 1;
            }
            for s in &file.snippets {
                conn.execute(
                    "INSERT INTO snippets (id, title, body, sort_order, updated_at, created_at, deleted, dirty)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![s.id, s.title, s.body, s.sort_order, now, now, 0i64, 1i64],
                )
                .map_err(TermError::Db)?;
                snippets_count += 1;
            }
            for s in &file.settings {
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value, updated_at, dirty)
                     VALUES (?1, ?2, ?3, 1)",
                    params![s.key, s.value, now],
                )
                .map_err(TermError::Db)?;
                settings_count += 1;
            }
        } else {
            for p in &file.profiles {
                let existing: Option<i64> = conn
                    .query_row(
                        "SELECT updated_at FROM profiles WHERE id = ?1",
                        params![p.id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(TermError::Db)?;
                if existing.map_or(false, |t| t >= p.updated_at) {
                    continue;
                }
                let config_raw =
                    serde_json::to_string(&p.config).unwrap_or_else(|_| "{}".into());
                conn.execute(
                    "INSERT INTO profiles (id, kind, name, config, group_id, sort_order, updated_at, created_at, deleted, last_used_at, dirty)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 1)
                     ON CONFLICT(id) DO UPDATE SET
                       kind = ?2, name = ?3, config = ?4, group_id = ?5, sort_order = ?6,
                       updated_at = ?7, deleted = ?9, last_used_at = 0, dirty = 1",
                    params![
                        p.id,
                        p.kind,
                        p.name,
                        config_raw,
                        p.group_id,
                        p.sort_order,
                        p.updated_at,
                        p.created_at,
                        p.deleted as i64
                    ],
                )
                .map_err(TermError::Db)?;
                profiles_count += 1;
            }
            for g in &file.groups {
                let existing: Option<i64> = conn
                    .query_row(
                        "SELECT updated_at FROM groups WHERE id = ?1",
                        params![g.id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(TermError::Db)?;
                if existing.map_or(false, |t| t >= g.updated_at) {
                    continue;
                }
                conn.execute(
                    "INSERT INTO groups (id, name, parent_id, sort_order, collapsed, updated_at, created_at, deleted, dirty)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
                     ON CONFLICT(id) DO UPDATE SET
                       name = ?2, parent_id = ?3, sort_order = ?4, collapsed = ?5,
                       updated_at = ?6, deleted = ?8, dirty = 1",
                    params![
                        g.id,
                        g.name,
                        g.parent_id,
                        g.sort_order,
                        g.collapsed as i64,
                        g.updated_at,
                        g.created_at,
                        g.deleted as i64
                    ],
                )
                .map_err(TermError::Db)?;
                groups_count += 1;
            }
            for s in &file.snippets {
                let existing: Option<i64> = conn
                    .query_row(
                        "SELECT updated_at FROM snippets WHERE id = ?1",
                        params![s.id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(TermError::Db)?;
                if existing.map_or(false, |t| t >= s.updated_at) {
                    continue;
                }
                conn.execute(
                    "INSERT INTO snippets (id, title, body, sort_order, updated_at, created_at, deleted, dirty)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)
                     ON CONFLICT(id) DO UPDATE SET
                       title = ?2, body = ?3, sort_order = ?4, updated_at = ?5, deleted = ?7, dirty = 1",
                    params![
                        s.id,
                        s.title,
                        s.body,
                        s.sort_order,
                        s.updated_at,
                        s.created_at,
                        s.deleted as i64
                    ],
                )
                .map_err(TermError::Db)?;
                snippets_count += 1;
            }
            for s in &file.settings {
                let existing: Option<i64> = conn
                    .query_row(
                        "SELECT updated_at FROM settings WHERE key = ?1",
                        params![s.key],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(TermError::Db)?;
                if existing.map_or(false, |t| t >= s.updated_at) {
                    continue;
                }
                conn.execute(
                    "INSERT INTO settings (key, value, updated_at, dirty) VALUES (?1, ?2, ?3, 1)
                     ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3, dirty = 1",
                    params![s.key, s.value, s.updated_at],
                )
                .map_err(TermError::Db)?;
                settings_count += 1;
            }
        }
        Ok(BackupStats {
            profiles: profiles_count,
            groups: groups_count,
            snippets: snippets_count,
            settings: settings_count,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db() -> Db {
        let path = std::env::temp_dir().join(format!("termone-test-{}.db", uuid::Uuid::new_v4()));
        Db::open_at(path).unwrap()
    }

    fn sample_profile(id: &str, group_id: Option<&str>) -> ProfileRow {
        ProfileRow {
            id: id.into(),
            kind: "ssh".into(),
            name: id.to_string(),
            config: serde_json::json!({ "host": "example.com", "port": 22 }),
            group_id: group_id.map(String::from),
            last_used_at: 0,
            sort_order: 0,
            updated_at: 0,
            created_at: 0,
            deleted: false,
            dirty: false,
        }
    }

    #[test]
    fn profile_roundtrip() {
        let db = tmp_db();
        let p = sample_profile("p1", None);
        let saved = db.profile_save(p.clone()).unwrap();
        assert!(saved.dirty);
        assert!(saved.updated_at > 0);

        let list = db.profile_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].group_id, None);
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

    #[test]
    fn backup_roundtrip() {
        let db = tmp_db();
        db.setting_set("theme", "nord").unwrap();
        db.profile_save(sample_profile("p1", None)).unwrap();

        let path = std::env::temp_dir().join(format!("termone-bk-{}.json", uuid::Uuid::new_v4()));
        let stats = db.backup_export(&path).unwrap();
        assert_eq!(stats.profiles, 1);
        assert_eq!(stats.settings, 1);

        // 覆盖导入到全新数据库
        let db2 = tmp_db();
        let st = db2.backup_import(&path, true).unwrap();
        assert_eq!(st.profiles, 1);
        assert_eq!(st.settings, 1);
        assert_eq!(db2.profile_list().unwrap()[0].name, "p1");
        assert_eq!(db2.settings_all().unwrap()[0].value, "nord");

        // 合并模式：本地数据更新时拒绝备份中的旧数据
        db2.setting_set("theme", "midnight").unwrap();
        let st2 = db2.backup_import(&path, false).unwrap();
        assert_eq!(st2.settings, 0);
        assert_eq!(db2.settings_all().unwrap()[0].value, "midnight");
    }

    // ---------------- R-02 连接分组 / 会话树 ----------------

    #[test]
    fn group_crud_and_persistence() {
        let db = tmp_db();
        let g = db
            .group_create("g1".into(), "生产环境".into(), None, 0)
            .unwrap();
        assert!(g.dirty);
        assert!(!g.collapsed);
        assert_eq!(db.group_list().unwrap().len(), 1);

        db.group_rename("g1", "Prod".to_string()).unwrap();
        db.group_set_collapsed("g1", true).unwrap();
        let g2 = db.group_list().unwrap();
        assert_eq!(g2[0].name, "Prod");
        assert!(g2[0].collapsed);

        // 空名称拒绝
        assert!(db.group_create("g2".into(), "   ".into(), None, 1).is_err());
        assert!(db.group_rename("g1", "  ".into()).is_err());
    }

    #[test]
    fn group_nesting_and_delete_reparents() {
        let db = tmp_db();
        db.group_create("root".into(), "Root".into(), None, 0).unwrap();
        db.group_create("child".into(), "Child".into(), Some("root".into()), 1).unwrap();
        db.profile_save(sample_profile("p1", Some("child"))).unwrap();

        // 删除父分组后，子分组与成员档案上移到顶层（None）
        db.group_delete("root").unwrap();
        let groups = db.group_list().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, "child");
        // 子分组的父级上移到顶层（None）
        assert_eq!(groups[0].parent_id, None);
        // 成员档案仅在所属分组被删除时才上移；p1 属于 child，不受影响
        assert_eq!(db.profile_list().unwrap()[0].group_id, Some("child".to_string()));

        // 直接隶属于被删分组的成员档案上移到顶层
        db.profile_save(sample_profile("p_root", Some("root"))).unwrap();
        db.group_create("top".into(), "Top".into(), None, 2).unwrap();
        db.profile_save(sample_profile("p_top", Some("top"))).unwrap();
        db.group_delete("top").unwrap();
        let still_in_top = db
            .profile_list()
            .unwrap()
            .iter()
            .any(|p| p.group_id.as_deref() == Some("top"));
        assert!(!still_in_top, "被删分组的直接成员应上移到顶层");

        // 软删除后导出包含 deleted 标记
        let dirty = db.sync_export_dirty().unwrap();
        assert!(dirty.iter().any(|i| i.kind == "group" && i.item_id == "root" && i.deleted));
    }

    #[test]
    fn profile_grouping_and_search_cross_group() {
        let db = tmp_db();
        db.group_create("web".into(), "Web".into(), None, 0).unwrap();
        db.group_create("db".into(), "Database".into(), None, 1).unwrap();
        db.profile_save(sample_profile("web-1", Some("web"))).unwrap();
        let mut dbp = sample_profile("db-1", Some("db"));
        dbp.config = serde_json::json!({ "host": "10.0.0.5", "user": "admin" });
        db.profile_save(dbp).unwrap();

        // 分组内档案正确归属
        let web = db.profile_search("web-1").unwrap();
        assert_eq!(web.len(), 1);
        assert_eq!(web[0].group_id.as_deref(), Some("web"));

        // 跨分组按主机/用户检索
        assert_eq!(db.profile_search("10.0.0.5").unwrap().len(), 1);
        assert_eq!(db.profile_search("admin").unwrap().len(), 1);
        // 按分组名检索
        assert_eq!(db.profile_search("database").unwrap().len(), 1);
        // 空关键字返回全部
        assert_eq!(db.profile_search("").unwrap().len(), 2);
    }

    #[test]
    fn group_sync_lww_and_backup() {
        let db = tmp_db();
        let g = db
            .group_create("g1".into(), "G1".into(), None, 0)
            .unwrap();
        // 导出 dirty 分组
        let dirty = db.sync_export_dirty().unwrap();
        let gitem = dirty.iter().find(|i| i.kind == "group").unwrap();
        assert_eq!(gitem.item_id, "g1");
        db.sync_mark_pushed(&dirty).unwrap();
        assert!(db.sync_export_dirty().unwrap().is_empty());

        // 远端更旧的分组不覆盖本地
        let older = SyncItem {
            item_id: "g1".into(),
            kind: "group".into(),
            key: None,
            data: serde_json::json!({
                "name": "STALE", "parentId": null, "sortOrder": 0, "collapsed": false
            })
            .to_string(),
            updated_at: g.updated_at - 1000,
            deleted: false,
        };
        assert_eq!(db.sync_apply_pull(&[older]).unwrap(), 0);
        assert_eq!(db.group_list().unwrap()[0].name, "G1");

        // 远端更新的分组覆盖本地
        let newer = SyncItem {
            item_id: "g1".into(),
            kind: "group".into(),
            key: None,
            data: serde_json::json!({
                "name": "G1-new", "parentId": null, "sortOrder": 0, "collapsed": true
            })
            .to_string(),
            updated_at: g.updated_at + 1000,
            deleted: false,
        };
        assert_eq!(db.sync_apply_pull(&[newer]).unwrap(), 1);
        let gl = db.group_list().unwrap();
        assert_eq!(gl[0].name, "G1-new");
        assert!(gl[0].collapsed);

        // 备份包含分组并可在另一库恢复
        let path = std::env::temp_dir().join(format!("termone-bk-{}.json", uuid::Uuid::new_v4()));
        let st = db.backup_export(&path).unwrap();
        assert_eq!(st.groups, 1);
        let db2 = tmp_db();
        let st2 = db2.backup_import(&path, true).unwrap();
        assert_eq!(st2.groups, 1);
        assert_eq!(db2.group_list().unwrap()[0].name, "G1-new");
    }

    #[test]
    fn group_unicode_name() {
        let db = tmp_db();
        db.group_create("g1".into(), "北京☁服务器组".into(), None, 0).unwrap();
        assert_eq!(db.group_list().unwrap()[0].name, "北京☁服务器组");
    }

    // ---------------- R-07 常用命令 Snippets 片段库 ----------------

    fn sample_snippet(id: &str, title: &str, body: &str) -> SnippetRow {
        SnippetRow {
            id: id.into(),
            title: title.into(),
            body: body.into(),
            sort_order: 0,
            updated_at: 0,
            created_at: 0,
            deleted: false,
            dirty: false,
        }
    }

    #[test]
    fn snippet_crud_and_dirty() {
        let db = tmp_db();
        let saved = db.snippet_save(sample_snippet("s1", "部署", "kubectl apply -f ")).unwrap();
        assert!(saved.dirty);
        assert!(saved.updated_at > 0);
        let list = db.snippet_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "部署");
        assert_eq!(list[0].body, "kubectl apply -f ");

        // 软删除后列表不再包含
        db.snippet_delete("s1").unwrap();
        assert!(db.snippet_list().unwrap().is_empty());
        // 但同步导出仍包含已删除项，用于向其他设备传播删除
        let dirty = db.sync_export_dirty().unwrap();
        assert!(dirty.iter().any(|i| i.kind == "snippet" && i.item_id == "s1" && i.deleted));
    }

    #[test]
    fn snippet_export_mark_pushed() {
        let db = tmp_db();
        db.snippet_save(sample_snippet("s1", "v1", "echo 1")).unwrap();
        let dirty = db.sync_export_dirty().unwrap();
        assert_eq!(dirty.iter().filter(|i| i.kind == "snippet").count(), 1);
        db.sync_mark_pushed(&dirty).unwrap();
        assert!(db.sync_export_dirty().unwrap().is_empty());
    }

    #[test]
    fn snippet_sync_lww() {
        let db = tmp_db();
        // 通过 pull 以受控时间戳建立基线（updated_at=1000）
        let base = SyncItem {
            item_id: "s1".into(),
            kind: "snippet".into(),
            key: None,
            data: serde_json::json!({ "title": "base", "body": "echo base", "sortOrder": 0 }).to_string(),
            updated_at: 1000,
            deleted: false,
        };
        assert_eq!(db.sync_apply_pull(&[base.clone()]).unwrap(), 1);
        assert_eq!(db.snippet_list().unwrap()[0].title, "base");

        // 远端更旧不覆盖本地
        let older = SyncItem {
            item_id: "s1".into(),
            kind: "snippet".into(),
            key: None,
            data: serde_json::json!({ "title": "OLD", "body": "echo 0", "sortOrder": 0 }).to_string(),
            updated_at: 500,
            deleted: false,
        };
        assert_eq!(db.sync_apply_pull(&[older]).unwrap(), 0);
        assert_eq!(db.snippet_list().unwrap()[0].title, "base");

        // 远端更新覆盖本地
        let newer = SyncItem {
            item_id: "s1".into(),
            kind: "snippet".into(),
            key: None,
            data: serde_json::json!({ "title": "v2", "body": "echo 2", "sortOrder": 0 }).to_string(),
            updated_at: 2000,
            deleted: false,
        };
        assert_eq!(db.sync_apply_pull(&[newer]).unwrap(), 1);
        let s = db.snippet_list().unwrap();
        assert_eq!(s[0].title, "v2");
        assert_eq!(s[0].body, "echo 2");

        // 远端删除传播
        let del = SyncItem {
            item_id: "s1".into(),
            kind: "snippet".into(),
            key: None,
            data: serde_json::json!({ "title": "v2", "body": "echo 2", "sortOrder": 0 }).to_string(),
            updated_at: 3000,
            deleted: true,
        };
        assert_eq!(db.sync_apply_pull(&[del]).unwrap(), 1);
        assert!(db.snippet_list().unwrap().is_empty());
    }

    #[test]
    fn snippet_backup_roundtrip_and_unicode() {
        let db = tmp_db();
        let big = "🚀\n".repeat(500);
        db.snippet_save(sample_snippet("s1", "大段脚本", &big)).unwrap();
        let path = std::env::temp_dir().join(format!("termone-bk-{}.json", uuid::Uuid::new_v4()));
        let st = db.backup_export(&path).unwrap();
        assert_eq!(st.snippets, 1);

        let db2 = tmp_db();
        let st2 = db2.backup_import(&path, true).unwrap();
        assert_eq!(st2.snippets, 1);
        let restored = db2.snippet_list().unwrap();
        assert_eq!(restored[0].title, "大段脚本");
        assert_eq!(restored[0].body, "🚀\n".repeat(500));

        // 合并模式：本地更新片段不被旧备份覆盖
        db2.snippet_save(sample_snippet("s1", "本地新", "local")).unwrap();
        let st3 = db2.backup_import(&path, false).unwrap();
        assert_eq!(st3.snippets, 0);
        assert_eq!(db2.snippet_list().unwrap()[0].title, "本地新");
    }

    // ---------------- R-09 最近会话 / 连接历史 ----------------

    #[test]
    fn profile_recent_tracks_last_used() {
        let db = tmp_db();
        db.profile_save(sample_profile("a", None)).unwrap();
        db.profile_save(sample_profile("b", None)).unwrap();
        db.profile_save(sample_profile("c", None)).unwrap();

        // 未使用过的档案不进入最近列表
        assert!(db.profile_list_recent(10).unwrap().is_empty());

        // touch 后记录时间戳
        db.profile_touch("b").unwrap();
        let rec = db.profile_list_recent(10).unwrap();
        assert_eq!(rec.len(), 1);
        assert_eq!(rec[0].id, "b");
        assert!(rec[0].last_used_at > 0);
    }

    #[test]
    fn profile_recent_ordering_and_limit() {
        let db = tmp_db();
        db.profile_save(sample_profile("a", None)).unwrap();
        db.profile_save(sample_profile("b", None)).unwrap();
        db.profile_save(sample_profile("c", None)).unwrap();

        // 依次使用 a -> c -> b，最近使用顺序应为 b, c, a
        db.profile_touch("a").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.profile_touch("c").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.profile_touch("b").unwrap();

        let rec = db.profile_list_recent(10).unwrap();
        let ids: Vec<&str> = rec.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "c", "a"]);

        // limit 截断
        let limited = db.profile_list_recent(2).unwrap();
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].id, "b");
        assert_eq!(limited[1].id, "c");
    }

    #[test]
    fn profile_touch_does_not_set_dirty() {
        // touch 不应触发云同步（last_used_at 为本地使用记录）
        let db = tmp_db();
        db.profile_save(sample_profile("a", None)).unwrap();
        db.sync_mark_pushed(&db.sync_export_dirty().unwrap()).unwrap();
        db.profile_touch("a").unwrap();
        assert!(db.sync_export_dirty().unwrap().is_empty());
    }

    // ---------------- P4/P5 边界与回归 ----------------

    #[test]
    fn boundary_corrupt_backup_rejected() {
        let db = tmp_db();
        let path = std::env::temp_dir().join(format!("termone-bad-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, "not valid json {{{").unwrap();
        assert!(db.backup_import(&path, true).is_err());
    }

    #[test]
    fn boundary_empty_sync_is_noop() {
        let db = tmp_db();
        assert_eq!(db.sync_apply_pull(&[]).unwrap(), 0);
        assert!(db.sync_export_dirty().unwrap().is_empty());
    }

    #[test]
    fn boundary_search_empty_keyword_returns_all() {
        let db = tmp_db();
        db.profile_save(sample_profile("alpha", None)).unwrap();
        db.profile_save(sample_profile("beta", None)).unwrap();
        assert_eq!(db.profile_search("").unwrap().len(), 2);
        assert_eq!(db.profile_search("   ").unwrap().len(), 2);
    }

    #[test]
    fn boundary_lww_tie_not_applied() {
        // RK-04：并发同名更新，相等时间戳不覆盖本地（避免丢数据）
        let db = tmp_db();
        let item = SyncItem {
            item_id: "p1".into(),
            kind: "profile".into(),
            key: None,
            data: serde_json::json!({ "kind": "ssh", "name": "remote", "config": {}, "sortOrder": 0 }).to_string(),
            updated_at: 1000,
            deleted: false,
        };
        // 首次下发建立本地副本
        assert_eq!(db.sync_apply_pull(&[item.clone()]).unwrap(), 1);
        // 相同时间戳再次下发：不应覆盖
        assert_eq!(db.sync_apply_pull(&[item]).unwrap(), 0);
        assert_eq!(db.profile_list().unwrap()[0].name, "remote");
    }
}
