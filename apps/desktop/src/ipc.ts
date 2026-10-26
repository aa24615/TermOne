import { invoke } from "@tauri-apps/api/core";

import type {
  AppInfoDto,
  GroupRow,
  LocalEntry,
  ProfileRow,
  SftpEntry,
  SftpRequest,
  SerialPortDto,
  SessionInfo,
  SessionRequest,
  SettingRow,
  ShellInfoDto,
  SyncItem,
} from "./types";

const te = new TextEncoder();

export function toB64(text: string): string {
  const bytes = te.encode(text);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin);
}

export function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const ipc = {
  sshImportRead: (paths: string[]) => invoke<{ files: { name: string; dataB64: string }[]; warnings: string[] }>("ssh_import_read", { paths }),
  sshImportApply: (entries: import("./sshImport").SshImportEntry[], skipDuplicates: boolean, parentId: string | null) =>
    invoke<{ imported: number; skipped: number; groups: number }>("ssh_import_apply", { entries, skipDuplicates, parentId }),
  commandCheck: (input: string) => invoke<import("./terminalInputGuard").CommandCheck>("command_check", { input }),
  appInfo: () => invoke<AppInfoDto>("app_info"),
  defaultShell: () => invoke<string>("default_shell"),
  serialPorts: () => invoke<SerialPortDto[]>("serial_list_ports"),
  listShells: () => invoke<ShellInfoDto[]>("shells_list"),

  sessionOpen: (req: SessionRequest) => invoke<SessionInfo>("session_open", { req }),
  sessionWrite: (id: string, dataB64: string) =>
    invoke<void>("session_write", { id, dataB64 }),
  sessionResize: (id: string, cols: number, rows: number) =>
    invoke<void>("session_resize", { id, cols, rows }),
  sessionClose: (id: string) => invoke<void>("session_close", { id }),
  sessionLogRead: (id: string) => invoke<string>("session_log_read", { id }),

  // SFTP 图形化文件管理（R-01）
  sftpList: (req: SftpRequest, path: string) =>
    invoke<SftpEntry[]>("sftp_list", { req, path }),
  sftpMkdir: (req: SftpRequest, path: string) =>
    invoke<void>("sftp_mkdir", { req, path }),
  sftpRemove: (req: SftpRequest, path: string, isDir: boolean) =>
    invoke<void>("sftp_remove", { req, path, isDir }),
  sftpRename: (req: SftpRequest, from: string, to: string) =>
    invoke<void>("sftp_rename", { req, from, to }),
  sftpDownload: (req: SftpRequest, remote: string, local: string) =>
    invoke<void>("sftp_download", { req, remote, local }),
  sftpUpload: (req: SftpRequest, local: string, remote: string) =>
    invoke<void>("sftp_upload", { req, local, remote }),

  // 本地文件浏览（SFTP 面板本地侧栏）
  localList: (path: string) => invoke<LocalEntry[]>("local_list", { path }),
  localMkdir: (path: string) => invoke<void>("local_mkdir", { path }),

  profileList: () => invoke<ProfileRow[]>("profile_list"),
  profileSave: (profile: ProfileRow) => invoke<ProfileRow>("profile_save", { profile }),
  profileDelete: (id: string) => invoke<void>("profile_delete", { id }),
  groupsList: () => invoke<GroupRow[]>("groups_list"),
  groupCreate: (name: string, parentId: string | null = null) => invoke<GroupRow>("group_create", { name, parentId }),
  groupRename: (id: string, name: string) => invoke("group_rename", { id, name }),
  groupCollapsed: (id: string, collapsed: boolean) => invoke("group_set_collapsed", { id, collapsed }),
  groupDelete: (id: string) => invoke("group_delete", { id }),
  groupMove: (id: string, parentId: string | null) => invoke("group_move", { id, parentId }),
  profileRecent: () => invoke<ProfileRow[]>("profile_recent"),
  profileTouch: (id: string) => invoke("profile_touch", { id }),
  syncRequeueAll: () => invoke("sync_requeue_all"),

  settingsAll: () => invoke<SettingRow[]>("settings_all"),
  settingSet: (key: string, value: string) => invoke<void>("setting_set", { key, value }),

  syncExportDirty: () => invoke<SyncItem[]>("sync_export_dirty"),
  syncApplyPull: (items: SyncItem[]) => invoke<number>("sync_apply_pull", { items }),
  syncMarkPushed: (items: SyncItem[]) => invoke<void>("sync_mark_pushed", { items }),
  syncLastPull: () => invoke<number>("sync_last_pull"),
  syncSetLastPull: (ts: number) => invoke<void>("sync_set_last_pull", { ts }),

  backupExport: (path: string) =>
    invoke<{ profiles: number; settings: number }>("backup_export", { path }),
  backupImport: (path: string, replace: boolean) =>
    invoke<{ profiles: number; settings: number }>("backup_import", { path, replace }),
};
