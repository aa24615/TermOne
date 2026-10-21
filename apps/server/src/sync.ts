import type { FastifyInstance } from "fastify";

import { requireAuth } from "./auth";
import { db, nowMs, type UserItemRow } from "./db";

interface SyncItemDto {
  itemId?: unknown;
  kind?: unknown;
  key?: unknown;
  data?: unknown;
  updatedAt?: unknown;
  deleted?: unknown;
}

/** LWW 同步：push 按 updated_at 新者胜；pull 增量返回 updated_at > since 的行。 */
export function registerSyncRoutes(app: FastifyInstance): void {
  app.get("/api/sync/pull", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const since = Number((req.query as { since?: string }).since ?? 0) || 0;
    const rows = db
      .prepare(
        "SELECT item_id, kind, key, data, updated_at, deleted FROM user_items WHERE user_id = ? AND updated_at > ?",
      )
      .all(userId, since) as unknown as UserItemRow[];
    return {
      serverTime: nowMs(),
      items: rows.map((r) => ({
        itemId: r.item_id,
        kind: r.kind,
        key: r.key,
        data: r.data,
        updatedAt: Number(r.updated_at),
        deleted: !!r.deleted,
      })),
    };
  });

  app.post("/api/sync/push", async (req, reply) => {
    const userId = requireAuth(req, reply);
    if (!userId) return;
    const body = (req.body ?? {}) as { items?: SyncItemDto[] };
    const items = Array.isArray(body.items) ? body.items : [];

    const upsert = db.prepare(`
      INSERT INTO user_items (user_id, item_id, kind, key, data, updated_at, deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, item_id) DO UPDATE SET
        kind = excluded.kind,
        key = excluded.key,
        data = excluded.data,
        updated_at = excluded.updated_at,
        deleted = excluded.deleted
      WHERE excluded.updated_at > user_items.updated_at
    `);

    let accepted = 0;
    for (const it of items) {
      if (!it || typeof it.itemId !== "string" || it.itemId.length === 0) continue;
      if (it.kind !== "profile" && it.kind !== "setting") continue;
      if (typeof it.updatedAt !== "number" || !Number.isFinite(it.updatedAt)) continue;
      const result = upsert.run(
        userId,
        it.itemId,
        it.kind,
        typeof it.key === "string" ? it.key : null,
        typeof it.data === "string" ? it.data : JSON.stringify(it.data ?? null),
        Math.round(it.updatedAt),
        it.deleted ? 1 : 0,
      );
      accepted += Number(result.changes);
    }
    return { serverTime: nowMs(), accepted };
  });
}
