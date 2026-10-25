import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc, toB64 } from "../ipc";
import { allLeaves } from "../paneTree";
import { scheduleSync, useStore } from "../store";
import { attachTerminals, observeOutput } from "./terminalBridge";
import { allowedUrl, has, IPC_ALLOW } from "./permissions";
import { register } from "./registry";
import { installedKind } from "./kinds";
import { confirm } from "../components/Dialog";
import type { Dispose, Host, Installed, Permission } from "./types";

export function createHost(plugin: Installed): Host {
  const controller = new AbortController();
  const application = installedKind(plugin) === "app";
  const disposals = new Set<Dispose>();
  const own = (dispose: Dispose) => {
    if (disposals.size >= 128) {
      dispose();
      throw new Error("插件活动资源数量超限");
    }
    disposals.add(dispose);
    return () => {
      disposals.delete(dispose);
      dispose();
    };
  };
  const assert = (permission: Permission) => {
    if (controller.signal.aborted) throw new Error("扩展已停用");
    if (
      application &&
      [
        "session-read",
        "session-write",
        "event-subscribe",
        "global-shortcut",
      ].includes(permission.type)
    )
      throw new Error("应用不能访问主窗口会话或全局快捷键");
    if (!has(plugin.manifest, permission)) {
      void invoke("plugin_authorize", {
        id: plugin.id,
        permission,
        action: permission.command ?? permission.type,
      }).catch(() => {});
      throw new Error(
        "插件未获授权: " + (permission.command ?? permission.type),
      );
    }
  };
  const authorize = async (permission: Permission, action: string) => {
    assert(permission);
    await invoke("plugin_authorize", { id: plugin.id, permission, action });
  };
  const sessions = () =>
    application
      ? []
      : useStore
          .getState()
          .tabs.flatMap((t) => allLeaves(t.layout))
          .filter((p) => p.sessionId && !p.exitInfo)
          .map((p) => ({
            id: p.sessionId!,
            title: p.title,
            profileId: p.profileId,
            kind: p.kind,
          }));
  const host: Host = {
    ui: {
      registerPanel(id, title, render) {
        assert({ type: "ui-panel" });
        return own(
          register(id, { pluginId: plugin.id, kind: "panel", title, render }),
        );
      },
      registerCommand(id, title, run, shortcut) {
        assert({ type: "ui-command" });
        return own(
          register(id, {
            pluginId: plugin.id,
            kind: "command",
            title,
            shortcut,
            run: () => {
              if (controller.signal.aborted) return;
              try {
                Promise.resolve(run()).catch((e) =>
                  useStore.getState().showToast(String(e), "error"),
                );
              } catch (e) {
                useStore.getState().showToast(String(e), "error");
              }
            },
          }),
        );
      },
      registerSetting(id, title, render) {
        assert({ type: "ui-setting" });
        return own(
          register(id, { pluginId: plugin.id, kind: "setting", title, render }),
        );
      },
      setStatusBar(id, text) {
        assert({ type: "ui-panel" });
        return own(
          register(id, { pluginId: plugin.id, kind: "status", title: text }),
        );
      },
    },
    id: plugin.id,
    signal: controller.signal,
    authorize,
    sessions,
    async invoke<T>(command: string, args = {}) {
      assert({ type: "ipc", command });
      if (!IPC_ALLOW.has(command)) throw new Error("IPC 对插件禁用");
      const result = await invoke<T>("plugin_call", {
        id: plugin.id,
        command,
        args,
      });
      if (command === "theme_install") {
        await useStore.getState().loadSettings();
        await useStore.getState().saveSetting("theme", "custom");
      }
      if (["snippet_save", "snippet_delete", "theme_install"].includes(command))
        scheduleSync();
      return result;
    },
    async write(id, text) {
      if (
        plugin.source !== "builtin" &&
        sessions().find((s) => s.id === id)?.kind !== "ssh"
      ) {
        void invoke("plugin_denied", {
          id: plugin.id,
          action: "third-party-local-session-write",
        }).catch(() => {});
        throw new Error("第三方插件只能向远端 SSH 会话写入，不能执行本地命令");
      }
      await authorize({ type: "session-write" }, "session.write");
      if (!sessions().some((s) => s.id === id)) throw new Error("会话已结束");
      await ipc.sessionWrite(id, toB64(text));
    },
    async writeBytes(id, bytes) {
      if (plugin.source !== "builtin" || !sessions().some((s) => s.id === id))
        throw new Error("字节写入只对内置协议适配器的活动会话开放");
      await authorize({ type: "session-write" }, "session.writeBytes");
      let text = "";
      for (const b of bytes) text += String.fromCharCode(b);
      await ipc.sessionWrite(id, btoa(text));
    },
    output(cb) {
      assert({ type: "session-read" });
      return own(
        observeOutput((id, text) => {
          if (!controller.signal.aborted) cb(id, text);
        }),
      );
    },
    onSessions(cb) {
      assert({ type: "event-subscribe" });
      return own(
        useStore.subscribe(() => {
          if (!controller.signal.aborted) cb(sessions());
        }),
      );
    },
    terminals(cb) {
      assert({ type: "session-read" });
      if (plugin.source !== "builtin" || plugin.id !== "com.termone.zmodem")
        throw new Error("原生终端对象仅对内置协议适配器开放");
      return own(attachTerminals(cb));
    },
    storage: {
      async get<T>(key: string) {
        assert({ type: "storage" });
        return invoke<T | null>("plugin_storage", {
          id: plugin.id,
          key,
          value: null,
          remove: false,
        });
      },
      async set(key, value) {
        assert({ type: "storage" });
        await invoke("plugin_storage", {
          id: plugin.id,
          key,
          value,
          remove: false,
        });
      },
      async remove(key) {
        assert({ type: "storage" });
        await invoke("plugin_storage", {
          id: plugin.id,
          key,
          value: null,
          remove: true,
        });
      },
    },
    toast(message, error = false) {
      assert({ type: "ui-toast" });
      useStore
        .getState()
        .showToast(message.slice(0, 1000), error ? "error" : "info");
    },
    async confirm(message) {
      if (controller.signal.aborted) return false;
      return confirm(
        { title: plugin.manifest.name, message },
        controller.signal,
      );
    },
    async openDialog(directory = false) {
      await authorize({ type: "dialog-open" }, "dialog.open");
      const p = await open({ directory, multiple: false });
      if (controller.signal.aborted) return null;
      if (typeof p === "string")
        await invoke("plugin_grant_path", { id: plugin.id, path: p });
      return typeof p === "string" ? p : null;
    },
    async fetch(url, init) {
      let u: URL;
      try {
        u = allowedUrl(plugin.manifest, url);
      } catch (e) {
        void invoke("plugin_denied", {
          id: plugin.id,
          action: "network-denied",
        }).catch(() => {});
        throw e;
      }
      await authorize({ type: "net", domain: u.hostname }, "fetch:" + u.origin);
      return fetch(u, {
        ...init,
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    },
    setInterval(fn, ms) {
      if (controller.signal.aborted) throw new Error("扩展已停用");
      const timer = setInterval(
        () => {
          try {
            fn();
          } catch {
            /* callback isolation */
          }
        },
        Math.max(100, ms),
      );
      return own(() => clearInterval(timer));
    },
    command(title, run, shortcut) {
      return host.ui.registerCommand(crypto.randomUUID(), title, run, shortcut);
    },
    async globalShortcut(shortcut) {
      await authorize({ type: "global-shortcut" }, "global-shortcut.register");
      await invoke("quake_set", { shortcut });
      return own(() => {
        void invoke("quake_set", { shortcut: null }).catch(() => {});
      });
    },
    dispose() {
      if (controller.signal.aborted) return;
      controller.abort();
      for (const d of [...disposals].reverse()) {
        try {
          d();
        } catch {
          /* cleanup every registration */
        }
      }
      disposals.clear();
    },
  };
  return host;
}
