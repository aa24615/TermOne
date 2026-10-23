/**
 * 凭据策略冒烟：**密钥默认永不上传服务端**。
 *
 * 覆盖：
 *   1. 创建主机不带凭据 → hasCredential=false，DB 无明文
 *   2. 无凭据主机直接连 → 服务端拒绝并要求客户端提供
 *   3. 连接时由客户端临时提供凭据 → 可用（且不落盘）
 *   4. 用户勾选「保存到服务端」→ hasCredential=true，DB 有密文但无明文
 *   5. 取消勾选 → 服务端凭据被删除
 *
 * 用法：node tools/ssh_cred_smoke.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = process.env.SMOKE_PORT || "8892";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "termone-cred-"));
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

function wsProbe(payload, token, timeoutMs = 15000) {
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

const dbFile = path.join(dataDir, "termone-server.db");
const SECRET = "super-secret-pw-2026";

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

  // ---- 1. 默认不上传：只提交元数据 ----
  const created = await api("/ssh/hosts", {
    method: "POST",
    token,
    body: { host: "192.0.2.20", port: 22, username: "root", authType: "password" },
  });
  const hostId = created.json?.id;
  check("无凭据也可创建主机", created.status === 200 && !!hostId, `status=${created.status}`);

  const list1 = await api("/ssh/hosts", { token });
  const meta1 = list1.json?.hosts?.find((h) => h.id === hostId);
  check("列表 hasCredential=false（服务端不持有密钥）", meta1?.hasCredential === false);

  const db1 = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : Buffer.alloc(0);
  check("DB 无凭据明文", !db1.includes(Buffer.from(SECRET, "utf8")));

  // ---- 2. 无凭据直接连 → 服务端拒绝 ----
  const probe1 = await wsProbe({ hostId }, token, 8000);
  const msg1 = probe1.frames.find((f) => f.type === "error")?.message ?? "";
  check("无凭据连接被拒并提示客户端输入", /未保存凭据/.test(msg1), msg1 || "(无 error 帧)");

  // ---- 3. 客户端临时提供凭据（127.0.0.1:1 必然拒绝连接，用于快速验证管线） ----
  const probe2 = await wsProbe({ host: "127.0.0.1", port: 1, username: "root", authType: "password", password: SECRET }, token);
  const msg2 = probe2.frames.find((f) => f.type === "error")?.message ?? "";
  check("临时凭据被接受并真正发起 SSH", !!msg2 && !/未保存凭据|密码不能为空/.test(msg2), msg2.slice(0, 60));

  const db2 = fs.readFileSync(dbFile);
  check("临时凭据未落盘（DB 仍无明文）", !db2.includes(Buffer.from(SECRET, "utf8")));

  const list2 = await api("/ssh/hosts", { token });
  check("临时连接未新增主机记录", (list2.json?.hosts?.length ?? 0) === 1);

  // ---- 4. 用户勾选保存 → 上传并加密 ----
  await api(`/ssh/hosts/${hostId}`, {
    method: "PATCH",
    token,
    body: { host: "192.0.2.20", port: 22, username: "root", authType: "password", password: SECRET },
  });
  const list3 = await api("/ssh/hosts", { token });
  const meta3 = list3.json?.hosts?.find((h) => h.id === hostId);
  check("勾选后 hasCredential=true", meta3?.hasCredential === true);

  const db3 = fs.readFileSync(dbFile);
  check("落盘的是密文（无明文）", !db3.includes(Buffer.from(SECRET, "utf8")));
  check("列表响应不含明文", !JSON.stringify(list3.json).includes(SECRET));

  const probe3 = await wsProbe({ hostId }, token, 12000);
  const msg3 = probe3.frames.find((f) => f.type === "error")?.message ?? "";
  check("服务端凭据可用于连接（不再要求输入）", !/未保存凭据/.test(msg3), msg3.slice(0, 60) || "(超时)");

  // ---- 5. 取消勾选 → 立即删除服务端凭据 ----
  await api(`/ssh/hosts/${hostId}`, {
    method: "PATCH",
    token,
    body: { host: "192.0.2.20", port: 22, username: "root", authType: "password", clearCredential: true },
  });
  const list4 = await api("/ssh/hosts", { token });
  const meta4 = list4.json?.hosts?.find((h) => h.id === hostId);
  check("取消勾选后 hasCredential=false（服务端凭据已删除）", meta4?.hasCredential === false);

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
