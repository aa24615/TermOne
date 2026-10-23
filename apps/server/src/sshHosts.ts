import type { FastifyInstance } from "fastify";

import { requireAuth } from "./auth";
import { decryptSecret, encryptSecret, newHostId } from "./credCrypto";
import { db, nowMs, type SshHostRow } from "./db";

/**
 * Web SSH 主机（含凭据）的 CRUD。
 *
 * **安全约束**：所有对外响应只返回元数据（id/name/host/port/username/authType/时间戳），
 * 绝不返回 `secret_enc` / `passphrase_enc` / 任何明文。明文只在服务端内存解密，
 * 供 `sshWs.ts` 建立连接时使用。
 */

interface HostMeta {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  hasPassphrase: boolean;
  createdAt: number;
  updatedAt: number;
}

function toMeta(r: SshHostRow): HostMeta {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: Number(r.port),
    username: r.username,
    authType: r.auth_type === "key" ? "key" : "password",
    hasPassphrase: !!r.passphrase_enc,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

interface HostInput {
  name?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  authType?: unknown;
  /** 明文：密码 或 私钥 PEM。仅在写入时存在，随即加密落盘。 */
  password?: unknown;
  privateKey?: unknown;
  passphrase?: unknown;
}

interface ParsedHost {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  /** null = 保持原有凭据不变（仅 PATCH 允许） */
  secret: string | null;
  passphrase: string | null;
}

function parseHostInput(body: HostInput, partial: boolean): ParsedHost | string {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const host = typeof body.host === "string" ? body.host.trim() : "";
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const authType = body.authType === "key" ? "key" : "password";
  const portRaw = body.port;
  const port =
    typeof portRaw === "number" && Number.isFinite(portRaw)
      ? Math.trunc(portRaw)
      : typeof portRaw === "string" && portRaw.trim()
        ? Number(portRaw)
        : 22;

  if (!host) return "主机地址不能为空";
  if (!username) return "用户名不能为空";
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "端口需在 1–65535 之间";
  if (partial && !name && !host) return "无可更新字段";

  const secret =
    authType === "key"
      ? typeof body.privateKey === "string"
        ? body.privateKey
        : ""
      : typeof body.password === "string"
        ? body.password
        : "";
  if (!secret) {
    // 服务端永不返回凭据明文，因此编辑时允许「留空 = 保持不变」
    if (partial) return { name: name || `${username}@${host}`, host, port, username, authType, secret: null, passphrase: null };
    return authType === "key" ? "私钥不能为空" : "密码不能为空";
  }

  const passphrase =
    authType === "key" && typeof body.passphrase === "string" && body.passphrase
      ? body.passphrase
      : null;

  return {
    name: name || `${username}@${host}`,
    host,
    port,
    username,
    authType,
    secret,
    passphrase,
  };
}

export function registerSshHostRoutes(app: FastifyInstance): void {
  app.get("/api/ssh/hosts", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const rows = db
      .prepare(
        "SELECT * FROM ssh_hosts WHERE user_id = ? ORDER BY updated_at DESC",
      )
      .all(userId) as unknown as SshHostRow[];
    return { hosts: rows.map(toMeta) };
  });

  app.post("/api/ssh/hosts", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const body = (req.body ?? {}) as HostInput;
    const parsed = parseHostInput(body, false);
    if (typeof parsed === "string") return reply.code(400).send({ error: parsed });
    if (parsed.secret === null) {
      return reply.code(400).send({ error: parsed.authType === "key" ? "私钥不能为空" : "密码不能为空" });
    }

    const id = newHostId();
    const ts = nowMs();
    db.prepare(
      `INSERT INTO ssh_hosts
       (id, user_id, name, host, port, username, auth_type, secret_enc, passphrase_enc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      parsed.name,
      parsed.host,
      parsed.port,
      parsed.username,
      parsed.authType,
      encryptSecret(parsed.secret),
      parsed.passphrase ? encryptSecret(parsed.passphrase) : null,
      ts,
      ts,
    );
    return { id };
  });

  app.patch("/api/ssh/hosts/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const existing = db
      .prepare("SELECT * FROM ssh_hosts WHERE id = ? AND user_id = ?")
      .get(id, userId) as unknown as SshHostRow | undefined;
    if (!existing) return reply.code(404).send({ error: "主机不存在" });

    const body = (req.body ?? {}) as HostInput;
    const parsed = parseHostInput(body, true);
    if (typeof parsed === "string") return reply.code(400).send({ error: parsed });

    // 留空则沿用原有凭据（明文永不离开服务端，前端无法回填）
    const secretEnc = parsed.secret ? encryptSecret(parsed.secret) : existing.secret_enc;
    const passphraseEnc = parsed.passphrase
      ? encryptSecret(parsed.passphrase)
      : existing.passphrase_enc;

    db.prepare(
      `UPDATE ssh_hosts SET
         name = ?, host = ?, port = ?, username = ?, auth_type = ?,
         secret_enc = ?, passphrase_enc = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).run(
      parsed.name,
      parsed.host,
      parsed.port,
      parsed.username,
      parsed.authType,
      secretEnc,
      passphraseEnc,
      nowMs(),
      id,
      userId,
    );
    return { ok: true };
  });

  app.delete("/api/ssh/hosts/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const result = db
      .prepare("DELETE FROM ssh_hosts WHERE id = ? AND user_id = ?")
      .run(id, userId);
    if (Number(result.changes) === 0) return reply.code(404).send({ error: "主机不存在" });
    return { ok: true };
  });
}

/** 供 WebSocket 网关使用：读取并解密某主机的凭据（仅内存，勿落盘/勿传输）。 */
export function loadCredential(
  userId: string,
  hostId: string,
): { row: SshHostRow; secret: string; passphrase: string | null } | null {
  const row = db
    .prepare("SELECT * FROM ssh_hosts WHERE id = ? AND user_id = ?")
    .get(hostId, userId) as unknown as SshHostRow | undefined;
  if (!row) return null;
  try {
    return {
      row,
      secret: decryptSecret(row.secret_enc),
      passphrase: row.passphrase_enc ? decryptSecret(row.passphrase_enc) : null,
    };
  } catch {
    return null;
  }
}
