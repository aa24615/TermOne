import type { FastifyInstance } from "fastify";

import { requireAuth } from "./auth";
import { decryptSecret, encryptSecret, newHostId } from "./credCrypto";
import {
  db,
  nowMs,
  upsertUserItem,
  type SshCredentialRow,
  type UserItemRow,
} from "./db";

/**
 * SSH 主机管理 —— **与桌面端共用存储**。
 *
 * ## 数据布局（关键）
 * - **主机元数据**存 `user_items`（kind='profile'），数据格式与桌面端云同步
 *   （`storage.rs` 的 `sync_export_dirty`）完全一致：`{id, kind:'ssh', name,
 *   config:{host, port, user, auth}, group_id, sortOrder}`。
 *   桌面端 sync push/pull 同一张表 → 任一端保存的主机，另一端立即可见。
 * - **凭据**单独存 `ssh_credentials`（按 profile id 关联，AES-256-GCM 密文）。
 *
 * ## 凭据策略：默认永不上传
 * - 客户端默认只提交元数据，密码/私钥不离开本机浏览器；
 * - 只有用户显式勾选「保存到服务端」时，才提交明文并在此加密落盘；
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
  /**
   * true = 该 profile 的数据是 E2EE 密文（桌面端开启了端到端加密同步），
   * 服务端无法解析其内容，Web 端不能显示/连接，只能原样留给桌面端拉回。
   */
  encrypted: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 解析桌面端同步格式的 SSH profile；非 SSH 或无法解析时返回 null */
function parseSshProfile(data: string): {
  name: string;
  host: string;
  port: number;
  user: string;
  auth: "agent" | "password" | "key";
} | null {
  let payload: {
    kind?: unknown;
    name?: unknown;
    config?: { host?: unknown; port?: unknown; user?: unknown; auth?: unknown };
  };
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const cfg = payload.config;
  if (!cfg || typeof cfg !== "object") return null;
  const host = typeof cfg.host === "string" ? cfg.host.trim() : "";
  if (!host) return null; // local/serial 等非 SSH 档案，Web 端不展示
  const auth = cfg.auth === "key" ? "key" : cfg.auth === "agent" ? "agent" : "password";
  return {
    name: typeof payload.name === "string" && payload.name ? payload.name : host,
    host,
    port: typeof cfg.port === "number" && Number.isFinite(cfg.port) ? Math.trunc(cfg.port) : 22,
    user: typeof cfg.user === "string" ? cfg.user.trim() : "",
    auth,
  };
}

/** 组装桌面端同步格式的 SSH profile item data */
export function buildProfileData(input: {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
}): string {
  return JSON.stringify({
    id: input.id,
    kind: "ssh",
    name: input.name || `${input.username}@${input.host}`,
    config: {
      host: input.host,
      port: input.port,
      user: input.username,
      auth: input.authType,
    },
    group_id: null,
    sortOrder: 0,
  });
}

/**
 * 保存一台主机（元数据进 user_items + 可选凭据进 ssh_credentials）。
 * POST /api/ssh/hosts 与 WS 临时连接的「保存」分支共用。
 */
export function createHostRecord(
  userId: string,
  input: {
    name?: string;
    host: string;
    port: number;
    username: string;
    authType: "password" | "key";
    secret?: string | null;
    passphrase?: string | null;
  },
): string {
  const id = newHostId();
  const ts = nowMs();
  upsertUserItem(userId, {
    itemId: id,
    kind: "profile",
    data: buildProfileData({
      id,
      name: input.name ?? "",
      host: input.host,
      port: input.port,
      username: input.username,
      authType: input.authType,
    }),
    updatedAt: ts,
  });
  if (input.secret) {
    db.prepare(
      `INSERT INTO ssh_credentials (user_id, host_id, auth_type, secret_enc, passphrase_enc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, host_id) DO UPDATE SET
         auth_type = excluded.auth_type,
         secret_enc = excluded.secret_enc,
         passphrase_enc = excluded.passphrase_enc,
         updated_at = excluded.updated_at`,
    ).run(
      userId,
      id,
      input.authType,
      encryptSecret(input.secret),
      input.passphrase ? encryptSecret(input.passphrase) : null,
      ts,
      ts,
    );
  }
  return id;
}

function credMap(userId: string): Map<string, SshCredentialRow> {
  const rows = db
    .prepare("SELECT * FROM ssh_credentials WHERE user_id = ?")
    .all(userId) as unknown as SshCredentialRow[];
  return new Map(rows.map((r) => [r.host_id, r]));
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

/** 写/改凭据（upsert）。secret 为 null 且非 clear 时保持原样。 */
function saveCredential(
  userId: string,
  hostId: string,
  parsed: ParsedHost,
  existing: SshCredentialRow | undefined,
): void {
  if (parsed.clearCredential) {
    db.prepare("DELETE FROM ssh_credentials WHERE user_id = ? AND host_id = ?").run(userId, hostId);
    return;
  }
  if (!parsed.secret) return; // 未提交新凭据 → 保持不变

  const ts = nowMs();
  db.prepare(
    `INSERT INTO ssh_credentials (user_id, host_id, auth_type, secret_enc, passphrase_enc, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, host_id) DO UPDATE SET
       auth_type = excluded.auth_type,
       secret_enc = excluded.secret_enc,
       passphrase_enc = excluded.passphrase_enc,
       updated_at = excluded.updated_at`,
  ).run(
    userId,
    hostId,
    parsed.authType,
    encryptSecret(parsed.secret),
    parsed.passphrase ? encryptSecret(parsed.passphrase) : null,
    existing?.created_at ?? ts,
    ts,
  );
}

export function registerSshHostRoutes(app: FastifyInstance): void {
  /** 主机列表 = 桌面端同步上来的 profiles（kind='profile' 且含 config.host）+ 本端保存的 */
  app.get("/api/ssh/hosts", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const rows = db
      .prepare(
        "SELECT item_id, data, updated_at, deleted FROM user_items WHERE user_id = ? AND kind = 'profile'",
      )
      .all(userId) as unknown as Pick<UserItemRow, "item_id" | "data" | "updated_at" | "deleted">[];
    const creds = credMap(userId);

    const hosts: HostMeta[] = [];
    for (const r of rows) {
      if (Number(r.deleted) !== 0) continue;
      const parsed = parseSshProfile(r.data);
      if (!parsed) {
        // 解析不出主机信息：要么是 E2EE 密文，要么是 local/serial 档案。
        // 仅把「看起来是 E2EE 密文」的项标记出来（本地档案直接跳过）。
        let isJson = true;
        try {
          JSON.parse(r.data);
        } catch {
          isJson = false;
        }
        if (isJson) continue;
        hosts.push({
          id: r.item_id,
          name: "（已加密，Web 端不可见）",
          host: "",
          port: 0,
          username: "",
          authType: "password",
          hasCredential: false,
          hasPassphrase: false,
          encrypted: true,
          createdAt: 0,
          updatedAt: Number(r.updated_at),
        });
        continue;
      }
      const cred = creds.get(r.item_id);
      hosts.push({
        id: r.item_id,
        name: parsed.name,
        host: parsed.host,
        port: parsed.port,
        username: parsed.user,
        // 桌面端 agent 认证在 Web 端按密码处理（连接时由客户端提供凭据）
        authType: parsed.auth === "key" ? "key" : "password",
        hasCredential: !!cred?.secret_enc,
        hasPassphrase: !!cred?.passphrase_enc,
        encrypted: false,
        createdAt: 0,
        updatedAt: Number(r.updated_at),
      });
    }
    hosts.sort((a, b) => b.updatedAt - a.updatedAt);
    return { hosts };
  });

  app.post("/api/ssh/hosts", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const body = (req.body ?? {}) as HostInput;
    const parsed = parseHostInput(body);
    if (typeof parsed === "string") return reply.code(400).send({ error: parsed });

    // 1) 元数据 → user_items（桌面端 sync pull 可直接拉用）；2) 凭据（可选，缺省 = 不上传）
    const id = createHostRecord(userId, {
      name: parsed.name,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      authType: parsed.authType,
      secret: parsed.secret,
      passphrase: parsed.passphrase,
    });
    return { id };
  });

  app.patch("/api/ssh/hosts/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const existing = db
      .prepare("SELECT * FROM user_items WHERE user_id = ? AND item_id = ? AND kind = 'profile'")
      .get(userId, id) as unknown as UserItemRow | undefined;
    if (!existing) return reply.code(404).send({ error: "主机不存在" });
    // E2EE 密文主机不可编辑：改写明文等于绕过桌面端的端到端加密
    if (!parseSshProfile(existing.data)) {
      return reply.code(403).send({ error: "该主机为 E2EE 加密数据，Web 端不能编辑（可在桌面端关闭 E2EE 后重新同步）" });
    }

    const body = (req.body ?? {}) as HostInput;
    const parsed = parseHostInput(body);
    if (typeof parsed === "string") return reply.code(400).send({ error: parsed });

    upsertUserItem(userId, {
      itemId: id,
      kind: "profile",
      data: buildProfileData({ id, ...parsed }),
      updatedAt: nowMs(),
    });
    const cred = db
      .prepare("SELECT * FROM ssh_credentials WHERE user_id = ? AND host_id = ?")
      .get(userId, id) as unknown as SshCredentialRow | undefined;
    saveCredential(userId, id, parsed, cred);
    return { ok: true };
  });

  /**
   * 删除主机：user_items 打 deleted 标记（tombstone）而非物理删除——
   * 桌面端 `sync_apply_pull` 依赖 tombstone 把删除同步到本地。
   */
  app.delete("/api/ssh/hosts/:id", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const { id } = req.params as { id: string };
    const changed = upsertUserItem(userId, {
      itemId: id,
      kind: "profile",
      data: JSON.stringify({ id, kind: "ssh", deleted: true }),
      updatedAt: nowMs(),
      deleted: true,
    });
    db.prepare("DELETE FROM ssh_credentials WHERE user_id = ? AND host_id = ?").run(userId, id);
    if (!changed) {
      // 可能该 item 已标记删除（updated_at 更旧），确认存在性
      const row = db
        .prepare("SELECT item_id FROM user_items WHERE user_id = ? AND item_id = ?")
        .get(userId, id) as unknown as { item_id: string } | undefined;
      if (!row) return reply.code(404).send({ error: "主机不存在" });
    }
    return { ok: true };
  });
}

/**
 * 供 WebSocket 网关使用：按 hostId 解析连接目标。
 * 元数据来自 user_items 的 profile（与桌面端共用），凭据来自 ssh_credentials。
 * `secret` 为 null 表示服务端不持有凭据，必须由客户端在 connect 帧中临时提供。
 */
export function loadHostTarget(
  userId: string,
  hostId: string,
): {
  host: string;
  port: number;
  username: string;
  authType: "password" | "key" | "agent";
  secret: string | null;
  passphrase: string | null;
} | null {
  const row = db
    .prepare("SELECT data, deleted FROM user_items WHERE user_id = ? AND item_id = ? AND kind = 'profile'")
    .get(userId, hostId) as unknown as { data: string; deleted: number } | undefined;
  if (!row || Number(row.deleted) !== 0) return null;
  const parsed = parseSshProfile(row.data);
  if (!parsed) return null;

  let secret: string | null = null;
  let passphrase: string | null = null;
  const cred = db
    .prepare("SELECT * FROM ssh_credentials WHERE user_id = ? AND host_id = ?")
    .get(userId, hostId) as unknown as SshCredentialRow | undefined;
  if (cred?.secret_enc) {
    try {
      secret = decryptSecret(cred.secret_enc);
      passphrase = cred.passphrase_enc ? decryptSecret(cred.passphrase_enc) : null;
    } catch {
      return null; // 解密失败（主密钥更换等）→ 按无凭据处理
    }
  }

  return {
    host: parsed.host,
    port: parsed.port,
    username: parsed.user,
    authType: parsed.auth,
    secret,
    passphrase,
  };
}
