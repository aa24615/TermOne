import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";

// ---- 1. 静态加密验证：数据库文件里不应出现明文密码 ----
// 用法：node tools/ssh_ws_smoke.mjs <jwt>   （需先启动服务端，TERMONE_DATA 与本脚本一致）
const dataDir = process.env.TERMONE_DATA || "C:/Users/Administrator/termone-smoke";
const dbFile = path.join(dataDir, "termone-server.db");
if (!fs.existsSync(dbFile)) {
  console.log(`未找到数据库 ${dbFile}，跳过静态加密检查（请确认已启动服务端并创建过主机）`);
} else {
  const dbBytes = fs.readFileSync(dbFile);
  const hasPlain = dbBytes.includes(Buffer.from("super-secret-pw", "utf8"));
  console.log("DB 文件含明文密码?", hasPlain, hasPlain ? "❌ 未加密" : "✅ 已加密");
}

const keyFile = path.join(dataDir, "cred.key");
console.log("主密钥文件存在?", fs.existsSync(keyFile), "路径:", keyFile);

// ---- 2. WebSocket 冒烟 ----
const port = process.env.SMOKE_PORT || "8791";
const token = process.argv[2] ?? "";
const base = `ws://127.0.0.1:${port}/api/ws/ssh`;

function probe(label, url, onOpen) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      console.log(`[${label}] 超时（未收到任何帧）`);
      try { ws.close(); } catch {}
      resolve();
    }, 12000);
    ws.on("open", () => {
      console.log(`[${label}] WS 已连接`);
      onOpen?.(ws);
    });
    ws.on("message", (raw) => {
      const s = String(raw);
      console.log(`[${label}] 收到帧:`, s.slice(0, 160));
    });
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      console.log(`[${label}] 关闭 code=${code} reason=${reason || "(无)"}`);
      resolve();
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      console.log(`[${label}] 错误: ${e.message}`);
      resolve();
    });
  });
}

// 2a. 无 token → 期望 4401
await probe("未登录", base);

// 2b. 带 token，连一个不可达地址 → 期望收到 error 帧（证明 ssh2 管线已跑通）
await probe("已登录-不可达主机", `${base}?token=${encodeURIComponent(token)}`, (ws) => {
  ws.send(
    JSON.stringify({
      type: "connect",
      cols: 120,
      rows: 32,
      host: "192.0.2.10",
      port: 22,
      username: "root",
      authType: "password",
      password: "whatever",
      save: false,
    }),
  );
});

// 2c. 带 token 但主机不存在 → 期望 error「主机不存在或凭据无法解密」
await probe("已登录-无效hostId", `${base}?token=${encodeURIComponent(token)}`, (ws) => {
  ws.send(JSON.stringify({ type: "connect", cols: 120, rows: 32, hostId: "not-a-real-id" }));
});

console.log("冒烟结束");
process.exit(0);
