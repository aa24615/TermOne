import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import jwt, { type JwtPayload } from "jsonwebtoken";

import { dataDir, db, nowMs } from "./db";

const JWT_SECRET = loadOrCreateSecret();

function loadOrCreateSecret(): string {
  const file = path.join(dataDir, "jwt.secret");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // 首次启动
  }
  const secret = randomBytes(48).toString("hex");
  writeFileSync(file, secret + "\n", { mode: 0o600 });
  return secret;
}

/** 校验 Authorization 头；失败时直接回复 401 并返回 null。 */
export function requireAuth(req: FastifyRequest, reply: FastifyReply): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    void reply.code(401).send({ error: "未登录" });
    return null;
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as JwtPayload & { sub?: string };
    if (!payload.sub) throw new Error("bad token");
    return payload.sub;
  } catch {
    void reply.code(401).send({ error: "登录已过期，请重新登录" });
    return null;
  }
}

function signToken(userId: string, email: string): string {
  return jwt.sign({ email }, JWT_SECRET, { subject: userId, expiresIn: "30d" });
}

/**
 * 校验 Bearer token 并返回 userId；无效返回 null。
 * 供 WebSocket 握手使用（握手阶段无法用 Fastify reply 回 401）。
 */
export function verifyToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload & { sub?: string };
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

interface PublicUser {
  id: string;
  email: string;
  name: string | null;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get("/api/health", async () => ({ ok: true, name: "termone-sync", time: nowMs() }));

  app.post("/api/auth/register", async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; password?: string; name?: string };
    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: "邮箱格式不正确" });
    }
    if (password.length < 6) {
      return reply.code(400).send({ error: "密码至少 6 位" });
    }
    const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (exists) {
      return reply.code(409).send({ error: "该邮箱已注册" });
    }
    const id = randomUUID();
    const name = (body.name ?? "").trim() || email.split("@")[0];
    db.prepare(
      "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, email, name, bcrypt.hashSync(password, 10), nowMs());
    return { token: signToken(id, email), user: { id, email, name } satisfies PublicUser };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    const row = db
      .prepare("SELECT id, email, name, password_hash FROM users WHERE email = ?")
      .get(email) as
      | { id: string; email: string; name: string | null; password_hash: string }
      | undefined;
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      return reply.code(401).send({ error: "邮箱或密码错误" });
    }
    return {
      token: signToken(row.id, row.email),
      user: { id: row.id, email: row.email, name: row.name } satisfies PublicUser,
    };
  });

  app.get("/api/me", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const row = db.prepare("SELECT id, email, name FROM users WHERE id = ?").get(userId) as
      | PublicUser
      | undefined;
    if (!row) return reply.code(404).send({ error: "用户不存在" });
    return { user: row };
  });
}
