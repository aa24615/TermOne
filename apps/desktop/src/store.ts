import { create } from "zustand";

import { decryptData, encryptData, isEncrypted } from "./crypto";
import { ipc } from "./ipc";
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
import { buildSessionRequest, buildSftpRequest } from "./profile";
import {
  DEFAULT_SETTINGS,
  type AppInfoDto,
  type AppSettings,
  type GroupRow,
  type LocalEntry,
  type Pane,
  type ProfileRow,
  type SftpEntry,
  type SettingRow,
  type SyncItem,
  type Tab,
  type TransferItem,
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
  saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>;
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
  splitPane(paneId: string, dir: "row" | "col", profileId?: string | null): Promise<void>;
  closePane(paneId: string): void;
  setSplitSizes(splitId: string, sizes: number[]): void;
  markSessionExit(sessionId: string, code: number | null): void;
  setDialog(dialog: DialogState): void;
  showToast(msg: string, kind?: Toast["kind"]): void;
  dismissToast(id: number): void;
  authLogin(email: string, password: string, register: boolean): Promise<boolean>;
  authLogout(): void;
  syncNow(silent?: boolean): Promise<boolean>;
  enableE2ee(passphrase: string): void;
  disableE2ee(): void;

  // SFTP 图形化文件管理（R-01）
  sftpOpen: boolean;
  sftpProfileId: string | null;
  sftpRemoteCwd: string;
  sftpRemoteEntries: SftpEntry[];
  sftpRemoteLoading: boolean;
  sftpRemoteError: string | null;
  sftpLocalCwd: string;
  sftpLocalEntries: LocalEntry[];
  sftpLocalLoading: boolean;
  sftpLocalError: string | null;
  sftpTransfers: TransferItem[];

  toggleSftp(): void;
  setSftpProfile(id: string): void;
  sftpListRemote(path: string): Promise<void>;
  sftpListLocal(path: string): Promise<void>;
  sftpMkdirRemote(name: string): Promise<void>;
  sftpDeleteRemote(entry: SftpEntry): Promise<void>;
  sftpRenameRemote(from: string, to: string): Promise<void>;
  sftpDownload(remote: string): Promise<void>;
  sftpUpload(localFile: string): Promise<void>;
  sftpLocalMkdir(name: string): Promise<void>;
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

/** 拼接远端路径（远端始终用正向斜杠；空 cwd 视为家目录）。 */
function joinRemotePath(cwd: string, name: string): string {
  if (!cwd) return name;
  if (cwd.endsWith("/")) return cwd + name;
  return `${cwd}/${name}`;
}

/** 拼接本地路径（保留操作系统分隔符）。 */
function joinLocalPath(cwd: string, name: string): string {
  if (!cwd) return name;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return cwd.endsWith("/") || cwd.endsWith("\\") ? cwd + name : cwd + sep + name;
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
/** 设置写盘防抖计时器（按 key）。 */
const settingTimers: Record<string, ReturnType<typeof setTimeout>> = {};
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
  auth: { token: null, user: null, syncing: false, lastSyncAt: null, error: null },
  dialog: null,
  toasts: [],
  syncPassphrase: null,

  sftpOpen: false,
  sftpProfileId: null,
  sftpRemoteCwd: "",
  sftpRemoteEntries: [],
  sftpRemoteLoading: false,
  sftpRemoteError: null,
  sftpLocalCwd: "",
  sftpLocalEntries: [],
  sftpLocalLoading: false,
  sftpLocalError: null,
  sftpTransfers: [],

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
        case "logSessions":
          next.logSessions = row.value !== "0";
          break;
        case "e2eeEnabled":
          next.e2eeEnabled = row.value !== "0";
          break;
      }
    }
    applyThemeToDom(next.theme);
    set({ settings: next });
  },

  saveSetting: async (key, value) => {
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
    if (key === "theme") applyThemeToDom(String(value));
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
    const profile = profileId ? st.profiles.find((p) => p.id === profileId) : undefined;
    if (profileId && !profile) {
      get().showToast("档案不存在", "error");
      return;
    }
    try {
      const info = await ipc.sessionOpen(buildSessionRequest(profile));
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
      if (p.sessionId) void ipc.sessionClose(p.sessionId).catch(() => {});
    }
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
        const info = await ipc.sessionOpen(buildSessionRequest(profile));
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
        t.id === tab.id ? { ...t, layout: splitLeaf(t.layout, paneId, dir, newPaneObj) } : t,
      ),
      activePaneId: newPaneObj.id,
    }));
  },

  closePane: (paneId) => {
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
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, layout: remaining } : t)) }));
  },

  setSplitSizes: (splitId, sizes) => {
    set((s) => ({
      tabs: s.tabs.map((t) => ({ ...t, layout: setSplitSizes(t.layout, splitId, sizes) })),
    }));
  },

  markSessionExit: (sessionId, code) => {
    const info = code === null ? "会话已结束" : `进程已退出（代码 ${code}）`;
    set((s) => ({
      tabs: s.tabs.map((t) => {
        const leaves = allLeaves(t.layout);
        if (!leaves.some((p) => p.sessionId === sessionId)) return t;
        return { ...t, layout: updatePaneBySession(t.layout, sessionId, { exitInfo: info }) };
      }),
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

  enableE2ee: (passphrase) => {
    set({ syncPassphrase: passphrase });
    void get().saveSetting("e2eeEnabled", true);
    void get().syncNow(true);
  },

  disableE2ee: () => {
    set({ syncPassphrase: null });
    void get().saveSetting("e2eeEnabled", false);
  },

  toggleSftp: () => {
    const st = get();
    const opening = !st.sftpOpen;
    set({ sftpOpen: opening });
    if (opening) {
      let id = st.sftpProfileId;
      if (!id || !st.profiles.some((p) => p.id === id)) {
        id = st.profiles.find((p) => p.kind === "ssh")?.id ?? null;
      }
      set({ sftpProfileId: id });
      if (id) void get().sftpListRemote("");
    }
  },

  setSftpProfile: (id) => {
    set({ sftpProfileId: id });
    void get().sftpListRemote("");
  },

  sftpListRemote: async (path) => {
    const st = get();
    const profile = st.profiles.find((p) => p.id === st.sftpProfileId);
    const req = buildSftpRequest(profile);
    if (!req) {
      set({
        sftpRemoteError: "请选择一个 SSH 档案（SFTP 需密钥 / agent 认证，不支持密码）",
        sftpRemoteEntries: [],
      });
      return;
    }
    set({ sftpRemoteLoading: true, sftpRemoteError: null });
    try {
      const entries = await ipc.sftpList(req, path);
      set({ sftpRemoteEntries: entries, sftpRemoteCwd: path, sftpRemoteLoading: false });
    } catch (e) {
      set({ sftpRemoteError: errMsg(e), sftpRemoteLoading: false, sftpRemoteEntries: [] });
    }
  },

  sftpListLocal: async (path) => {
    set({ sftpLocalLoading: true, sftpLocalError: null });
    try {
      const entries = await ipc.localList(path);
      set({ sftpLocalEntries: entries, sftpLocalCwd: path, sftpLocalLoading: false });
    } catch (e) {
      set({ sftpLocalError: errMsg(e), sftpLocalLoading: false, sftpLocalEntries: [] });
    }
  },

  sftpMkdirRemote: async (name) => {
    const st = get();
    const req = buildSftpRequest(st.profiles.find((p) => p.id === st.sftpProfileId));
    if (!req) return;
    const path = joinRemotePath(st.sftpRemoteCwd, name);
    try {
      await ipc.sftpMkdir(req, path);
      get().showToast("目录已创建", "success");
      await get().sftpListRemote(st.sftpRemoteCwd);
    } catch (e) {
      get().showToast(`创建目录失败: ${errMsg(e)}`, "error");
    }
  },

  sftpDeleteRemote: async (entry) => {
    const st = get();
    const req = buildSftpRequest(st.profiles.find((p) => p.id === st.sftpProfileId));
    if (!req) return;
    const path = joinRemotePath(st.sftpRemoteCwd, entry.name);
    try {
      await ipc.sftpRemove(req, path, entry.isDir);
      get().showToast(`已删除 ${entry.name}`, "success");
      await get().sftpListRemote(st.sftpRemoteCwd);
    } catch (e) {
      get().showToast(`删除失败: ${errMsg(e)}（目录仅可为空）`, "error");
    }
  },

  sftpRenameRemote: async (from, to) => {
    const st = get();
    const req = buildSftpRequest(st.profiles.find((p) => p.id === st.sftpProfileId));
    if (!req) return;
    try {
      await ipc.sftpRename(req, joinRemotePath(st.sftpRemoteCwd, from), joinRemotePath(st.sftpRemoteCwd, to));
      get().showToast("重命名成功", "success");
      await get().sftpListRemote(st.sftpRemoteCwd);
    } catch (e) {
      get().showToast(`重命名失败: ${errMsg(e)}`, "error");
    }
  },

  sftpDownload: async (remote) => {
    const st = get();
    const req = buildSftpRequest(st.profiles.find((p) => p.id === st.sftpProfileId));
    if (!req) return;
    if (!st.sftpLocalCwd) {
      get().showToast("请先选择本地目录作为下载目标", "error");
      return;
    }
    const remotePath = joinRemotePath(st.sftpRemoteCwd, remote);
    const localPath = joinLocalPath(st.sftpLocalCwd, remote);
    const item: TransferItem = { id: crypto.randomUUID(), kind: "download", name: remote, status: "running" };
    set((s) => ({ sftpTransfers: [item, ...s.sftpTransfers] }));
    try {
      await ipc.sftpDownload(req, remotePath, localPath);
      set((s) => ({
        sftpTransfers: s.sftpTransfers.map((t) => (t.id === item.id ? { ...t, status: "done" } : t)),
      }));
      get().showToast(`已下载到 ${localPath}`, "success");
      await get().sftpListLocal(st.sftpLocalCwd);
    } catch (e) {
      set((s) => ({
        sftpTransfers: s.sftpTransfers.map((t) =>
          t.id === item.id ? { ...t, status: "error", error: errMsg(e) } : t,
        ),
      }));
    }
  },

  sftpUpload: async (localFile) => {
    const st = get();
    const req = buildSftpRequest(st.profiles.find((p) => p.id === st.sftpProfileId));
    if (!req) return;
    if (!st.sftpLocalCwd) {
      get().showToast("请先选择本地目录作为上传源", "error");
      return;
    }
    const localPath = joinLocalPath(st.sftpLocalCwd, localFile);
    const remotePath = joinRemotePath(st.sftpRemoteCwd, localFile);
    const item: TransferItem = { id: crypto.randomUUID(), kind: "upload", name: localFile, status: "running" };
    set((s) => ({ sftpTransfers: [item, ...s.sftpTransfers] }));
    try {
      await ipc.sftpUpload(req, localPath, remotePath);
      set((s) => ({
        sftpTransfers: s.sftpTransfers.map((t) => (t.id === item.id ? { ...t, status: "done" } : t)),
      }));
      get().showToast(`已上传到 ${remotePath}`, "success");
      await get().sftpListRemote(st.sftpRemoteCwd);
    } catch (e) {
      set((s) => ({
        sftpTransfers: s.sftpTransfers.map((t) =>
          t.id === item.id ? { ...t, status: "error", error: errMsg(e) } : t,
        ),
      }));
    }
  },

  sftpLocalMkdir: async (name) => {
    const st = get();
    if (!st.sftpLocalCwd) return;
    const path = joinLocalPath(st.sftpLocalCwd, name);
    try {
      await ipc.localMkdir(path);
      await get().sftpListLocal(st.sftpLocalCwd);
    } catch (e) {
      get().showToast(`创建本地目录失败: ${errMsg(e)}`, "error");
    }
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
        let toPush = dirty;
        if (get().settings.e2eeEnabled && get().syncPassphrase) {
          toPush = await Promise.all(
            dirty.map(async (it) => ({ ...it, data: await encryptData(it.data, get().syncPassphrase!) })),
          );
        }
        await apiFetch(base, token, "/api/sync/push", {
          method: "POST",
          body: JSON.stringify({ items: toPush }),
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
        let toApply = data.items;
        if (get().settings.e2eeEnabled && get().syncPassphrase) {
          try {
            toApply = await Promise.all(
              data.items.map(async (it) =>
                isEncrypted(it.data)
                  ? { ...it, data: await decryptData(it.data, get().syncPassphrase!) }
                  : it,
              ),
            );
          } catch {
            get().showToast("同步解密失败：口令可能不正确", "error");
            return false;
          }
        }
        await ipc.syncApplyPull(toApply);
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
