export type ProfileKind = "local" | "ssh" | "serial";

/** 所有档案类型的公共字段 */
interface ProfileConfigBase {
  /** 区分色（如 #ff5d6c），空为按类型默认 */
  color?: string;
}

export interface LocalProfileConfig extends ProfileConfigBase {
  shell?: string;
  args?: string[];
  cwd?: string;
  /** shell=普通 Shell；docker/ssh/wsl=快捷启动器（自动组装参数） */
  preset?: "shell" | "docker" | "ssh" | "wsl";
  image?: string;
  target?: string;
  shellCustom?: boolean;
}

export interface SshProfileConfig extends ProfileConfigBase {
  host: string;
  port: number;
  user?: string;
  auth: "agent" | "password" | "key";
  identityFile?: string;
  /** Jump Host / ProxyJump，如 `user@bastion:22` 或 `bastion`（R-10） */
  proxyJump?: string;
  /** 本地端口转发 -L，如 `8080:localhost:80`（R-06） */
  localForward?: string;
  /** 远程端口转发 -R，如 `8080:localhost:80`（R-06） */
  remoteForward?: string;
  /** 动态（SOCKS）转发 -D 端口（R-06） */
  dynamicForward?: number;
}

export interface SerialProfileConfig extends ProfileConfigBase {
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
  groupId?: string | null;
  sortOrder: number;
  updatedAt: number;
  createdAt: number;
  deleted: boolean;
  dirty: boolean;
}

export interface GroupRow {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  collapsed: boolean;
}

export interface SettingRow {
  key: string;
  value: string;
  updatedAt: number;
  dirty: boolean;
}

export interface SyncItem {
  itemId: string;
  kind: "profile" | "setting" | "group" | "snippet" | "plugin";
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

/** 远端认证（SFTP 仅支持 agent / key；密码认证不适配非交互批处理） */
export type SftpAuthRequest =
  | { type: "agent" }
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
      proxyJump?: string | null;
      localForward?: string | null;
      remoteForward?: string | null;
      dynamicForward?: number | null;
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

/** SFTP 连接参数（由前端从 SSH 档案组装） */
export interface SftpRequest {
  host: string;
  port: number;
  user?: string;
  auth: SftpAuthRequest;
  proxyJump?: string;
}

/** 远端目录项（R-01） */
export interface SftpEntry {
  name: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  mode: string;
  owner: string;
  group: string;
  mtime: string;
}

/** 本地目录项（SFTP 面板的本地侧栏） */
export interface LocalEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export type TransferKind = "download" | "upload";
export type TransferStatus = "running" | "done" | "error";

export interface TransferItem {
  id: string;
  kind: TransferKind;
  name: string;
  status: TransferStatus;
  error?: string;
}

export interface ShellInfoDto {
  name: string;
  path: string;
  preset: string;
}

export interface AppInfoDto {
  name: string;
  version: string;
  os: string;
  arch: string;
}

/** 一个面板 = 一个终端会话视图（分屏中的最小单元） */
export interface Pane {
  id: string;
  kind: ProfileKind | "welcome";
  sessionId: string | null;
  sessionTitle: string | null;
  profileId: string | null;
  title: string;
  exitInfo: string | null;
}

/** 分屏布局树：叶子是面板，split 节点容纳子节点。 */
export type PaneNode =
  | { type: "leaf"; id: string; pane: Pane }
  | { type: "split"; id: string; dir: "row" | "col"; children: PaneNode[]; sizes: number[] };

/** 顶层标签页：内嵌一棵分屏布局树（欢迎页是单个 welcome 叶子） */
export interface Tab {
  id: string;
  layout: PaneNode;
}

export interface AppSettings {
  customTheme: string;
  reconnectEnabled: boolean;
  reconnectDelaySeconds: number;
  reconnectMaxAttempts: number;
  theme: string;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  defaultProfileId: string | null;
  serverUrl: string;
  autoSync: boolean;
  confirmClose: boolean;
  logSessions: boolean;
  e2eeEnabled: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  customTheme: "",
  reconnectEnabled: true,
  reconnectDelaySeconds: 5,
  reconnectMaxAttempts: 5,
  theme: "daylight",
  fontFamily:
    '"Cascadia Mono", "Cascadia Code", "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
  fontSize: 14,
  scrollback: 5000,
  defaultProfileId: null,
  serverUrl: "http://127.0.0.1:8787",
  autoSync: true,
  confirmClose: true,
  logSessions: false,
  e2eeEnabled: false,
};

export const THEME_NAMES: Record<string, string> = {
  midnight: "Midnight",
  daylight: "Daylight",
  dracula: "Dracula",
  nord: "Nord",
  solarized: "Solarized Dark",
};
