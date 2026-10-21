import { invoke } from "@tauri-apps/api/core";

import type {
  AppInfoDto,
  ProfileRow,
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

  profileList: () => invoke<ProfileRow[]>("profile_list"),
  profileSave: (profile: ProfileRow) => invoke<ProfileRow>("profile_save", { profile }),
  profileDelete: (id: string) => invoke<void>("profile_delete", { id }),

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
