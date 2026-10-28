import type { Permission } from "../plugin/types";
import { describePermission } from "../plugin/permissions";

function ApplicationIcon({ id, name }: { id: string; name: string }) {
  const type = id === "com.termone.server-monitor" ? "monitor" : id === "com.termone.sftp" ? "files" : id === "com.termone.session-log" ? "logs" : id === "com.termone.ai-assist" ? "ai" : "other";
  return (
    <span className={`application-icon ${type}`} aria-hidden="true">
      {type === "other" ? Array.from(name)[0] : (
        <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          {type === "monitor" ? <><rect x="3" y="5" width="26" height="19" rx="3"/><path d="M7 17h4l3-7 4 11 3-6h4M11 29h10M16 24v5"/></> : type === "files" ? <><path d="M4 11V8a2 2 0 0 1 2-2h7l3 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V11Z"/><path d="M9 17h13m-3-3 3 3-3 3M23 22H10m3-3-3 3 3 3"/></> : type === "logs" ? <><rect x="6" y="3" width="20" height="26" rx="3"/><path d="M11 10h10M11 16h10M11 22h6"/></> : <><path d="m16 3 3.4 9.6L29 16l-9.6 3.4L16 29l-3.4-9.6L3 16l9.6-3.4Z"/><path d="m26 3 1 3 3 1-3 1-1 3-1-3-3-1 3-1Z"/></>}
        </svg>
      )}
    </span>
  );
}

export function ApplicationTile({ id, name, description, version, source, permissions, installed, busy, onOpen, onInstall, onUpdate, onUninstall }: {
  id: string;
  name: string;
  description?: string;
  version: string;
  source?: string;
  permissions?: Permission[];
  installed: boolean;
  busy: boolean;
  onOpen?: () => void;
  onInstall?: () => void;
  onUpdate?: () => void;
  onUninstall?: () => void;
}) {
  return (
    <section className="application-tile" aria-label={name}>
      <button className="application-tile-main" disabled={busy || (!installed && !onInstall)} onClick={installed ? onOpen : onInstall} aria-label={`${installed ? "打开" : "安装"} ${name}`}>
        <ApplicationIcon id={id} name={name} />
        <strong>{name}</strong>
        <span className="application-tile-description">{description}</span>
        <span className={`application-tile-label${installed ? " installed" : ""}`}>{installed ? "点击打开" : "安装"}</span>
      </button>
      <div className="application-tile-footer">
        <small title={source}>{version}</small>
        <details className="application-tile-manage">
          <summary>管理</summary>
          <div>
            <small>{source}</small>
            {permissions && <details><summary>权限</summary><pre>{permissions.map(describePermission).join("\n")}</pre></details>}
            {onUpdate && <button className="btn" disabled={busy} onClick={onUpdate}>更新</button>}
            {installed && <button className="btn danger" disabled={busy} onClick={onUninstall}>卸载</button>}
          </div>
        </details>
      </div>
    </section>
  );
}
