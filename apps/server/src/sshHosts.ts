import type { FastifyInstance } from "fastify";

import { requireAuth } from "./auth";
import { decryptSecret, encryptSecret, newHostId } from "./credCrypto";
import { db, nowMs, type SshHostRow } from "./db";

/**
 * Web SSH 主机（**元数据**）的 CRUD。
 *
 * ## 凭据策略：默认永不上传
 * - 客户端默认**只提交元数据**，密码/私钥不离开本机浏览器；
 * - 只有用户显式勾选「保存到服务端」时，才提交明文并在此处 AES-256-GCM 加密落盘；
 * - 服务端接口**永不返回** `secret_enc` / `passphrase_enc` / 任何明文；
 * - 服务端无凭据的主机，连接时由客户端经 WebSocket 临时提供（仅内存，用完即弃）。
 */

interface HostMeta {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  /** 服务端是否持有（加密的）凭据。false = 连接时需客户端临时提供 */
  hasCredential: boolean;
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
    hasCredential: !!r.secret_enc,
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
  /** 明文：密码 或 私钥 PEM。**缺省 = 不上传**（默认策略） */
  password?: unknown;
  privateKey?: unknown;
  passphrase?: unknown;
  /** true = 删除服务端已保存的凭据（用户取消勾选「保存到服务端」） */
  clearCredential?: unknown;
}

interface ParsedHost {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  /** null = 不写入凭据（创建：不上传；更新：保持不变，除非 clearCredential） */
  secret: string | null;
  passphrase: string | null;
  clearCredential: boolean;
}

function parseHostInput(body: HostInput): ParsedHost | string {
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

  const secret =
    authType === "key"
      ? typeof body.privateKey === "string"
        ? body.privateKey
        : ""
      : typeof body.password === "string"
        ? body.password
        : "";

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
    secret: secret || null,
    passphrase,
    clearCredential: body.clearCredential === true,
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
    const parsed = parseHostInput(body);
    if (typeof parsed === "string") return reply.code(400).send({ error: parsed });

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
      // 未上传凭据 → NULL：服务端从此不持有该主机的密钥
      parsed.secret ? encryptSecret(parsed.secret) : null,
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
    const parsed = parseHostInput(body);
    if (typeof parsed === "string") return reply.code(400).send({ error: parsed });

    // 1) 用户取消勾选「保存到服务端」→ 立刻删除已保存的凭据
    // 2) 提交了新凭据 → 覆盖
    // 3) 留空 → 保持不变（服务端永不返回明文，前端无法回填）
    let secretEnc: string | null;
    let passphraseEnc: string | null;
    if (parsed.clearCredential) {
      secretEnc = null;
      passphraseEnc = null;
    } else if (parsed.secret) {
      secretEnc = encryptSecret(parsed.secret);
      passphraseEnc = parsed.passphrase ? encryptSecret(parsed.passphrase) : null;
    } else {
      secretEnc = existing.secret_enc;
      passphraseEnc = existing.passphrase_enc;
    }

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

/**
 * 供 WebSocket 网关使用：读取并解密某主机的凭据（仅内存，勿落盘/勿传输）。
 * `secret` 为 null 表示服务端不持有凭据，必须由客户端在 connect 帧中临时提供。
 */
export function loadCredential(
  userId: string,
  hostId: string,
): { row: SshHostRow; secret: string | null; passphrase: string | null } | null {
  const row = db
    .prepare("SELECT * FROM ssh_hosts WHERE id = ? AND user_id = ?")
    .get(hostId, userId) as unknown as SshHostRow | undefined;
  if (!row) return null;
  if (!row.secret_enc) return { row, secret: null, passphrase: null };
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
