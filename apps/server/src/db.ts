import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export const dataDir = process.env.TERMONE_DATA || path.join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "termone-server.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_items (
    user_id    TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    key        TEXT,
    data       TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, item_id)
  );

  CREATE INDEX IF NOT EXISTS idx_user_items_updated
    ON user_items (user_id, updated_at);

  -- SSH 凭据（按主机 profile 的 item_id 关联）。
  -- **主机元数据不在这里**：元数据统一存 user_items（kind='profile'），
  -- 与桌面端云同步完全共用（桌面端 sync push/pull 同一张表、同一种数据格式）。
  -- secret_enc 为 AES-256-GCM 密文（含 IV+tag），服务端永不向外返回明文；
  -- secret_enc 可空：默认「凭据永不上传」，连接时由客户端临时提供（仅内存，用完即弃）。
  CREATE TABLE IF NOT EXISTS ssh_credentials (
    user_id        TEXT NOT NULL,
    host_id        TEXT NOT NULL,        -- = user_items.item_id（profile id）
    auth_type      TEXT NOT NULL,        -- password | key
    secret_enc     TEXT,                 -- 密码 或 私钥(PEM)，NULL = 服务端不持有凭据
    passphrase_enc TEXT,                 -- 私钥口令（可空）
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (user_id, host_id)
  );

  -- SSH 主机公钥指纹（Trust-On-First-Use）。同一主机指纹变更即拒绝连接，防中间人。
  CREATE TABLE IF NOT EXISTS ssh_known_hosts (
    user_id    TEXT NOT NULL,
    host       TEXT NOT NULL,
    port       INTEGER NOT NULL,
    key_hash   TEXT NOT NULL,          -- SHA256(base64) 指纹
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, host, port)
  );
`);

/**
 * 迁移：`ssh_hosts`（Web 端独立主机表）→ 共用存储。
 *
 * 背景：主机保存改为「桌面端与 Web 端共用」——元数据统一存 user_items
 * （kind='profile'，桌面端云同步同表同格式），凭据移到 ssh_credentials
 * 按 profile id 关联。老库需要把已有主机搬过去：
 *   1. 元数据 → user_items profile item（桌面端 sync_apply_pull 可直接拉用的格式）
 *   2. 凭据   → ssh_credentials（密文原样搬运，不解密）
 *   3. DROP TABLE ssh_hosts
 */
function migrateSshHostsToSharedProfiles(): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ssh_hosts'")
    .all() as unknown as { name: string }[];
  if (tables.length === 0) return;

  const rows = db
    .prepare("SELECT * FROM ssh_hosts")
    .all() as unknown as {
      id: string;
      user_id: string;
      name: string;
      host: string;
      port: number;
      username: string;
      auth_type: string;
      secret_enc: string | null;
      passphrase_enc: string | null;
      created_at: number;
      updated_at: number;
    }[];

  const upsertItem = db.prepare(`
    INSERT INTO user_items (user_id, item_id, kind, key, data, updated_at, deleted)
    VALUES (?, ?, 'profile', NULL, ?, ?, 0)
    ON CONFLICT(user_id, item_id) DO UPDATE SET
      kind = excluded.kind,
      key = excluded.key,
      data = excluded.data,
      updated_at = excluded.updated_at,
      deleted = 0
    WHERE excluded.updated_at > user_items.updated_at
  `);
  const upsertCred = db.prepare(`
    INSERT INTO ssh_credentials (user_id, host_id, auth_type, secret_enc, passphrase_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, host_id) DO UPDATE SET
      auth_type = excluded.auth_type,
      secret_enc = excluded.secret_enc,
      passphrase_enc = excluded.passphrase_enc,
      updated_at = excluded.updated_at
  `);

  for (const r of rows) {
    // 与桌面端 profiles 同步格式一致（storage.rs sync_export_dirty 的 payload）
    const payload = JSON.stringify({
      id: r.id,
      kind: "ssh",
      name: r.name,
      config: {
        host: r.host,
        port: Number(r.port),
        user: r.username,
        auth: r.auth_type === "key" ? "key" : "password",
      },
      group_id: null,
      sortOrder: 0,
    });
    upsertItem.run(r.user_id, r.id, payload, r.updated_at);
    upsertCred.run(
      r.user_id,
      r.id,
      r.auth_type,
      r.secret_enc,
      r.passphrase_enc,
      r.created_at,
      r.updated_at,
    );
  }

  db.exec("DROP TABLE ssh_hosts");
}
migrateSshHostsToSharedProfiles();

export interface UserItemRow {
  item_id: string;
  kind: string;
  key: string | null;
  data: string;
  updated_at: number;
  deleted: number;
}

/** SSH 凭据行（按 profile item_id 关联；secret_enc 为 NULL 表示服务端不持有凭据） */
export interface SshCredentialRow {
  user_id: string;
  host_id: string;
  auth_type: string;
  secret_enc: string | null;
  passphrase_enc: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 写入/更新一条同步 item（LWW：仅当 updated_at 更新时才覆盖）。
 * 桌面端 sync push 与 Web 端主机保存共用此函数，保证两端数据完全一致。
 */
export function upsertUserItem(
  userId: string,
  item: { itemId: string; kind: string; key?: string | null; data: string; updatedAt: number; deleted?: boolean },
): boolean {
  const result = db
    .prepare(
      `INSERT INTO user_items (user_id, item_id, kind, key, data, updated_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, item_id) DO UPDATE SET
         kind = excluded.kind,
         key = excluded.key,
         data = excluded.data,
         updated_at = excluded.updated_at,
         deleted = excluded.deleted
       WHERE excluded.updated_at > user_items.updated_at`,
    )
    .run(
      userId,
      item.itemId,
      item.kind,
      item.key ?? null,
      item.data,
      Math.round(item.updatedAt),
      item.deleted ? 1 : 0,
    );
  return Number(result.changes) > 0;
}

export function nowMs(): number {
  return Date.now();
}

export function newId(): string {
  return randomUUID();
}
