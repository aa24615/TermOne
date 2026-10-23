// Capture TermOne light-theme screenshots via Edge + Chrome DevTools Protocol.
// Zero dependencies: Node >= 22 native fetch + WebSocket.
//
//   node tools/cdp_shots.mjs
//
// Prereq: vite dev server on http://127.0.0.1:5173
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9223;
const APP = "http://127.0.0.1:5173";
const OUT = "D:\\www\\nas-claw\\sshz\\docs\\screenshots";
const W = 1240, H = 820;

// Minimal Tauri bridge mock injected before page scripts: makes the app
// believe it runs inside Tauri so profile dialog / terminal tab open fine.
const MOCK = `
window.__TAURI_INTERNALS__ = {
  metadata: {
    currentWindow: { label: "main" },
    currentWebview: { windowLabel: "main", label: "main" },
  },
  transformCallback: (cb) => { (window.__cbs = window.__cbs || []).push(cb); return window.__cbs.length; },
  invoke: async (cmd) => {
    if (cmd === "session_open") return { id: "mock-1", kind: "local", title: "PowerShell" };
    if (["profile_list", "groups_list", "settings_all", "serial_list_ports", "shells_list"].includes(cmd)) return [];
    if (cmd === "default_shell") return "powershell";
    return null;
  },
};
`;

// PowerShell-style demo output injected straight into the xterm DOM renderer.
const DEMO_ROWS = [
  "",
  "PS C:\\Users\\demo&gt; echo TermOne - lightweight terminal",
  "TermOne - lightweight terminal",
  "",
  "PS C:\\Users\\demo&gt; Get-Date",
  "",
  "2026年10月23日 星期五 13:25:08",
  "",
  "PS C:\\Users\\demo&gt; Get-Location",
  "",
  "Path",
  "----",
  "C:\\Users\\demo",
  "",
  "PS C:\\Users\\demo&gt;",
].map((t) => `<div>${t || "&nbsp;"}</div>`).join("");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = mkdtempSync(join(tmpdir(), "edge-cdp-"));
const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--no-proxy-server",
  "--no-first-run",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userData}`,
  `--window-size=${W},${H}`,
  "about:blank",
], { stdio: "ignore" });

let ws;
try {
  let version = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      version = await r.json();
      break;
    } catch { await sleep(300); }
  }
  if (!version) throw new Error("CDP endpoint never came up");
  console.log("CDP:", version.Browser);

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: MOCK });
  await send("Emulation.setDeviceMetricsOverride", {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    return r.result?.result?.value;
  };
  const clickSel = (sel) => evalJs(
    `(() => { const el = document.querySelector(${JSON.stringify(sel)});` +
    ` if (!el) return "MISSING"; el.click(); return "OK"; })()`);
  const clickText = (scope, text) => evalJs(
    `(() => { const els = [...document.querySelectorAll(${JSON.stringify(scope)})];` +
    ` const el = els.find(b => b.textContent.trim().includes(${JSON.stringify(text)}));` +
    ` if (!el) return "MISSING"; el.click(); return "OK"; })()`);
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const buf = Buffer.from(r.result.data, "base64");
    writeFileSync(join(OUT, name), buf);
    console.log(`saved ${name} (${buf.length} bytes)`);
  };

  await send("Page.navigate", { url: APP });
  await sleep(4500);

  // 1. welcome pane
  await shot("welcome.png");

  // 2. new-profile dialog
  console.log("click 新建档案:", await clickSel('[title="新建档案"]'));
  await sleep(1500);
  await shot("profile-new.png");
  console.log("close dialog:", await clickSel('.modal .icon-btn[aria-label="关闭"]'));
  await sleep(800);

  // 3. settings dialog
  console.log("click 设置:", await clickText(".side-btn", "设置"));
  await sleep(1500);
  await shot("settings.png");
  console.log("close settings:", await clickSel('.modal .icon-btn[aria-label="关闭"]'));
  await sleep(800);

  // 4. local terminal tab (mocked session), then paint demo output
  console.log("click 新建本地终端:", await clickSel(".tab-add"));
  await sleep(2500);
  const inject = await evalJs(
    `(() => { const rows = document.querySelector('.xterm-rows');` +
    ` if (!rows) return "NO_ROWS"; rows.innerHTML = ${JSON.stringify(DEMO_ROWS)};` +
    ` const st = document.createElement('style');` +
    ` st.textContent = '.xterm-screen * { animation: none !important; } .xterm-cursor { opacity: 1 !important; }';` +
    ` document.head.appendChild(st); return "OK"; })()`);
  console.log("inject demo rows:", inject);
  await sleep(500);
  await shot("terminal-local.png");

  console.log("done");
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  edge.kill();
  await sleep(500);
  try { rmSync(userData, { recursive: true, force: true }); } catch {}
}
