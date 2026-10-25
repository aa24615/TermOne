import type { ComponentType, ReactNode } from "react";
import type { ITerminalAddon, Terminal } from "@xterm/xterm";

export interface Permission {
  type: string;
  command?: string;
  domain?: string;
}
export type ExtensionKind = "plugin" | "app";
export interface Manifest {
  kind?: ExtensionKind;
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  entry: string;
  hostApi: { major: number; minor: number; patch: number };
  permissions: Permission[];
  files: string[];
}
export interface Installed {
  id: string;
  manifest: Manifest;
  enabled: boolean;
  source: string;
}
export interface Session {
  id: string;
  title: string;
  profileId: string | null;
  kind: string;
}
export type Dispose = () => void;
export interface TerminalHandle {
  id: string;
  term: Terminal;
  output(filter: (bytes: Uint8Array) => Uint8Array | null): Dispose;
  input(filter: (text: string) => string | null): Dispose;
  addon(addon: ITerminalAddon): Dispose;
}
export interface Host {
  ui: {
    registerPanel(id: string, title: string, render: () => ReactNode): Dispose;
    registerCommand(
      id: string,
      title: string,
      run: () => void,
      shortcut?: string,
    ): Dispose;
    registerSetting(
      id: string,
      title: string,
      render: () => ReactNode,
    ): Dispose;
    setStatusBar(id: string, text: string): Dispose;
  };
  readonly id: string;
  readonly signal: AbortSignal;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  authorize(permission: Permission, action: string): Promise<void>;
  sessions(): Session[];
  write(id: string, text: string): Promise<void>;
  writeBytes(id: string, bytes: Uint8Array): Promise<void>;
  output(cb: (id: string, text: string) => void): Dispose;
  onSessions(cb: (sessions: Session[]) => void): Dispose;
  terminals(cb: (terminal: TerminalHandle) => Dispose): Dispose;
  storage: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
  toast(message: string, error?: boolean): void;
  confirm(message: string): Promise<boolean>;
  openDialog(directory?: boolean): Promise<string | null>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  setInterval(fn: () => void, ms: number): Dispose;
  command(title: string, run: () => void, shortcut?: string): Dispose;
  globalShortcut(shortcut: string): Promise<Dispose>;
  dispose(): void;
}
export interface PluginModule {
  default: ComponentType<{ host: Host }>;
  activate?: (host: Host) => void | Dispose | Promise<void | Dispose>;
}
