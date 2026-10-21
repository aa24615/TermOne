import { create } from "zustand";

import { ipc } from "./ipc";
import { buildSessionRequest } from "./profile";
import {
  DEFAULT_SETTINGS,
  type AppInfoDto,
  type AppSettings,
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
  | null;

interface TermStore {
  bootstrapped: boolean;
  appInfo: AppInfoDto | null;
  settings: AppSettings;
  profiles: ProfileRow[];
  tabs: Tab[];
  activeTabId: string | null;
  auth: AuthState;
  dialog: DialogState;
  toasts: Toast[];

  init(): Promise<void>;
  loadSettings(): Promise<void>;
  saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>;
  loadProfiles(): Promise<void>;
  reloadAfterImport(): Promise<void>;
  saveProfile(profile: ProfileRow): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  openTerminal(profileId: string | null): Promise<void>;
  closeTab(tabId: string): void;
  setActiveTab(tabId: string): void;
  cycleTab(delta: number): void;
  markSessionExit(sessionId: string, code: number | null): void;
  setDialog(dialog: DialogState): void;
  showToast(msg: string, kind?: Toast["kind"]): void;
  dismissToast(id: number): void;
  authLogin(email: string, password: string, register: boolean): Promise<boolean>;
  authLogout(): void;
  syncNow(silent?: boolean): Promise<boolean>;
}

function welcomeTab(): Tab {
  return {
    id: "welcome",
    kind: "welcome",
    sessionId: null,
    sessionTitle: null,
    profileId: null,
    title: "欢迎",
    exitInfo: null,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function applyThemeToDom(theme: string) {
  document.documentElement.dataset.theme = theme;
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
  tabs: [welcomeTab()],
  activeTabId: "welcome",
  auth: { token: null, user: null, syncing: false, lastSyncAt: null, error: null },
  dialog: null,
  toasts: [],

  init: async () => {
    if (get().bootstrapped) return;
    await get().loadSettings();
    await get().loadProfiles();
    void ipc
      .appInfo()
      .then((info) => set({ appInfo: info }))
      .catch(() => {});
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { token: string; user: AuthUser };
        set((s) => ({ auth: { ...s.auth, token: saved.token, user: saved.user } }));
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
          next.scrollback = clampInt(row.value, 100, 100000, DEFAULT_SETTINGS.scrollback);
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
      }
    }
    applyThemeToDom(next.theme);
    set({ settings: next });
  },

  saveSetting: async (key, value) => {
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
    if (key === "theme") applyThemeToDom(String(value));
    try {
      await ipc.settingSet(key, serializeSetting(value));
      scheduleSync();
    } catch (e) {
      get().showToast(`保存设置失败: ${errMsg(e)}`, "error");
    }
  },

  loadProfiles: async () => {
    try {
      const profiles = await ipc.profileList();
      set({ profiles });
    } catch (e) {
      get().showToast(`读取档案失败: ${errMsg(e)}`, "error");
    }
  },

  reloadAfterImport: async () => {
    await get().loadProfiles();
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
    } catch (e) {
      get().showToast(`保存档案失败: ${errMsg(e)}`, "error");
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
    const profile = profileId ? st.profiles.find((p) => p.id === profileId) : undefined;
    if (profileId && !profile) {
      get().showToast("档案不存在", "error");
      return;
    }
    try {
      const info = await ipc.sessionOpen(buildSessionRequest(profile));
      const tab: Tab = {
        id: crypto.randomUUID(),
        kind: info.kind,
        sessionId: info.id,
        sessionTitle: info.title,
        profileId: profile?.id ?? null,
        title: profile?.name ?? info.title,
        exitInfo: null,
      };
      set((s) => ({
        tabs: [...s.tabs.filter((t) => t.id !== "welcome"), tab],
        activeTabId: tab.id,
      }));
    } catch (e) {
      get().showToast(`无法打开会话: ${errMsg(e)}`, "error");
    }
  },

  closeTab: (tabId) => {
    const st = get();
    const tab = st.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.sessionId) void ipc.sessionClose(tab.sessionId).catch(() => {});
    let tabs = st.tabs.filter((t) => t.id !== tabId);
    let activeTabId = st.activeTabId;
    if (st.activeTabId === tabId) {
      const idx = st.tabs.findIndex((t) => t.id === tabId);
      const next = tabs[Math.min(idx, tabs.length - 1)] ?? tabs[tabs.length - 1];
      activeTabId = next?.id ?? null;
    }
    if (tabs.length === 0) {
      tabs = [welcomeTab()];
      activeTabId = "welcome";
    }
    set({ tabs, activeTabId });
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  cycleTab: (delta) => {
    const { tabs, activeTabId } = get();
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    set({ activeTabId: next.id });
  },

  markSessionExit: (sessionId, code) => {
    const tab = get().tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    const info = code === null ? "会话已结束" : `进程已退出（代码 ${code}）`;
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, exitInfo: info } : t)),
    }));
  },

  setDialog: (dialog) => set({ dialog }),

  showToast: (msg, kind = "info") => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }));
    setTimeout(() => get().dismissToast(id), 4500);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  authLogin: async (email, password, register) => {
    const base = get().settings.serverUrl;
    try {
      const data = await apiFetch<{ token: string; user: AuthUser }>(
        base,
        null,
        register ? "/api/auth/register" : "/api/auth/login",
        { method: "POST", body: JSON.stringify({ email, password }) },
      );
      set((s) => ({ auth: { ...s.auth, token: data.token, user: data.user, error: null } }));
      localStorage.setItem(AUTH_KEY, JSON.stringify({ token: data.token, user: data.user }));
      await get().syncNow(true);
      get().showToast(register ? "注册成功，云端数据已就绪" : "登录成功", "success");
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

  syncNow: async (silent = false) => {
    const st = get();
    if (!st.auth.token || st.auth.syncing) return false;
    set((s) => ({ auth: { ...s.auth, syncing: true, error: null } }));
    try {
      const base = get().settings.serverUrl;
      const token = get().auth.token ?? "";

      const dirty = await ipc.syncExportDirty();
      if (dirty.length > 0) {
        await apiFetch(base, token, "/api/sync/push", {
          method: "POST",
          body: JSON.stringify({ items: dirty }),
        });
        await ipc.syncMarkPushed(dirty);
      }

      const since = await ipc.syncLastPull();
      const data = await apiFetch<{ serverTime: number; items: SyncItem[] }>(
        base,
        token,
        `/api/sync/pull?since=${encodeURIComponent(String(since))}`,
      );
      if (data.items.length > 0) {
        await ipc.syncApplyPull(data.items);
        await get().loadProfiles();
        await get().loadSettings();
      }
      await ipc.syncSetLastPull(data.serverTime ?? Date.now());
      set((s) => ({ auth: { ...s.auth, syncing: false, lastSyncAt: Date.now() } }));
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
