/**
 * 共用存储冒烟：**客户端（桌面端）与 Web 端保存的 SSH 主机完全共用**。
 *
 * 核心断言（数据布局 = user_items 的 kind='profile' item，与桌面端云同步同表同格式）：
 *   1. 桌面端 sync push 的主机 → Web 端 GET /api/ssh/hosts 立即可见（正向共用）
 *   2. Web 端保存的主机 → /api/sync/pull 能拉到，且 data 格式与桌面端
 *      sync_apply_pull 完全兼容（id/kind/name/config{host,port,user,auth}/group_id/sortOrder）
 *      （反向共用）
 *   3. 桌面端 E2EE 加密同步的主机 → Web 端标记 encrypted，不解析、不泄露内容
 *   4. Web 端删除主机 → tombstone（deleted=true）随 pull 同步到桌面端
 *   5. E2EE 主机不可编辑（403），但可删除
 *   6. 桌面端 agent 认证主机 → Web 端可见，连接时提示需客户端提供凭据
 *   7. 凭据仍默认不上传；勾选后才加密落盘；DB 与响应均无明文
 *
 * 用法：node tools/ssh_shared_smoke.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = process.env.SMOKE_PORT || "8893";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "termone-shared-"));
const serverDir = path.resolve("apps/server");
const base = `http://127.0.0.1:${PORT}/api`;
const wsBase = `ws://127.0.0.1:${PORT}/api/ws/ssh`;

const results = [];
function check(label, ok, extra = "") {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
}

function pickTsx() {
  const candidates = [
    path.resolve(serverDir, "node_modules/tsx/dist/cli.mjs"),
    path.resolve("node_modules/tsx/dist/cli.mjs"),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

const tsx = pickTsx();
if (!tsx) {
  console.error("未找到 tsx，请先 npm install");
  process.exit(1);
}

const child = spawn(process.execPath, [tsx, "src/index.ts"], {
  cwd: serverDir,
  env: { ...process.env, PORT, TERMONE_DATA: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});

async function waitReady(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/me`);
      if (res.status === 401 || res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function api(pathname, { method = "GET", body, token } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function wsProbe(payload, token, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}?token=${encodeURIComponent(token)}`);
    const frames = [];
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ frames, timedOut: true });
    }, timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify({ type: "connect", cols: 120, rows: 32, ...payload })));
    ws.on("message", (raw) => {
      let f = null;
      try {
        f = JSON.parse(String(raw));
      } catch {
        /* ignore */
      }
      if (f) frames.push(f);
      if (f && (f.fatal || f.type === "exit")) {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve({ frames, timedOut: false });
      }
    });
    ws.on("error", () => {
      clearTimeout(timer);
      resolve({ frames, timedOut: false });
    });
    ws.on("close", () => {
      clearTimeout(timer);
      resolve({ frames, timedOut: false });
    });
  });
}

/** 桌面端 storage.rs sync_export_dirty 对 ssh profile 的 payload 格式 */
function desktopProfilePayload(id, { name, host, port, user, auth }) {
  return JSON.stringify({
    id,
    kind: "ssh",
    name,
    config: { host, port, user, auth },
    group_id: null,
    sortOrder: 0,
  });
}

const dbFile = path.join(dataDir, "termone-server.db");
const SECRET = "shared-secret-pw-2026";

try {
  if (!(await waitReady())) {
    console.error("服务启动超时");
    process.exit(1);
  }
  console.log(`服务端已就绪（PORT=${PORT}，数据目录 ${dataDir}）\n`);

  const email = `smoke-${Date.now()}@example.com`;
  const reg = await api("/auth/register", {
    method: "POST",
    body: { email, password: "Smoke12345", name: "smoke" },
  });
  const token = reg.json?.token;
  check("注册拿到 token", !!token);
  if (!token) process.exit(1);

  // ---- 1. 桌面端 → Web：sync push 一台主机 ----
  const desktopId = "d0000000-0000-4000-8000-000000000001";
  const push1 = await api("/sync/push", {
    method: "POST",
    token,
    body: {
      items: [
        {
          itemId: desktopId,
          kind: "profile",
          data: desktopProfilePayload(desktopId, {
            name: "桌面端同步来的机器",
            host: "192.0.2.11",
            port: 22,
            user: "root",
            auth: "password",
          }),
          updatedAt: Date.now() - 5000,
          deleted: false,
        },
      ],
    },
  });
  check("桌面端格式 sync push 被接受", push1.status === 200 && push1.json?.accepted === 1, JSON.stringify(push1.json));

  const list1 = await api("/ssh/hosts", { token });
  const fromDesktop = list1.json?.hosts?.find((h) => h.id === desktopId);
  check(
    "Web 端立即可见桌面端同步的主机（正向共用）",
    !!fromDesktop && fromDesktop.host === "192.0.2.11" && fromDesktop.username === "root",
    JSON.stringify(fromDesktop),
  );
  check("桌面端主机 hasCredential=false（桌面端密钥走本机钥匙串，永不上传）", fromDesktop?.hasCredential === false);
  check("桌面端主机非 E2EE 标记", fromDesktop?.encrypted === false);

  // ---- 2. Web → 桌面端：Web 保存一台主机，pull 应能以桌面端格式拉回 ----
  const webCreated = await api("/ssh/hosts", {
    method: "POST",
    token,
    body: { host: "192.0.2.22", port: 2222, username: "admin", authType: "password" },
  });
  const webId = webCreated.json?.id;
  check("Web 端保存主机成功", webCreated.status === 200 && !!webId, `status=${webCreated.status}`);

  const pull = await api("/sync/pull?since=0", { token });
  const pulled = pull.json?.items?.find((it) => it.itemId === webId);
  check("Web 保存的主机出现在 sync pull 中（反向共用）", !!pulled, `items=${pull.json?.items?.length}`);
  let parsed = null;
  try {
    parsed = pulled ? JSON.parse(pulled.data) : null;
  } catch {
    /* ignore */
  }
  check(
    "pull 数据与桌面端 sync_apply_pull 格式兼容（id/kind/name/config/group_id/sortOrder）",
    !!parsed &&
      parsed.id === webId &&
      parsed.kind === "ssh" &&
      typeof parsed.name === "string" &&
      parsed.config?.host === "192.0.2.22" &&
      parsed.config?.port === 2222 &&
      parsed.config?.user === "admin" &&
      parsed.config?.auth === "password" &&
      "group_id" in parsed &&
      "sortOrder" in parsed,
    parsed ? JSON.stringify(parsed) : "(解析失败)",
  );

  // ---- 3. E2EE：桌面端开启端到端加密后同步的主机 ----
  const e2eeId = "d0000000-0000-4000-8000-000000000002";
  await api("/sync/push", {
    method: "POST",
    token,
    body: {
      items: [
        {
          itemId: e2eeId,
          kind: "profile",
          data: "U2FsdGVkX1+Zk9BEt1c1nGZlV3R3aW1hZ2UtZW5jcnlwdGVkLXBheWxvYWQ=", // 非 JSON 密文
          updatedAt: Date.now() - 1000,
          deleted: false,
        },
      ],
    },
  });
  const list2 = await api("/ssh/hosts", { token });
  const e2ee = list2.json?.hosts?.find((h) => h.id === e2eeId);
  check("E2EE 主机被标记 encrypted=true", e2ee?.encrypted === true, JSON.stringify(e2ee));
  check("E2EE 主机内容不被解析（host 为空、不泄露）", e2ee?.host === "" && e2ee?.username === "");

  const patchE2ee = await api(`/ssh/hosts/${e2eeId}`, {
    method: "PATCH",
    token,
    body: { host: "1.2.3.4", port: 22, username: "root", authType: "password" },
  });
  check("E2EE 主机不可编辑（403，防止绕过端到端加密）", patchE2ee.status === 403, `status=${patchE2ee.status}`);

  // ---- 4. 桌面端 agent 认证主机 ----
  const agentId = "d0000000-0000-4000-8000-000000000003";
  await api("/sync/push", {
    method: "POST",
    token,
    body: {
      items: [
        {
          itemId: agentId,
          kind: "profile",
          data: desktopProfilePayload(agentId, {
            name: "agent 认证机器",
            host: "192.0.2.33",
            port: 22,
            user: "root",
            auth: "agent",
          }),
          updatedAt: Date.now() - 500,
          deleted: false,
        },
      ],
    },
  });
  const list3 = await api("/ssh/hosts", { token });
  const agentHost = list3.json?.hosts?.find((h) => h.id === agentId);
  check("agent 认证主机 Web 端可见", !!agentHost && agentHost.host === "192.0.2.33");
  const probeAgent = await wsProbe({ hostId: agentId }, token, 8000);
  const agentMsg = probeAgent.frames.find((f) => f.type === "error")?.message ?? "";
  check("agent 主机连接时提示需客户端提供凭据", /SSH Agent/.test(agentMsg), agentMsg.slice(0, 60) || "(无 error 帧)");

  // ---- 5. 凭据默认不上传；勾选后才加密落盘 ----
  const db1 = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : Buffer.alloc(0);
  check("当前 DB 无任何凭据明文", !db1.includes(Buffer.from(SECRET, "utf8")));

  const probeNoCred = await wsProbe({ hostId: webId }, token, 8000);
  const noCredMsg = probeNoCred.frames.find((f) => f.type === "error")?.message ?? "";
  check("Web 无凭据主机直连被拒并提示输入", /未保存凭据/.test(noCredMsg), noCredMsg.slice(0, 60) || "(无 error 帧)");

  await api(`/ssh/hosts/${webId}`, {
    method: "PATCH",
    token,
    body: { host: "192.0.2.22", port: 2222, username: "admin", authType: "password", password: SECRET },
  });
  const list4 = await api("/ssh/hosts", { token });
  const meta4 = list4.json?.hosts?.find((h) => h.id === webId);
  check("勾选后 hasCredential=true", meta4?.hasCredential === true);
  const db2 = fs.readFileSync(dbFile);
  check("凭据落盘为密文（DB 无明文）", !db2.includes(Buffer.from(SECRET, "utf8")));
  check("列表响应不含明文", !JSON.stringify(list4.json).includes(SECRET));

  // ---- 6. 删除 → tombstone 随 pull 同步到桌面端 ----
  const del = await api(`/ssh/hosts/${webId}`, { method: "DELETE", token });
  check("删除主机成功", del.status === 200);
  const pull2 = await api("/sync/pull?since=0", { token });
  const tomb = pull2.json?.items?.find((it) => it.itemId === webId);
  check("删除以 tombstone（deleted=true）进入 sync pull", !!tomb && tomb.deleted === true, JSON.stringify(tomb));
  const list5 = await api("/ssh/hosts", { token });
  check("Web 列表已不含该主机", !list5.json?.hosts?.some((h) => h.id === webId));

  // ---- 7. 桌面端 push 的 local/serial 档案不混入 SSH 列表 ----
  const localId = "d0000000-0000-4000-8000-000000000004";
  await api("/sync/push", {
    method: "POST",
    token,
    body: {
      items: [
        {
          itemId: localId,
          kind: "profile",
          data: JSON.stringify({ id: localId, kind: "local", name: "本机 shell", config: { shell: "powershell" }, group_id: null, sortOrder: 0 }),
          updatedAt: Date.now(),
          deleted: false,
        },
      ],
    },
  });
  const list6 = await api("/ssh/hosts", { token });
  check("桌面端 local 档案不显示在 Web SSH 列表", !list6.json?.hosts?.some((h) => h.id === localId));

  const passed = results.filter(Boolean).length;
  console.log(`\n结果：${passed}/${results.length} 通过`);
} finally {
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 400));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log(`已清理临时数据目录 ${dataDir}`);
  } catch {
    /* ignore */
  }
  process.exit(results.length && results.every(Boolean) ? 0 : 1);
}
