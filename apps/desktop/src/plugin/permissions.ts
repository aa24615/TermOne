import type { Manifest, Permission } from "./types";
export const IPC_ALLOW = new Set([
  "profile_refs",
  "sftp_list",
  "sftp_mkdir",
  "sftp_remove",
  "sftp_rename",
  "sftp_download",
  "sftp_upload",
  "local_list",
  "local_mkdir",
  "session_log_list",
  "session_log_read",
  "snippet_list",
  "snippet_save",
  "snippet_delete",
  "snippet_group_list",
  "snippet_group_save",
  "snippet_group_delete",
  "theme_install",
  "history_add",
  "history_recent",
  "history_clear",
]);
export function describePermission(p: Permission): string {
  const labels: Record<string, string> = {
    "ui-panel": "显示扩展界面",
    "ui-command": "注册命令与快捷键",
    "ui-setting": "添加设置项",
    "ui-toast": "显示通知",
    "dialog-open": "选择本地文件或目录（不允许密钥及应用私有目录）",
    storage: "保存扩展自己的数据",
    "session-read": "读取会话输出，可能包含敏感内容",
    "session-write": "向会话发送内容（第三方仅限远端 SSH）",
    "event-subscribe": "订阅会话事件",
    "global-shortcut": "注册系统全局快捷键",
  };
  if (p.type === "net") return "联网域名：" + p.domain;
  if (p.type === "ipc") return "宿主能力：" + p.command;
  return labels[p.type] ?? p.type;
}
const TYPES = new Set([
  "ipc",
  "net",
  "storage",
  "ui-panel",
  "ui-command",
  "event-subscribe",
  "session-read",
  "session-write",
  "ui-toast",
  "ui-setting",
  "dialog-open",
  "global-shortcut",
]);
export function has(m: Manifest, p: Permission): boolean {
  return m.permissions.some(
    (x) =>
      x.type === p.type && x.command === p.command && x.domain === p.domain,
  );
}
export function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 240 &&
    !/[\\:\0]/.test(path) &&
    path
      .split("/")
      .every((p) => p !== "" && p !== "." && p !== ".." && !/[ .]$/.test(p))
  );
}
export function validateManifest(value: unknown): Manifest {
  const m = value as Manifest;
  if (
    !m ||
    (m.kind !== undefined && m.kind !== "plugin" && m.kind !== "app") ||
    !/^[a-z0-9]+(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/.test(m.id) ||
    !/^\d+\.\d+\.\d+$/.test(m.version) ||
    !m.name?.trim() ||
    !safePath(m.entry)
  )
    throw new Error("扩展清单无效");
  if (
    !m.hostApi ||
    m.hostApi.major > 1 ||
    (m.hostApi.major === 1 &&
      (m.hostApi.minor > 1 || (m.hostApi.minor === 1 && m.hostApi.patch > 0)))
  )
    throw new Error("扩展需要更高版本的 Host API");
  if (
    !Array.isArray(m.files) ||
    !m.files.includes(m.entry) ||
    !m.files.every(safePath)
  )
    throw new Error("扩展文件清单无效");
  if (
    !Array.isArray(m.permissions) ||
    m.permissions.some(
      (p) =>
        !TYPES.has(p.type) ||
        (p.type === "ipc" && !IPC_ALLOW.has(p.command ?? "")) ||
        (p.type === "net" &&
          !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/i.test(
            p.domain ?? "",
          )),
    )
  )
    throw new Error("扩展声明了未知或不允许的权限");
  if (
    m.kind === "app" &&
    (m.hostApi.major !== 1 ||
      m.hostApi.minor < 1 ||
      m.permissions.some((p) =>
        [
          "session-read",
          "session-write",
          "event-subscribe",
          "global-shortcut",
        ].includes(p.type),
      ))
  )
    throw new Error(
      "应用需要 Host API 1.1，且不能声明主窗口会话或全局热键权限",
    );
  return m;
}
export function allowedUrl(m: Manifest, raw: string): URL {
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    !has(m, { type: "net", domain: u.hostname })
  )
    throw new Error("目标不在扩展的 HTTPS 域名白名单中");
  return u;
}
