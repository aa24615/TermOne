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

  -- Web SSH 主机与凭据。secret_enc 为 AES-256-GCM 密文（含 IV+tag），
  -- 服务端永不向外返回明文；仅在本进程内解密后用于建立 SSH 连接。
  CREATE TABLE IF NOT EXISTS ssh_hosts (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    host        TEXT NOT NULL,
    port        INTEGER NOT NULL DEFAULT 22,
    username    TEXT NOT NULL,
    auth_type   TEXT NOT NULL,          -- password | key
    secret_enc  TEXT NOT NULL,          -- 密码 或 私钥(PEM)
    passphrase_enc TEXT,                -- 私钥口令（可空）
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ssh_hosts_user
    ON ssh_hosts (user_id, updated_at);

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

export interface UserItemRow {
  item_id: string;
  kind: string;
  key: string | null;
  data: string;
  updated_at: number;
  deleted: number;
}

export interface SshHostRow {
  id: string;
  user_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: string;
  secret_enc: string;
  passphrase_enc: string | null;
  created_at: number;
  updated_at: number;
}

export function nowMs(): number {
  return Date.now();
}

export function newId(): string {
  return randomUUID();
}
