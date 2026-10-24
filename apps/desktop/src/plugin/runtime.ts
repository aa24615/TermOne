import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { isTauri } from "../env";
import { useStore } from "../store";
import { createHost } from "./hostApi";
import type { Host, Installed, PluginModule } from "./types";

const modules: Record<string, () => Promise<PluginModule>> = {
  "com.termone.sftp": () => import("../plugins/sftp"),
  "com.termone.snippets": () => import("../plugins/snippets"),
  "com.termone.session-log": () => import("../plugins/session-log"),
  "com.termone.broadcast": () => import("../plugins/broadcast"),
  "com.termone.ai-assist": () => import("../plugins/ai-assist"),
  "com.termone.triggers": () => import("../plugins/triggers"),
  "com.termone.theme-market": () => import("../plugins/theme-market"),
  "com.termone.quake": () => import("../plugins/quake"),
  "com.termone.zmodem": () => import("../plugins/zmodem"),
};
const background = new Set([
  "com.termone.triggers",
  "com.termone.quake",
  "com.termone.zmodem",
]);
interface Active {
  module: PluginModule;
  host: Host;
}
export const usePlugins = create<{
  installed: Installed[];
  active: Record<string, Active>;
  selected: string | null;
  errors: Record<string, string>;
  loading: string[];
}>(() => ({
  installed: [],
  active: {},
  selected: null,
  errors: {},
  loading: [],
}));
const pending = new Map<string, Promise<void>>();
const generations = new Map<string, number>();
const hosts = new Map<string, Host>();
let initializing: Promise<void> | null = null;
export async function refreshPlugins() {
  if (!isTauri()) return;
  const installed = await invoke<Installed[]>("plugin_list");
  usePlugins.setState({ installed });
}
export async function initPlugins() {
  if (!initializing)
    initializing = (async () => {
      await refreshPlugins();
      for (const p of usePlugins.getState().installed)
        if (p.enabled && background.has(p.id)) void activatePlugin(p.id);
    })();
  return initializing;
}
export function stopPlugin(id: string) {
  generations.set(id, (generations.get(id) ?? 0) + 1);
  hosts.get(id)?.dispose();
  hosts.delete(id);
  const current = usePlugins.getState().active[id];
  current?.host.dispose();
  usePlugins.setState((s) => {
    const active = { ...s.active };
    delete active[id];
    return { active, selected: s.selected === id ? null : s.selected };
  });
}
export async function activatePlugin(id: string): Promise<void> {
  if (usePlugins.getState().active[id]) return;
  if (pending.has(id)) {
    if (hosts.get(id)?.signal.aborted || !hosts.has(id)) {
      await pending.get(id);
      return activatePlugin(id);
    }
    return pending.get(id)!;
  }
  const p = usePlugins
    .getState()
    .installed.find((p) => p.id === id && p.enabled);
  if (!p) return;
  const generation = generations.get(id) ?? 0;
  const host = createHost(p);
  hosts.set(id, host);
  const work = (async () => {
    usePlugins.setState((s) => ({
      loading: [...s.loading, id],
      errors: { ...s.errors, [id]: "" },
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const module = await Promise.race([
        p.source === "builtin" && modules[id]
          ? modules[id]()
          : import("./sandbox").then((m) => m.externalModule(p)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("插件加载超时")), 5000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (host.signal.aborted || (generations.get(id) ?? 0) !== generation) {
        host.dispose();
        return;
      }
      const dispose = await Promise.race([
        module.activate?.(host),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("插件激活超时")), 5000);
        }),
      ]);
      if (typeof dispose === "function")
        host.signal.addEventListener("abort", dispose, { once: true });
      if ((generations.get(id) ?? 0) !== generation) {
        if (typeof dispose === "function") dispose();
        host.dispose();
        return;
      }
      usePlugins.setState((s) => ({
        active: { ...s.active, [id]: { module, host } },
      }));
    } catch (e) {
      host.dispose();
      usePlugins.setState((s) => ({
        errors: { ...s.errors, [id]: String(e) },
      }));
      useStore
        .getState()
        .showToast(p.manifest.name + ": " + String(e), "error");
    } finally {
      if (timer) clearTimeout(timer);
      usePlugins.setState((s) => ({
        loading: s.loading.filter((x) => x !== id),
      }));
      pending.delete(id);
    }
  })();
  pending.set(id, work);
  return work;
}
export async function openPlugin(id: string) {
  usePlugins.setState({ selected: id });
  await activatePlugin(id);
}
export async function togglePlugin(p: Installed) {
  stopPlugin(p.id);
  await invoke("plugin_set_enabled", { id: p.id, enabled: !p.enabled });
  await refreshPlugins();
  if (!p.enabled && background.has(p.id)) await activatePlugin(p.id);
}
export async function uninstallPlugin(id: string) {
  stopPlugin(id);
  await invoke("plugin_uninstall", { id });
  await refreshPlugins();
}
