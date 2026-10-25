import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { encryptData, decryptData } from "../apps/desktop/src/crypto.ts";
import {
  validateManifest,
  safePath,
  allowedUrl,
} from "../apps/desktop/src/plugin/permissions.ts";
import {
  readPackage,
  bytesB64,
  verifyDigest,
} from "../apps/desktop/src/plugin/package.ts";
import { retryDelay } from "../apps/desktop/src/reconnection.ts";
import {
  saveLayouts,
  readLayouts,
} from "../apps/desktop/src/workspaceLayout.ts";
import { leafNode, newPane } from "../apps/desktop/src/paneTree.ts";
import { useStore } from "../apps/desktop/src/store.ts";
import { createHost } from "../apps/desktop/src/plugin/hostApi.ts";
import { DEFAULT_SETTINGS } from "../apps/desktop/src/types.ts";
import { zipSync } from "fflate";

globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};
globalThis.document = {
  documentElement: {
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
  },
};
const manifest = {
  id: "org.example.test",
  name: "Fixture",
  version: "1.0.0",
  entry: "index.js",
  hostApi: { major: 1, minor: 0, patch: 0 },
  files: ["index.js"],
  permissions: [
    { type: "ui-panel" },
    { type: "net", domain: "api.example.com" },
  ],
  description: "",
  author: "Tests",
};
beforeEach(() => {
  clearMocks();
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS },
    auth: {
      token: "test",
      user: null,
      syncing: false,
      lastSyncAt: null,
      error: null,
    },
    syncPassphrase: null,
    toasts: [],
  });
});

test("E2EE: randomized authenticated roundtrip, Unicode, wrong key and tampering", async () => {
  const plain = "终端🔐\n" + "x".repeat(1024);
  const a = await encryptData(plain, "passphrase");
  const b = await encryptData(plain, "passphrase");
  assert.notEqual(a, b);
  assert.equal(await decryptData(a, "passphrase"), plain);
  await assert.rejects(decryptData(a, "wrong"));
  const parts = a.split("::");
  const bytes = Buffer.from(parts[1], "base64");
  bytes[35] ^= 1;
  await assert.rejects(
    decryptData("enc::" + bytes.toString("base64"), "passphrase"),
  );
  await assert.rejects(decryptData("enc::bad", "passphrase"));
});
test("Locked E2EE cannot fetch, export, push or advance sync cursor", async () => {
  const calls = [];
  mockIPC((cmd) => {
    calls.push(cmd);
  });
  globalThis.fetch = async () => {
    throw new Error("must not fetch");
  };
  useStore.setState({ settings: { ...DEFAULT_SETTINGS, e2eeEnabled: true } });
  assert.equal(await useStore.getState().syncNow(), false);
  assert.deepEqual(calls, []);
  assert.equal(useStore.getState().auth.syncing, false);
});
test("Wrong E2EE key cannot push, apply data or advance the cursor", async () => {
  const cipher = await encryptData('{"name":"remote"}', "correct");
  const calls = [];
  const requests = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    if (cmd === "sync_last_pull") return 0;
  });
  globalThis.fetch = async (url, init) => {
    requests.push([url, init]);
    return new Response(
      JSON.stringify({
        serverTime: 100,
        items: [
          {
            itemId: "p",
            kind: "profile",
            data: cipher,
            updatedAt: 99,
            deleted: false,
          },
        ],
      }),
    );
  };
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, e2eeEnabled: true },
    syncPassphrase: "wrong",
  });
  assert.equal(await useStore.getState().syncNow(), false);
  assert.deepEqual(calls, ["sync_last_pull"]);
  assert.equal(requests.length, 1);
  assert.match(requests[0][0], /pull/);
  assert.equal(useStore.getState().auth.syncing, false);
});
test("Successful E2EE sync decrypts before apply and uploads ciphertext", async () => {
  const cipher = await encryptData('{"name":"remote"}', "key");
  const calls = [];
  let sent;
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "sync_last_pull") return 0;
    if (cmd === "sync_export_dirty")
      return [
        {
          itemId: "local",
          kind: "profile",
          data: '{"host":"private"}',
          updatedAt: 200,
          deleted: false,
        },
      ];
    if (cmd === "settings_all") return [{ key: "e2eeEnabled", value: "1" }];
    if (cmd === "profile_list" || cmd === "groups_list") return [];
  });
  globalThis.fetch = async (url, init) => {
    if (url.includes("push")) sent = JSON.parse(init.body);
    return new Response(
      JSON.stringify(
        url.includes("pull")
          ? {
              serverTime: 100,
              items: [
                {
                  itemId: "remote",
                  kind: "profile",
                  data: cipher,
                  updatedAt: 99,
                  deleted: false,
                },
              ],
            }
          : {},
      ),
    );
  };
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS, e2eeEnabled: true },
    syncPassphrase: "key",
  });
  assert.equal(await useStore.getState().syncNow(), true);
  assert.match(sent.items[0].data, /^enc::/);
  assert.equal(
    await decryptData(sent.items[0].data, "key"),
    '{"host":"private"}',
  );
  assert.equal(
    calls.find((c) => c[0] === "sync_apply_pull")[1].items[0].data,
    '{"name":"remote"}',
  );
  assert.ok(calls.some((c) => c[0] === "sync_set_last_pull"));
});
test("Package validation rejects traversal, unsupported permissions, missing entry and future API", () => {
  for (const path of [
    "../x",
    "/x",
    "C:/x",
    "x\\y",
    "a/../b",
    "x:stream",
    "a//b",
    "x.",
  ])
    assert.equal(safePath(path), false, path);
  assert.equal(safePath("assets/icon.svg"), true);
  assert.equal(validateManifest(manifest).id, manifest.id);
  assert.throws(() =>
    validateManifest({
      ...manifest,
      permissions: [{ type: "ipc", command: "secret_set" }],
    }),
  );
  assert.throws(() =>
    validateManifest({
      ...manifest,
      hostApi: { major: 2, minor: 0, patch: 0 },
    }),
  );
  const entries = {
    "termone.plugin.json": bytesB64(
      new TextEncoder().encode(JSON.stringify(manifest)),
    ),
  };
  assert.throws(() => readPackage({ files: entries }));
  entries["index.js"] = bytesB64(
    new TextEncoder().encode("export function activate() {}"),
  );
  assert.equal(readPackage({ files: entries }).manifest.id, manifest.id);
  const archive = zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([k, v]) => [k, Buffer.from(v, "base64")]),
    ),
  );
  assert.equal(
    readPackage({ archive: bytesB64(archive) }).manifest.id,
    manifest.id,
  );
});
test("Network policy is exact HTTPS, rejects credentials, subdomains and digest tampering", async () => {
  assert.equal(
    allowedUrl(manifest, "https://api.example.com/v1").hostname,
    "api.example.com",
  );
  for (const url of [
    "http://api.example.com",
    "https://user:secret@api.example.com",
    "https://evil.api.example.com",
    "https://api.example.com.attacker.test",
  ])
    assert.throws(() => allowedUrl(manifest, url));
  const data = new Uint8Array([1, 2, 3]);
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", data),
  ).toString("hex");
  await verifyDigest(data, hash);
  await assert.rejects(verifyDigest(new Uint8Array([1]), hash));
});
test("Host rejects secret/undeclared IPC and revokes APIs, events and timers on disposal", async () => {
  mockIPC(() => null);
  const plugin = {
    id: manifest.id,
    manifest: {
      ...manifest,
      permissions: [
        ...manifest.permissions,
        { type: "storage" },
        { type: "session-read" },
      ],
    },
    source: "local",
    enabled: true,
  };
  const host = createHost(plugin);
  await assert.rejects(host.invoke("secret_set"));
  await assert.rejects(host.invoke("profile_list"));
  let ticks = 0;
  host.setInterval(() => ticks++, 100);
  host.dispose();
  await new Promise((r) => setTimeout(r, 140));
  assert.equal(ticks, 0);
  await assert.rejects(host.storage.get("x"));
});
test("Reconnect is bounded with exponential backoff", () => {
  assert.equal(retryDelay(0, 5, 5), 5000);
  assert.equal(retryDelay(4, 5, 5), 60000);
  assert.equal(retryDelay(5, 5, 5), null);
  assert.equal(retryDelay(-1, 5, 5), null);
});
test("Saved layouts preserve splits without serializing session IDs or secrets", () => {
  const pane = newPane({
    kind: "ssh",
    profileId: "host",
    sessionId: "private-session-id",
    title: "user@host",
  });
  const raw = saveLayouts([
    {
      id: "tab",
      layout: {
        type: "split",
        id: "s",
        dir: "row",
        sizes: [1, 2],
        children: [leafNode(pane), leafNode(newPane({ kind: "local" }))],
      },
    },
  ]);
  assert.ok(!raw.includes("private-session-id"));
  assert.deepEqual(readLayouts(raw)[0].sizes, [1, 2]);
  assert.throws(() =>
    readLayouts(
      '{"version":1,"tabs":[{"type":"split","dir":"row","sizes":[-1,1],"children":[]}]}',
    ),
  );
});

test("Plugin disposal removes contributions, output subscriptions and pending confirmation", async () => {
  const { useRegistry } = await import(
    "../apps/desktop/src/plugin/registry.ts"
  );
  const { registerTerminal } = await import(
    "../apps/desktop/src/plugin/terminalBridge.ts"
  );
  mockIPC(() => null);
  const host = createHost({
    id: manifest.id,
    manifest: {
      ...manifest,
      permissions: [
        ...manifest.permissions,
        { type: "ui-command" },
        { type: "session-read" },
      ],
    },
    source: "local",
    enabled: true,
  });
  host.ui.registerCommand("run", "Run", () => {});
  host.ui.registerPanel("panel", "Panel", () => null);
  assert.equal(Object.keys(useRegistry.getState().items).length, 2);
  let output = 0;
  const terminal = registerTerminal("fixture", { loadAddon() {} });
  host.output(() => output++);
  terminal.output(new TextEncoder().encode("before"));
  assert.equal(output, 1);
  const answer = host.confirm("pending");
  host.dispose();
  assert.equal(await answer, false);
  assert.equal(Object.keys(useRegistry.getState().items).length, 0);
  terminal.output(new TextEncoder().encode("after"));
  assert.equal(output, 1);
  terminal.dispose();
});
test("Third party session writes reject local commands and stale sessions", async () => {
  const calls = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    return null;
  });
  const { newPane, leafNode } = await import("../apps/desktop/src/paneTree.ts");
  const local = newPane({ kind: "local", sessionId: "local" });
  const remote = newPane({ kind: "ssh", sessionId: "remote" });
  useStore.setState({
    tabs: [
      { id: "local", layout: leafNode(local) },
      { id: "remote", layout: leafNode(remote) },
    ],
  });
  const host = createHost({
    id: manifest.id,
    manifest: { ...manifest, permissions: [{ type: "session-write" }] },
    source: "local",
    enabled: true,
  });
  await assert.rejects(host.write("local", "echo bad"));
  await assert.rejects(host.write("ended", "echo bad"));
  assert.equal(calls.includes("session_write"), false);
  await host.write("remote", "echo safe\r");
  assert.ok(calls.includes("session_write"));
  await assert.rejects(host.writeBytes("local", new Uint8Array([1])));
  host.dispose();
});

test("Changing account during pull prevents applying or uploading another account's data", async () => {
  const calls = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    if (cmd === "sync_last_pull") return 0;
  });
  globalThis.fetch = async () => {
    useStore.setState((s) => ({
      auth: { ...s.auth, token: "different-account" },
    }));
    return new Response(
      JSON.stringify({
        serverTime: 50,
        items: [
          {
            itemId: "remote",
            kind: "profile",
            data: "{}",
            updatedAt: 40,
            deleted: false,
          },
        ],
      }),
    );
  };
  assert.equal(await useStore.getState().syncNow(), false);
  assert.deepEqual(calls, ["sync_last_pull"]);
});

test("Normal SSH exit statuses do not reconnect, transport failure is scheduled and stoppable", () => {
  const pane = newPane({
    kind: "ssh",
    profileId: "host",
    sessionId: "exit-session",
  });
  useStore.setState({ tabs: [{ id: "tab", layout: leafNode(pane) }] });
  useStore.getState().markSessionExit("exit-session", 1);
  assert.match(useStore.getState().tabs[0].layout.pane.exitInfo, /代码 1/);
  useStore.getState().markSessionExit("exit-session", 255);
  assert.match(useStore.getState().tabs[0].layout.pane.exitInfo, /秒后重试/);
  useStore.getState().stopReconnect(pane.id);
  assert.match(useStore.getState().tabs[0].layout.pane.exitInfo, /已停止/);
});
test("Splitting the welcome tab still preserves its layout for restore", () => {
  const raw = saveLayouts([
    {
      id: "welcome",
      layout: {
        type: "split",
        id: "s",
        dir: "row",
        sizes: [1, 1],
        children: [
          leafNode(newPane({ kind: "welcome" })),
          leafNode(newPane({ kind: "local" })),
        ],
      },
    },
  ]);
  assert.equal(readLayouts(raw).length, 1);
  assert.equal(readLayouts(raw)[0].children[0].kind, "welcome");
});

test("Applications declare a compatible API and cannot request terminal hooks", () => {
  const app = {
    ...manifest,
    kind: "app",
    hostApi: { major: 1, minor: 1, patch: 0 },
  };
  assert.equal(validateManifest(app).kind, "app");
  assert.throws(() => validateManifest({ ...app, kind: "unknown" }));
  assert.throws(() =>
    validateManifest({ ...app, hostApi: { major: 1, minor: 0, patch: 0 } }),
  );
  for (const type of [
    "session-read",
    "session-write",
    "event-subscribe",
    "global-shortcut",
  ])
    assert.throws(() => validateManifest({ ...app, permissions: [{ type }] }));
});
test("Legacy disabled SFTP opens directly without enabling or activating a main-window panel", async () => {
  const { usePlugins, openPlugin } = await import(
    "../apps/desktop/src/plugin/runtime.ts"
  );
  const { default: catalog } = await import(
    "../apps/desktop/src/plugin/catalog.json",
    { with: { type: "json" } }
  );
  const m = { ...catalog.find((p) => p.id === "com.termone.sftp") };
  delete m.kind;
  const item = { id: m.id, manifest: m, source: "builtin", enabled: false };
  usePlugins.setState({ installed: [item], selected: null, active: {} });
  const calls = [];
  let finish;
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "application_open")
      return new Promise((resolve) => (finish = resolve));
  });
  const first = openPlugin(item.id),
    second = openPlugin(item.id);
  assert.equal(calls.filter((c) => c[0] === "application_open").length, 1);
  finish();
  await Promise.all([first, second]);
  assert.equal(usePlugins.getState().selected, null);
  assert.deepEqual(usePlugins.getState().active, {});
});
test("Applications need no enable toggle while disabled plugins still cannot open", async () => {
  const { usePlugins, openPlugin, togglePlugin } = await import("../apps/desktop/src/plugin/runtime.ts");
  const { canOpenExtension } = await import("../apps/desktop/src/plugin/kinds.ts");
  const plugin = { id: manifest.id, manifest, source: "local", enabled: false };
  const app = { ...plugin, id: "org.example.app", manifest: { ...manifest, id: "org.example.app", kind: "app" } };
  assert.equal(canOpenExtension(plugin), false);
  assert.equal(canOpenExtension(app), true);
  const calls = [];
  mockIPC((cmd) => { calls.push(cmd); });
  usePlugins.setState({ installed: [plugin, app], selected: null, active: {} });
  await openPlugin(plugin.id);
  assert.equal(usePlugins.getState().selected, null);
  await assert.rejects(togglePlugin(app), /安装后即可使用/);
  assert.deepEqual(calls, []);
  await openPlugin(app.id);
  assert.deepEqual(calls, ["application_open"]);
});
test("Application Host exposes no main sessions or terminal write path", async () => {
  const calls = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    return null;
  });
  const app = createHost({
    id: manifest.id,
    manifest: {
      ...manifest,
      kind: "app",
      permissions: [
        { type: "session-write" },
        { type: "session-read" },
        { type: "event-subscribe" },
      ],
    },
    source: "builtin",
    enabled: true,
  });
  assert.deepEqual(app.sessions(), []);
  await assert.rejects(app.write("remote", "echo blocked"));
  assert.throws(() => app.output(() => {}));
  assert.throws(() => app.onSessions(() => {}));
  assert.ok(!calls.includes("session_write"));
  app.dispose();
});
test("Application classification cannot be spoofed by reusing an official id", async () => {
  const { installedKind, kindOf } = await import(
    "../apps/desktop/src/plugin/kinds.ts"
  );
  assert.equal(kindOf(manifest), "plugin");
  assert.equal(
    installedKind({
      id: "com.termone.sftp",
      manifest,
      source: "local",
      enabled: true,
    }),
    "plugin",
  );
  assert.equal(
    installedKind({
      id: "com.termone.sftp",
      manifest,
      source: "builtin",
      enabled: true,
    }),
    "app",
  );
});
