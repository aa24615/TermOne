import { create } from "zustand";

import { decryptData, encryptData, isEncrypted } from "./crypto";
import { ipc } from "./ipc";
import { applyCustomColors, setCustomTheme } from "./themes";
import { ensureSessionEvents } from "./sessionEvents";
import { retryDelay } from "./reconnection";
import {
  allLeaves,
  findPane,
  leafNode,
  newPane,
  removeLeaf,
  setSplitSizes,
  splitLeaf,
  updatePaneBySession,
} from "./paneTree";
import { buildSessionRequest } from "./profile";
import {
  DEFAULT_SETTINGS,
  type AppInfoDto,
  type AppSettings,
  type GroupRow,
  type Pane,
  type ProfileRow,
  type SettingRow,
  type SyncItem,
  type Tab,
} from "./types";

const AUTH_KEY = "termone.auth";

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

export interface AuthState {
  token: string | null;
  user: AuthUser | null;
  syncing: boolean;
  lastSyncAt: number | null;
  error: string | null;
}

export interface Toast {
  id: number;
  msg: string;
  kind: "info" | "success" | "error";
}

export type DialogState =
  | { type: "profile"; profileId?: string }
  | { type: "settings" }
  | { type: "account" }
  | { type: "about" }
  | { type: "plugins" }
  | { type: "applications" }
  | { type: "commands" }
  | null;

interface TermStore {
  bootstrapped: boolean;
  appInfo: AppInfoDto | null;
  settings: AppSettings;
  profiles: ProfileRow[];
  groups: GroupRow[];
  tabs: Tab[];
  activeTabId: string | null;
  activePaneId: string | null;
  auth: AuthState;
  dialog: DialogState;
  toasts: Toast[];
  /** E2EE 口令（仅内存，不落盘；服务端零知识） */
  syncPassphrase: string | null;

  init(): Promise<void>;
  loadSettings(): Promise<void>;
  saveSetting<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ): Promise<void>;
  loadProfiles(): Promise<void>;
  loadGroups(): Promise<void>;
  reloadAfterImport(): Promise<void>;
  saveProfile(profile: ProfileRow): Promise<boolean>;
  deleteProfile(id: string): Promise<void>;
  openTerminal(profileId: string | null): Promise<void>;
  closeTab(tabId: string): void;
  setActiveTab(tabId: string): void;
  cycleTab(delta: number): void;
  setActivePane(paneId: string): void;
  splitPane(
    paneId: string,
    dir: "row" | "col",
    profileId?: string | null,
  ): Promise<void>;
  closePane(paneId: string): void;
  setSplitSizes(splitId: string, sizes: number[]): void;
  markSessionExit(sessionId: string, code: number | null): void;
  reconnectPane(paneId: string, manual?: boolean): Promise<void>;
  stopReconnect(paneId: string): void;
  openInPane(paneId: string, profileId: string | null): Promise<void>;
  setDialog(dialog: DialogState): void;
  showToast(msg: string, kind?: Toast["kind"]): void;
  dismissToast(id: number): void;
  authLogin(
    email: string,
    password: string,
    register: boolean,
  ): Promise<boolean>;
  authLogout(): void;
  syncNow(silent?: boolean): Promise<boolean>;
  enableE2ee(passphrase: string): void;
  disableE2ee(): void;
}

function welcomeTab(): Tab {
  return {
    id: "welcome",
    layout: leafNode(newPane({ kind: "welcome", title: "欢迎" })),
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function clampInt(
  raw: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function applyThemeToDom(theme: string) {
  document.documentElement.dataset.theme = theme;
  applyCustomColors(theme === "custom");
}

function serializeSetting(v: string | number | boolean | null): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "1" : "0";
  return String(v);
}

async function apiFetch<T>(
  base: string,
  token: string | null,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(base.replace(/\/+$/, "") + path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === "string") msg = body.error;
    } catch {
      // 忽略非 JSON 响应体
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

/** 变更后延迟触发自动同步（防抖）。 */
let syncTimer: ReturnType<typeof setTimeout> | null = null;
/** 设置写盘防抖计时器（按 key）。 */
const settingTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const retries = new Map<
  string,
  {
    attempt: number;
    timer?: ReturnType<typeof setTimeout>;
    stable?: ReturnType<typeof setTimeout>;
  }
>();
const stopped = new Set<string>();
const connecting = new Set<string>();
function cancelRetry(paneId: string) {
  const r = retries.get(paneId);
  if (r?.timer) clearTimeout(r.timer);
  if (r?.stable) clearTimeout(r.stable);
  retries.delete(paneId);
}
function paneAt(id: string) {
  return useStore
    .getState()
    .tabs.flatMap((t) => allLeaves(t.layout))
    .find((p) => p.id === id);
}
async function openSession(profile?: ProfileRow) {
  await ensureSessionEvents();
  const info = await ipc.sessionOpen(buildSessionRequest(profile));
  if (profile) void ipc.profileTouch(profile.id).catch(() => {});
  return info;
}
function scheduleReconnect(paneId: string) {
  const st = useStore.getState();
  const pane = paneAt(paneId);
  if (
    !pane ||
    stopped.has(paneId) ||
    pane.kind !== "ssh" ||
    !pane.profileId ||
    !st.settings.reconnectEnabled
  )
    return;
  const retry = retries.get(paneId) ?? { attempt: 0 };
  if (retry.timer) return;
  const delay = retryDelay(
    retry.attempt,
    st.settings.reconnectDelaySeconds,
    st.settings.reconnectMaxAttempts,
  );
  if (delay === null) {
    st.showToast("自动重连已达到次数上限，可手动重新连接", "error");
    return;
  }
  retry.attempt++;
  retry.timer = setTimeout(() => {
    retry.timer = undefined;
    void useStore.getState().reconnectPane(paneId, false);
  }, delay);
  retries.set(paneId, retry);
  useStore.setState((s) => ({
    tabs: s.tabs.map((t) => ({
      ...t,
      layout: updatePaneBySession(t.layout, pane.sessionId!, {
        exitInfo:
          "连接已断开，" +
          delay / 1000 +
          " 秒后重试（" +
          retry.attempt +
          "/" +
          st.settings.reconnectMaxAttempts +
          "）",
      }),
    })),
  }));
}
export function scheduleSync(delayMs = 3000) {
  const st = useStore.getState();
  if (!st.auth.token || !st.settings.autoSync) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void useStore.getState().syncNow(true);
  }, delayMs);
}

export const useStore = create<TermStore>()((set, get) => ({
  bootstrapped: false,
  appInfo: null,
  settings: { ...DEFAULT_SETTINGS },
  profiles: [],
  groups: [],
  tabs: [welcomeTab()],
  activeTabId: "welcome",
  activePaneId: null,
  auth: {
    token: null,
    user: null,
    syncing: false,
    lastSyncAt: null,
    error: null,
  },
  dialog: null,
  toasts: [],
  syncPassphrase: null,

  init: async () => {
    if (get().bootstrapped) return;
    await get().loadSettings();
    await get().loadProfiles();
    void get().loadGroups();
    void ipc
      .appInfo()
      .then((info) => set({ appInfo: info }))
      .catch(() => {});
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { token: string; user: AuthUser };
        set((s) => ({
          auth: { ...s.auth, token: saved.token, user: saved.user },
        }));
        void (async () => {
          try {
            await apiFetch(get().settings.serverUrl, saved.token, "/api/me");
            await get().syncNow(true);
          } catch {
            // 令牌失效则静默回到本地模式
            set((s) => ({ auth: { ...s.auth, token: null, user: null } }));
            localStorage.removeItem(AUTH_KEY);
          }
        })();
      }
    } catch {
      // 忽略本地存储损坏
    }
    set({ bootstrapped: true });
  },

  loadSettings: async () => {
    let rows: SettingRow[] = [];
    try {
      rows = await ipc.settingsAll();
    } catch {
      return;
    }
    const next = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      switch (row.key) {
        case "customTheme":
          next.customTheme = row.value;
          break;
        case "reconnectEnabled":
          next.reconnectEnabled = row.value !== "0";
          break;
        case "reconnectDelaySeconds":
          next.reconnectDelaySeconds = clampInt(row.value, 1, 60, 5);
          break;
        case "reconnectMaxAttempts":
          next.reconnectMaxAttempts = clampInt(row.value, 1, 10, 5);
          break;
        case "theme":
          if (row.value) next.theme = row.value;
          break;
        case "fontFamily":
          if (row.value) next.fontFamily = row.value;
          break;
        case "fontSize":
          next.fontSize = clampInt(row.value, 8, 32, DEFAULT_SETTINGS.fontSize);
          break;
        case "scrollback":
          next.scrollback = clampInt(
            row.value,
            100,
            100000,
            DEFAULT_SETTINGS.scrollback,
          );
          break;
        case "defaultProfileId":
          next.defaultProfileId = row.value || null;
          break;
        case "serverUrl":
          if (row.value) next.serverUrl = row.value;
          break;
        case "autoSync":
          next.autoSync = row.value !== "0";
          break;
        case "confirmClose":
          next.confirmClose = row.value !== "0";
          break;
        case "logSessions":
          next.logSessions = row.value !== "0";
          break;
        case "e2eeEnabled":
          next.e2eeEnabled = row.value !== "0";
          break;
      }
    }
    setCustomTheme(next.customTheme);
    applyThemeToDom(next.theme);
    set({ settings: next });
  },

  saveSetting: async (key, value) => {
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
    if (key === "reconnectEnabled" && !value)
      for (const id of [...retries.keys()]) get().stopReconnect(id);
    if (key === "theme") applyThemeToDom(String(value));
    if (key === "customTheme") {
      setCustomTheme(String(value));
      applyThemeToDom(get().settings.theme);
    }
    // 输入类设置按键级触发，防抖落盘避免连击 IPC 造成卡顿
    const pending = settingTimers[key];
    if (pending) clearTimeout(pending);
    settingTimers[key] = setTimeout(() => {
      delete settingTimers[key];
      void ipc
        .settingSet(key, serializeSetting(value))
        .then(() => scheduleSync())
        .catch((e) => get().showToast(`保存设置失败: ${errMsg(e)}`, "error"));
    }, 200);
  },

  loadProfiles: async () => {
    try {
      const profiles = await ipc.profileList();
      set({ profiles });
    } catch (e) {
      get().showToast(`读取档案失败: ${errMsg(e)}`, "error");
    }
  },

  loadGroups: async () => {
    try {
      const groups = await ipc.groupsList();
      set({ groups });
    } catch {
      // 忽略分组读取失败
    }
  },

  reloadAfterImport: async () => {
    await get().loadProfiles();
    await get().loadGroups();
    await get().loadSettings();
  },

  saveProfile: async (profile) => {
    try {
      const saved = await ipc.profileSave(profile);
      set((s) => {
        const exists = s.profiles.some((x) => x.id === saved.id);
        const profiles = exists
          ? s.profiles.map((x) => (x.id === saved.id ? saved : x))
          : [...s.profiles, saved];
        return { profiles };
      });
      scheduleSync();
      return true;
    } catch (e) {
      get().showToast(`保存档案失败: ${errMsg(e)}`, "error");
      return false;
    }
  },

  deleteProfile: async (id) => {
    try {
      await ipc.profileDelete(id);
      set((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) }));
      scheduleSync();
    } catch (e) {
      get().showToast(`删除档案失败: ${errMsg(e)}`, "error");
    }
  },

  openTerminal: async (profileId) => {
    const st = get();
    const profile = profileId
      ? st.profiles.find((p) => p.id === profileId)
      : undefined;
    if (profileId && !profile) {
      get().showToast("档案不存在", "error");
      return;
    }
    try {
      const info = await openSession(profile);
      const pane = newPane({
        kind: info.kind,
        sessionId: info.id,
        sessionTitle: info.title,
        profileId: profile?.id ?? null,
        title: profile?.name ?? info.title,
      });
      const tab: Tab = {
        id: crypto.randomUUID(),
        layout: leafNode(pane),
      };
      set((s) => ({
        tabs: [...s.tabs.filter((t) => t.id !== "welcome"), tab],
        activeTabId: tab.id,
        activePaneId: pane.id,
      }));
    } catch (e) {
      get().showToast(`无法打开会话: ${errMsg(e)}`, "error");
    }
  },

  closeTab: (tabId) => {
    const st = get();
    const tab = st.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    for (const p of allLeaves(tab.layout)) {
      cancelRetry(p.id);
      stopped.delete(p.id);
      if (p.sessionId) void ipc.sessionClose(p.sessionId).catch(() => {});
    }
    let tabs = st.tabs.filter((t) => t.id !== tabId);
    let activeTabId = st.activeTabId;
    if (st.activeTabId === tabId) {
      const idx = st.tabs.findIndex((t) => t.id === tabId);
      const next =
        tabs[Math.min(idx, tabs.length - 1)] ?? tabs[tabs.length - 1];
      activeTabId = next?.id ?? null;
    }
    if (tabs.length === 0) {
      tabs = [welcomeTab()];
      activeTabId = "welcome";
    }
    set({ tabs, activeTabId, activePaneId: null });
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  cycleTab: (delta) => {
    const { tabs, activeTabId } = get();
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    set({ activeTabId: next.id });
  },

  setActivePane: (paneId) => set({ activePaneId: paneId }),

  splitPane: async (paneId, dir, profileId) => {
    const st = get();
    const tab = st.tabs.find((t) => findPane(t.layout, paneId));
    if (!tab) return;
    let newPaneObj: Pane;
    if (profileId) {
      const profile = st.profiles.find((p) => p.id === profileId);
      if (!profile) {
        get().showToast("档案不存在", "error");
        return;
      }
      try {
        const info = await openSession(profile);
        newPaneObj = newPane({
          kind: info.kind,
          sessionId: info.id,
          sessionTitle: info.title,
          profileId: profile.id,
          title: profile.name,
        });
      } catch (e) {
        get().showToast(`无法打开会话: ${errMsg(e)}`, "error");
        return;
      }
    } else {
      newPaneObj = newPane({ title: "空面板" });
    }
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id
          ? { ...t, layout: splitLeaf(t.layout, paneId, dir, newPaneObj) }
          : t,
      ),
      activePaneId: newPaneObj.id,
    }));
  },

  closePane: (paneId) => {
    cancelRetry(paneId);
    stopped.delete(paneId);
    const st = get();
    const tab = st.tabs.find((t) => findPane(t.layout, paneId));
    if (!tab) return;
    const pane = findPane(tab.layout, paneId);
    if (pane?.sessionId) void ipc.sessionClose(pane.sessionId).catch(() => {});
    const remaining = removeLeaf(tab.layout, paneId);
    if (!remaining) {
      get().closeTab(tab.id);
      return;
    }
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id ? { ...t, layout: remaining } : t,
      ),
    }));
  },

  setSplitSizes: (splitId, sizes) => {
    set((s) => ({
      tabs: s.tabs.map((t) => ({
        ...t,
        layout: setSplitSizes(t.layout, splitId, sizes),
      })),
    }));
  },

  markSessionExit: (sessionId, code) => {
    const info = code === null ? "会话已结束" : `进程已退出（代码 ${code}）`;
    set((s) => ({
      tabs: s.tabs.map((t) => {
        const leaves = allLeaves(t.layout);
        if (!leaves.some((p) => p.sessionId === sessionId)) return t;
        return {
          ...t,
          layout: updatePaneBySession(t.layout, sessionId, { exitInfo: info }),
        };
      }),
    }));
    const pane = get()
      .tabs.flatMap((t) => allLeaves(t.layout))
      .find((p) => p.sessionId === sessionId);
    if (pane && (code === null || code === 255)) scheduleReconnect(pane.id);
  },

  stopReconnect: (paneId) => {
    stopped.add(paneId);
    cancelRetry(paneId);
    const pane = paneAt(paneId);
    if (pane?.sessionId && pane.exitInfo)
      set((s) => ({
        tabs: s.tabs.map((t) => ({
          ...t,
          layout: updatePaneBySession(t.layout, pane.sessionId!, {
            exitInfo: "自动重连已停止，可手动重新连接",
          }),
        })),
      }));
  },
  reconnectPane: async (paneId, manual = true) => {
    if (connecting.has(paneId)) return;
    if (manual) {
      stopped.delete(paneId);
      cancelRetry(paneId);
    }
    const pane = paneAt(paneId);
    if (
      !pane ||
      stopped.has(paneId) ||
      (!manual && !get().settings.reconnectEnabled)
    )
      return;
    const profile = get().profiles.find((p) => p.id === pane.profileId);
    if (!profile) return;
    connecting.add(paneId);
    try {
      if (pane.sessionId)
        await ipc.sessionClose(pane.sessionId).catch(() => {});
      const info = await openSession(profile);
      if (paneAt(paneId)?.sessionId !== pane.sessionId || stopped.has(paneId)) {
        await ipc.sessionClose(info.id);
        return;
      }
      set((s) => ({
        tabs: s.tabs.map((t) => ({
          ...t,
          layout: updatePaneBySession(t.layout, pane.sessionId!, {
            sessionId: info.id,
            sessionTitle: info.title,
            exitInfo: null,
          }),
        })),
      }));
      const retry = retries.get(paneId) ?? { attempt: 0 };
      retry.stable = setTimeout(() => {
        if (paneAt(paneId)?.sessionId === info.id && !paneAt(paneId)?.exitInfo)
          cancelRetry(paneId);
      }, 30_000);
      retries.set(paneId, retry);
    } catch (e) {
      get().showToast("重连失败: " + String(e), "error");
      scheduleReconnect(paneId);
    } finally {
      connecting.delete(paneId);
    }
  },
  openInPane: async (paneId, profileId) => {
    if (connecting.has(paneId)) return;
    const pane = paneAt(paneId);
    if (!pane || pane.sessionId) return;
    const profile = get().profiles.find((p) => p.id === profileId);
    if (profileId && !profile) return;
    connecting.add(paneId);
    try {
      const info = await openSession(profile);
      if (!paneAt(paneId)) {
        await ipc.sessionClose(info.id);
        return;
      }
      const replace = (
        node: import("./types").PaneNode,
      ): import("./types").PaneNode =>
        node.type === "leaf"
          ? node.pane.id === paneId
            ? {
                ...node,
                pane: {
                  ...node.pane,
                  kind: info.kind,
                  sessionId: info.id,
                  sessionTitle: info.title,
                  profileId: profile?.id ?? null,
                  title: profile?.name ?? info.title,
                },
              }
            : node
          : { ...node, children: node.children.map(replace) };
      set((s) => ({
        tabs: s.tabs.map((t) => ({ ...t, layout: replace(t.layout) })),
      }));
    } catch (e) {
      get().showToast(String(e), "error");
    } finally {
      connecting.delete(paneId);
    }
  },

  setDialog: (dialog) => set({ dialog }),

  showToast: (msg, kind = "info") => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }));
    setTimeout(() => get().dismissToast(id), 4500);
  },

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  authLogin: async (email, password, register) => {
    const base = get().settings.serverUrl;
    try {
      const data = await apiFetch<{ token: string; user: AuthUser }>(
        base,
        null,
        register ? "/api/auth/register" : "/api/auth/login",
        { method: "POST", body: JSON.stringify({ email, password }) },
      );
      set((s) => ({
        auth: { ...s.auth, token: data.token, user: data.user, error: null },
      }));
      localStorage.setItem(
        AUTH_KEY,
        JSON.stringify({ token: data.token, user: data.user }),
      );
      await get().syncNow(true);
      get().showToast(
        register ? "注册成功，云端数据已就绪" : "登录成功",
        "success",
      );
      return true;
    } catch (e) {
      set((s) => ({ auth: { ...s.auth, error: errMsg(e) } }));
      return false;
    }
  },

  authLogout: () => {
    localStorage.removeItem(AUTH_KEY);
    set((s) => ({ auth: { ...s.auth, token: null, user: null, error: null } }));
    get().showToast("已退出登录，切换到本地模式", "info");
  },

  enableE2ee: (passphrase) => {
    if (!passphrase.trim()) return;
    const newlyEnabled = !get().settings.e2eeEnabled;
    set((s) => ({
      syncPassphrase: passphrase,
      settings: { ...s.settings, e2eeEnabled: true },
    }));
    void (async () => {
      await ipc.settingSet("e2eeEnabled", "1");
      await ipc.syncSetLastPull(0);
      if (newlyEnabled) await ipc.syncRequeueAll();
      await get().syncNow(true);
    })().catch((e) => get().showToast(String(e), "error"));
  },

  disableE2ee: () => {
    if (!get().syncPassphrase) {
      get().showToast("请先解锁，才能将云端内容切换回未加密同步", "error");
      return;
    }
    set((s) => ({ settings: { ...s.settings, e2eeEnabled: false } }));
    void (async () => {
      await ipc.settingSet("e2eeEnabled", "0");
      await ipc.syncSetLastPull(0);
      await ipc.syncRequeueAll();
      if (await get().syncNow(false)) set({ syncPassphrase: null });
    })().catch((e) => get().showToast(String(e), "error"));
  },

  syncNow: async (silent = false) => {
    const st = get();
    if (!st.auth.token || st.auth.syncing) return false;
    set((s) => ({ auth: { ...s.auth, syncing: true, error: null } }));
    try {
      const base = get().settings.serverUrl;
      const token = get().auth.token ?? "";

      // Unlock/decrypt the pull before writing anything to the server. A wrong key
      // must never overwrite remote records, and a locked client must never push plaintext.
      const enabled = st.settings.e2eeEnabled;
      const passphrase = st.syncPassphrase;
      if (enabled && !passphrase)
        throw new Error("同步已锁定，请先输入 E2EE 口令");
      const since = await ipc.syncLastPull();
      const data = await apiFetch<{ serverTime: number; items: SyncItem[] }>(
        base,
        token,
        `/api/sync/pull?since=${encodeURIComponent(String(since))}`,
      );
      const toApply = await Promise.all(
        data.items.map(async (it) => {
          if (it.deleted) return { ...it, data: "{}" };
          if (!isEncrypted(it.data)) return it;
          if (!passphrase) throw new Error("云端包含加密数据，请先解锁 E2EE");
          try {
            return { ...it, data: await decryptData(it.data, passphrase) };
          } catch {
            throw new Error("同步解密失败，口令不正确或数据已损坏");
          }
        }),
      );
      if (
        token !== get().auth.token ||
        base !== get().settings.serverUrl ||
        enabled !== get().settings.e2eeEnabled ||
        passphrase !== get().syncPassphrase
      )
        throw new Error("同步账号、服务或加密状态已变化，请重新同步");
      if (toApply.length > 0) await ipc.syncApplyPull(toApply);
      const dirty = await ipc.syncExportDirty();
      if (dirty.length > 0) {
        const toPush = enabled
          ? await Promise.all(
              dirty.map(async (it) => ({
                ...it,
                data: it.deleted
                  ? "{}"
                  : await encryptData(it.data, passphrase!),
              })),
            )
          : dirty;
        if (
          token !== get().auth.token ||
          base !== get().settings.serverUrl ||
          enabled !== get().settings.e2eeEnabled ||
          passphrase !== get().syncPassphrase
        )
          throw new Error("同步账号、服务或加密状态已变化，请重新同步");
        await apiFetch(base, token, "/api/sync/push", {
          method: "POST",
          body: JSON.stringify({ items: toPush }),
        });
        if (token !== get().auth.token || base !== get().settings.serverUrl)
          throw new Error("同步账号或服务已变化");
        await ipc.syncMarkPushed(dirty);
      }
      await get().loadProfiles();
      await get().loadGroups();
      await get().loadSettings();
      if (token !== get().auth.token || base !== get().settings.serverUrl)
        throw new Error("同步账号或服务已变化");
      await ipc.syncSetLastPull(data.serverTime ?? Date.now());
      set((s) => ({
        auth: { ...s.auth, syncing: false, lastSyncAt: Date.now() },
      }));
      if (!silent) get().showToast("同步完成", "success");
      return true;
    } catch (e) {
      const msg = errMsg(e);
      set((s) => ({ auth: { ...s.auth, syncing: false, error: msg } }));
      if (!silent) get().showToast(`同步失败: ${msg}`, "error");
      return false;
    }
  },
}));
