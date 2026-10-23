import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { RawData, WebSocket } from "ws";

import { verifyToken } from "./auth";
import { db, nowMs } from "./db";
import { createHostRecord, loadHostTarget } from "./sshHosts";

/**
 * Web 版 SSH 网关（**仅远程 SSH**，不做本地终端 / 串口）。
 *
 * 协议（全部为文本帧 JSON）：
 *   客户端 → 服务端
 *     { type: "connect", cols, rows, ... }  首帧，hostId 或内联连接参数
 *     { type: "data", data }                stdin（base64）
 *     { type: "resize", cols, rows }
 *   服务端 → 客户端
 *     { type: "ready", host, username }
 *     { type: "data", data }                 stdout（base64，UTF-8 流式解码）
 *     { type: "hostkey", fingerprint, firstUse }
 *     { type: "error", message, fatal }
 *     { type: "exit", code, signal }
 *
 * 安全要点：
 *   - 握手必须带有效 JWT（否则 4401 关闭），避免服务器沦为开放 SSH 代理；
 *   - **默认凭据不上传**：服务端没有凭据的主机，必须由客户端在 connect 帧里临时提供，
 *     该明文只在本次连接的内存中存在，不写库、不落盘，连接结束即丢弃；
 *   - 只有用户显式勾选「保存到服务端」时，才走 AES-256-GCM 加密落盘；
 *   - 接口永不返回任何凭据明文。
 *   - 主机公钥指纹 Trust-On-First-Use，变更即拒绝（防中间人）。
 *   - **主机与桌面端共用**：元数据存 user_items（kind='profile'），
 *     桌面端云同步 push/pull 同一张表——任一端保存的主机另一端立即可见。
 */

interface ConnectFrame {
  type?: unknown;
  cols?: unknown;
  rows?: unknown;
  hostId?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  authType?: unknown;
  password?: unknown;
  privateKey?: unknown;
  passphrase?: unknown;
  save?: unknown;
}

interface Target {
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  secret: string;
  passphrase: string | null;
}

function send(ws: WebSocket, obj: Record<string, unknown>): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function fingerprintOf(key: Buffer): string {
  return "SHA256:" + createHash("sha256").update(key).digest("base64");
}

/**
 * 主机公钥 Trust-On-First-Use。
 * 首次连接记录指纹并放行；指纹变更则拒绝（可能是中间人或主机重装）。
 */
function verifyHostKey(
  userId: string,
  host: string,
  port: number,
  key: Buffer,
): { ok: boolean; fingerprint: string; firstUse: boolean } {
  const fingerprint = fingerprintOf(key);
  const row = db
    .prepare("SELECT key_hash FROM ssh_known_hosts WHERE user_id = ? AND host = ? AND port = ?")
    .get(userId, host, port) as { key_hash: string } | undefined;
  if (!row) {
    db.prepare(
      "INSERT INTO ssh_known_hosts (user_id, host, port, key_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(userId, host, port, fingerprint, nowMs());
    return { ok: true, fingerprint, firstUse: true };
  }
  return { ok: row.key_hash === fingerprint, fingerprint, firstUse: false };
}

/**
 * 解析连接目标。
 *
 * 主机元数据来自 user_items 的 profile（**与桌面端共用**），凭据来自 ssh_credentials。
 *
 * **凭据优先级**：客户端本次连接内联提供的凭据 > 服务端已加密保存的凭据。
 * 内联凭据**只存在于本次连接的内存中**，绝不写库——这是「密钥永不上传」的默认路径：
 * 主机只登记元数据，每次连接时由用户在浏览器里输入，用完即弃。
 */
function resolveTarget(
  userId: string,
  frame: ConnectFrame,
): { target: Target } | { error: string } {
  const hostId = typeof frame.hostId === "string" ? frame.hostId : "";
  const authType = frame.authType === "key" ? "key" : "password";
  const inlineSecret =
    authType === "key"
      ? typeof frame.privateKey === "string"
        ? frame.privateKey
        : ""
      : typeof frame.password === "string"
        ? frame.password
        : "";
  const inlinePassphrase =
    authType === "key" && typeof frame.passphrase === "string" && frame.passphrase
      ? frame.passphrase
      : null;

  if (hostId) {
    const target0 = loadHostTarget(userId, hostId);
    if (!target0) return { error: "主机不存在" };

    const username = target0.username || (typeof frame.username === "string" ? frame.username.trim() : "");
    if (!username) return { error: "该主机未保存用户名，请在连接参数中提供用户名" };

    const base = { host: target0.host, port: target0.port, username };

    // 客户端本次临时提供：不读库、不落盘
    if (inlineSecret) {
      return {
        target: { ...base, authType, secret: inlineSecret, passphrase: inlinePassphrase },
      };
    }

    // 服务端没有保存过凭据（默认策略）→ 必须由客户端提供
    if (target0.secret === null) {
      return {
        error:
          target0.authType === "agent"
            ? "该主机使用 SSH Agent 认证，服务端不持有凭据，请在客户端提供密码或私钥后连接"
            : authType === "key"
              ? "该主机未保存凭据，请在客户端提供私钥后连接"
              : "该主机未保存凭据，请在客户端输入密码后连接",
      };
    }

    // 服务端保存的是 agent 引用之外的密钥/密码；authType 以保存时为准
    return {
      target: {
        ...base,
        authType: target0.authType === "key" ? "key" : "password",
        secret: target0.secret,
        passphrase: target0.passphrase,
      },
    };
  }

  const host = typeof frame.host === "string" ? frame.host.trim() : "";
  const username = typeof frame.username === "string" ? frame.username.trim() : "";
  if (!host) return { error: "主机地址不能为空" };
  if (!username) return { error: "用户名不能为空" };
  if (!inlineSecret) return { error: authType === "key" ? "私钥不能为空" : "密码不能为空" };

  const port = num(frame.port, 22, 1, 65535);
  const target: Target = {
    host,
    port,
    username,
    authType,
    secret: inlineSecret,
    passphrase: inlinePassphrase,
  };

  // 仅当用户显式勾选「保存到服务端」时才落盘（元数据进 user_items + 凭据加密）
  if (frame.save === true) {
    createHostRecord(userId, {
      host,
      port,
      username,
      authType,
      secret: inlineSecret,
      passphrase: inlinePassphrase,
    });
  }

  return { target };
}

export function registerSshWsRoutes(app: FastifyInstance): void {
  app.get("/api/ws/ssh", { websocket: true }, (socket, request) => {
    const query = (request.query ?? {}) as { token?: string };
    const userId = query.token ? verifyToken(query.token) : null;
    if (!userId) {
      socket.close(4401, "未登录或登录已过期");
      return;
    }

    const ws = socket as WebSocket;
    let ssh: Client | null = null;
    let stream: ClientChannel | null = null;
    let connected = false;
    let closed = false;

    const cleanup = () => {
      closed = true;
      try {
        stream?.end();
      } catch {
        /* ignore */
      }
      try {
        ssh?.end();
      } catch {
        /* ignore */
      }
      ssh = null;
      stream = null;
    };

    ws.on("close", cleanup);
    ws.on("error", cleanup);

    ws.on("message", (raw: RawData) => {
      if (closed) return;
      let frame: ConnectFrame & { data?: unknown };
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return send(ws, { type: "error", message: "无效的帧" });
      }

      // ---- 首帧：建立 SSH 连接 ----
      if (!connected) {
        if (frame.type !== "connect") {
          return send(ws, { type: "error", message: "首帧必须是 connect", fatal: true });
        }
        const resolved = resolveTarget(userId, frame);
        if ("error" in resolved) {
          return send(ws, { type: "error", message: resolved.error, fatal: true });
        }
        connected = true;

        const target = resolved.target;
        const cols = num(frame.cols, 120, 20, 500);
        const rows = num(frame.rows, 32, 5, 200);

        const cfg: ConnectConfig = {
          host: target.host,
          port: target.port,
          username: target.username,
          readyTimeout: 15000,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
          hostVerifier: (key: Buffer) => {
            const v = verifyHostKey(userId, target.host, target.port, key);
            if (v.firstUse || v.ok) {
              send(ws, { type: "hostkey", fingerprint: v.fingerprint, firstUse: v.firstUse });
            } else {
              send(ws, {
                type: "error",
                message: `主机公钥指纹已变更（${v.fingerprint}），疑似中间人攻击，已拒绝连接`,
                fatal: true,
              });
            }
            return v.ok;
          },
        };
        if (target.authType === "key") {
          cfg.privateKey = target.secret;
          if (target.passphrase) cfg.passphrase = target.passphrase;
        } else {
          cfg.password = target.secret;
        }

        const conn = new Client();
        ssh = conn;

        conn.on("ready", () => {
          conn.shell({ cols, rows, term: "xterm-256color" }, (err, ch) => {
            if (err) {
              send(ws, { type: "error", message: err.message, fatal: true });
              cleanup();
              return;
            }
            stream = ch;
            send(ws, { type: "ready", host: target.host, username: target.username });

            ch.on("close", () => {
              send(ws, { type: "exit" });
              try {
                ws.close();
              } catch {
                /* ignore */
              }
              cleanup();
            });
            ch.on("data", (chunk: Buffer) => {
              send(ws, { type: "data", data: chunk.toString("base64") });
            });
            ch.on("exit", (code: number | null, signal: string | null) => {
              send(ws, { type: "exit", code: code ?? undefined, signal: signal ?? undefined });
            });
          });
        });

        conn.on("error", (err: Error & { level?: string }) => {
          // ssh2 在认证失败时也会 emit error；连接已就绪后的非致命错误不关闭通道
          const msg = err?.message ?? String(err);
          send(ws, {
            type: "error",
            message: msg,
            fatal: !stream,
          });
          if (!stream) {
            cleanup();
            try {
              ws.close();
            } catch {
              /* ignore */
            }
          }
        });

        try {
          conn.connect(cfg);
        } catch (e) {
          send(ws, {
            type: "error",
            message: e instanceof Error ? e.message : String(e),
            fatal: true,
          });
          cleanup();
        }
        return;
      }

      // ---- 后续帧：输入 / 调整窗口 ----
      if (frame.type === "data" && typeof frame.data === "string") {
        if (!stream) return;
        try {
          stream.write(Buffer.from(frame.data, "base64"));
        } catch {
          /* ignore */
        }
        return;
      }
      if (frame.type === "resize") {
        if (!stream) return;
        const cols = num(frame.cols, 120, 20, 500);
        const rows = num(frame.rows, 32, 5, 200);
        try {
          stream.setWindow(rows, cols, 0, 0);
        } catch {
          /* ignore */
        }
      }
    });
  });
}
