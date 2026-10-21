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
`);

export interface UserItemRow {
  item_id: string;
  kind: string;
  key: string | null;
  data: string;
  updated_at: number;
  deleted: number;
}

export function nowMs(): number {
  return Date.now();
}

export function newId(): string {
  return randomUUID();
}
