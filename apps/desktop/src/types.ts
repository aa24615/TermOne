export type ProfileKind = "local" | "ssh" | "serial";

export interface LocalProfileConfig {
  shell?: string;
  args?: string[];
  cwd?: string;
}

export interface SshProfileConfig {
  host: string;
  port: number;
  user?: string;
  auth: "agent" | "password" | "key";
  identityFile?: string;
}

export interface SerialProfileConfig {
  path: string;
  baud: number;
  dataBits: 7 | 8;
  parity: "none" | "odd" | "even";
  stopBits: 1 | 2;
  flowControl: "none" | "xon" | "rtscts";
}

export type ProfileConfig = LocalProfileConfig | SshProfileConfig | SerialProfileConfig;

export interface ProfileRow {
  id: string;
  kind: ProfileKind;
  name: string;
  config: ProfileConfig;
  sortOrder: number;
  updatedAt: number;
  createdAt: number;
  deleted: boolean;
  dirty: boolean;
}

export interface SettingRow {
  key: string;
  value: string;
  updatedAt: number;
  dirty: boolean;
}

export interface SyncItem {
  itemId: string;
  kind: "profile" | "setting";
  key?: string;
  data: string;
  updatedAt: number;
  deleted: boolean;
}

export interface SessionInfo {
  id: string;
  title: string;
  kind: ProfileKind;
}

export type SshAuthRequest =
  | { type: "agent" }
  | { type: "password" }
  | { type: "key"; identityFile: string };

export type SessionRequest =
  | { kind: "local"; shell?: string; args: string[]; cwd?: string }
  | {
      kind: "ssh";
      host: string;
      port: number;
      user?: string;
      auth: SshAuthRequest;
      command?: string;
    }
  | {
      kind: "serial";
      path: string;
      baud: number;
      dataBits: number;
      parity: string;
      stopBits: number;
      flowControl: string;
    };

export interface SerialPortDto {
  name: string;
  product?: string;
  manufacturer?: string;
}

export interface AppInfoDto {
  name: string;
  version: string;
  os: string;
  arch: string;
}

export interface Tab {
  id: string;
  kind: ProfileKind | "welcome";
  sessionId: string | null;
  sessionTitle: string | null;
  profileId: string | null;
  title: string;
  exitInfo: string | null;
}

export interface AppSettings {
  theme: string;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  defaultProfileId: string | null;
  serverUrl: string;
  autoSync: boolean;
  confirmClose: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "midnight",
  fontFamily:
    '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
  fontSize: 14,
  scrollback: 5000,
  defaultProfileId: null,
  serverUrl: "http://127.0.0.1:8787",
  autoSync: true,
  confirmClose: true,
};

export const THEME_NAMES: Record<string, string> = {
  midnight: "Midnight",
  daylight: "Daylight",
  dracula: "Dracula",
  nord: "Nord",
  solarized: "Solarized Dark",
};
