import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { useStore } from "../store";
import type { ProfileRow, SftpEntry } from "../types";
import {
  IconCaretDown,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconX,
} from "./icons";

function fmtSize(n: number): string {
  if (n <= 0) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function parentDir(cwd: string): string {
  if (!cwd) return "/";
  const trimmed = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

function localParent(dir: string): string {
  if (!dir) return dir;
  const sep = dir.includes("\\") ? "\\" : "/";
  const trimmed = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
  const idx = trimmed.lastIndexOf(sep);
  if (idx < 0) return dir;
  if (idx === 0) return sep;
  if (sep === "\\" && idx <= 2) return trimmed.slice(0, idx + 1);
  return trimmed.slice(0, idx);
}

interface Crumb {
  label: string;
  path: string;
}

function buildCrumbs(cwd: string): Crumb[] {
  if (!cwd) return [{ label: "~", path: "" }];
  const absolute = cwd.startsWith("/");
  const parts = cwd.split("/").filter(Boolean);
  const crumbs: Crumb[] = absolute ? [{ label: "/", path: "/" }] : [];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : absolute ? `/${p}` : p;
    crumbs.push({ label: p, path: acc });
  }
  return crumbs;
}

export function FileManager() {
  const sftpOpen = useStore((s) => s.sftpOpen);
  const profiles = useStore((s) => s.profiles);
  const profileId = useStore((s) => s.sftpProfileId);
  const remoteCwd = useStore((s) => s.sftpRemoteCwd);
  const remoteEntries = useStore((s) => s.sftpRemoteEntries);
  const remoteLoading = useStore((s) => s.sftpRemoteLoading);
  const remoteError = useStore((s) => s.sftpRemoteError);
  const localCwd = useStore((s) => s.sftpLocalCwd);
  const localEntries = useStore((s) => s.sftpLocalEntries);
  const localLoading = useStore((s) => s.sftpLocalLoading);
  const localError = useStore((s) => s.sftpLocalError);
  const transfers = useStore((s) => s.sftpTransfers);
  const toggleSftp = useStore((s) => s.toggleSftp);
  const setSftpProfile = useStore((s) => s.setSftpProfile);
  const listRemote = useStore((s) => s.sftpListRemote);
  const listLocal = useStore((s) => s.sftpListLocal);
  const mkdirRemote = useStore((s) => s.sftpMkdirRemote);
  const deleteRemote = useStore((s) => s.sftpDeleteRemote);
  const renameRemote = useStore((s) => s.sftpRenameRemote);
  const download = useStore((s) => s.sftpDownload);
  const upload = useStore((s) => s.sftpUpload);
  const mkdirLocal = useStore((s) => s.sftpLocalMkdir);

  const [remoteSel, setRemoteSel] = useState<string | null>(null);
  const [localSel, setLocalSel] = useState<string | null>(null);

  if (!sftpOpen) return null;

  const sshProfiles = profiles.filter((p) => p.kind === "ssh");
  const activeProfile = sshProfiles.find((p) => p.id === profileId) as ProfileRow | undefined;
  const usable = !!activeProfile && (activeProfile.config as { auth?: string }).auth !== "password";
  const crumbs = buildCrumbs(remoteCwd);

  const pickLocalDir = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") {
        setLocalSel(null);
        await listLocal(picked);
      }
    } catch (e) {
      useStore.getState().showToast(`无法选择目录: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };

  const onRemoteDoubleClick = (entry: SftpEntry) => {
    if (!entry.isDir) return;
    setRemoteSel(null);
    const next = remoteCwd.endsWith("/") ? remoteCwd + entry.name : `${remoteCwd}/${entry.name}`;
    void listRemote(remoteCwd ? next : entry.name);
  };

  const selectedRemoteEntry = remoteEntries.find((e) => e.name === remoteSel) ?? null;

  return (
    <aside className="sftp-drawer" aria-label="SFTP 文件管理">
      <div className="sftp-head">
        <span className="sftp-title">文件管理 · SFTP</span>
        <button className="icon-btn" aria-label="关闭" title="关闭" onClick={toggleSftp}>
          <IconX size={14} />
        </button>
      </div>

      <div className="sftp-profile">
        <label className="sftp-label" htmlFor="sftp-profile-select">
          连接
        </label>
        <div className="sftp-select-wrap">
          <select
            id="sftp-profile-select"
            className="sftp-select"
            value={profileId ?? ""}
            onChange={(e) => {
              setRemoteSel(null);
              setSftpProfile(e.target.value);
            }}
          >
            {sshProfiles.length === 0 && <option value="">（暂无 SSH 档案）</option>}
            {sshProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <IconCaretDown size={12} className="sftp-select-caret" />
        </div>
      </div>

      {activeProfile && (activeProfile.config as { auth?: string }).auth === "password" && (
        <div className="sftp-note warn">
          SFTP 不支持密码认证：请在该 SSH 档案中改用密钥或已解锁的 ssh-agent。
        </div>
      )}

      {/* ---------- 远端 ---------- */}
      <section className="sftp-pane">
        <header className="sftp-pane-head">
          <span className="sftp-pane-title">远端</span>
          <div className="sftp-actions">
            <button
              className="icon-btn"
              title="上级目录"
              aria-label="上级目录"
              disabled={!usable}
              onClick={() => void listRemote(parentDir(remoteCwd))}
            >
              ↑
            </button>
            <button
              className="icon-btn"
              title="刷新"
              aria-label="刷新"
              disabled={!usable}
              onClick={() => void listRemote(remoteCwd)}
            >
              <IconRefresh size={13} />
            </button>
            <button
              className="icon-btn"
              title="新建目录"
              aria-label="新建目录"
              disabled={!usable}
              onClick={() => {
                const name = window.prompt("新目录名");
                if (name && name.trim()) void mkdirRemote(name.trim());
              }}
            >
              <IconPlus size={13} />
            </button>
            <button
              className="icon-btn"
              title="下载选中文件到本地目录"
              aria-label="下载"
              disabled={!usable || !selectedRemoteEntry || selectedRemoteEntry.isDir || !localCwd}
              onClick={() => selectedRemoteEntry && void download(selectedRemoteEntry.name)}
            >
              ↓
            </button>
            <button
              className="icon-btn"
              title="上传选中的本地文件"
              aria-label="上传"
              disabled={!usable || !localSel || localCwd === ""}
              onClick={() => localSel && void upload(localSel)}
            >
              ↑
            </button>
            <button
              className="icon-btn"
              title="删除选中"
              aria-label="删除"
              disabled={!usable || !selectedRemoteEntry}
              onClick={() => selectedRemoteEntry && void deleteRemote(selectedRemoteEntry)}
            >
              <IconTrash size={13} />
            </button>
            <button
              className="icon-btn"
              title="重命名选中"
              aria-label="重命名"
              disabled={!usable || !selectedRemoteEntry}
              onClick={() => {
                if (!selectedRemoteEntry) return;
                const name = window.prompt("新名称", selectedRemoteEntry.name);
                if (name && name.trim() && name !== selectedRemoteEntry.name) {
                  void renameRemote(selectedRemoteEntry.name, name.trim());
                }
              }}
            >
              <IconEdit size={13} />
            </button>
          </div>
        </header>

        <nav className="sftp-crumbs">
          {crumbs.map((c, i) => (
            <span key={`${c.path}-${i}`}>
              {i > 0 && <span className="sftp-crumb-sep">/</span>}
              <button className="sftp-crumb" disabled={!usable} onClick={() => void listRemote(c.path)}>
                {c.label}
              </button>
            </span>
          ))}
        </nav>

        <div className="sftp-list" onDoubleClick={() => setRemoteSel(null)}>
          {remoteLoading && <div className="sftp-status">加载中…</div>}
          {!remoteLoading && remoteError && <div className="sftp-status error">{remoteError}</div>}
          {!remoteLoading && !remoteError && remoteEntries.length === 0 && (
            <div className="sftp-status muted">
              {usable ? "空目录（双击目录进入，选中后可用工具栏操作）" : "选择一个 SSH 档案以浏览"}
            </div>
          )}
          {remoteEntries.map((e) => (
            <div
              key={e.name}
              className={`sftp-row${remoteSel === e.name ? " selected" : ""}`}
              onClick={() => setRemoteSel(e.name === remoteSel ? null : e.name)}
              onDoubleClick={() => onRemoteDoubleClick(e)}
              title={e.name}
            >
              <span className={`sftp-name${e.isDir ? " dir" : ""}`}>
                {e.isDir ? "📁" : e.isLink ? "🔗" : "📄"} {e.name}
              </span>
              <span className="sftp-size">{e.isDir ? "" : fmtSize(e.size)}</span>
              <span className="sftp-mtime">{e.mtime}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- 本地 ---------- */}
      <section className="sftp-pane">
        <header className="sftp-pane-head">
          <span className="sftp-pane-title">本地</span>
          <div className="sftp-actions">
            <button
              className="sftp-btn"
              title="选择本地目录"
              onClick={() => void pickLocalDir()}
            >
              选择目录
            </button>
            <button
              className="icon-btn"
              title="上级目录"
              aria-label="上级目录"
              disabled={!localCwd}
              onClick={() => void listLocal(localParent(localCwd))}
            >
              ↑
            </button>
            <button
              className="icon-btn"
              title="刷新"
              aria-label="刷新"
              disabled={!localCwd}
              onClick={() => void listLocal(localCwd)}
            >
              <IconRefresh size={13} />
            </button>
            <button
              className="icon-btn"
              title="新建本地目录"
              aria-label="新建本地目录"
              disabled={!localCwd}
              onClick={() => {
                const name = window.prompt("新目录名");
                if (name && name.trim()) void mkdirLocal(name.trim());
              }}
            >
              <IconPlus size={13} />
            </button>
          </div>
        </header>

        <div className="sftp-crumbs local">
          <span className="sftp-crumb" title={localCwd}>
            {localCwd || "未选择目录"}
          </span>
        </div>

        <div className="sftp-list" onClick={() => setLocalSel(null)}>
          {localLoading && <div className="sftp-status">加载中…</div>}
          {!localLoading && localError && <div className="sftp-status error">{localError}</div>}
          {!localLoading && !localError && !localCwd && (
            <div className="sftp-status muted">点击「选择目录」指定本地位置</div>
          )}
          {!localLoading && !localError && localCwd && localEntries.length === 0 && (
            <div className="sftp-status muted">空目录</div>
          )}
          {localEntries.map((e) => (
            <div
              key={e.name}
              className={`sftp-row${localSel === e.name ? " selected" : ""}`}
              onClick={(ev) => {
                ev.stopPropagation();
                setLocalSel(e.name === localSel ? null : e.name);
              }}
              onDoubleClick={() => {
                if (!e.isDir) return;
                const next = localCwd.endsWith("/") || localCwd.endsWith("\\")
                  ? localCwd + e.name
                  : localCwd + (localCwd.includes("\\") ? "\\" : "/") + e.name;
                setLocalSel(null);
                void listLocal(next);
              }}
              title={e.name}
            >
              <span className={`sftp-name${e.isDir ? " dir" : ""}`}>
                {e.isDir ? "📁" : "📄"} {e.name}
              </span>
              <span className="sftp-size">{e.isDir ? "" : fmtSize(e.size)}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- 传输队列 ---------- */}
      {transfers.length > 0 && (
        <section className="sftp-pane transfers">
          <header className="sftp-pane-head">
            <span className="sftp-pane-title">传输</span>
          </header>
          <div className="sftp-list">
            {transfers.map((t) => (
              <div key={t.id} className={`sftp-row transfer ${t.status}`}>
                <span className="sftp-name">
                  {t.kind === "download" ? "↓" : "↑"} {t.name}
                </span>
                <span className={`sftp-xfer-status ${t.status}`}>
                  {t.status === "running"
                    ? "进行中…"
                    : t.status === "done"
                      ? "完成"
                      : `失败${t.error ? `: ${t.error}` : ""}`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}
