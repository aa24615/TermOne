import { useState } from "react";

import { profileSubtitle } from "../profile";
import { useStore } from "../store";
import type { ProfileRow } from "../types";
import {
  IconEdit,
  IconGear,
  IconGlobe,
  IconInfo,
  IconPlus,
  IconSync,
  IconTerminal,
  IconTrash,
  IconUser,
  IconUsb,
} from "./icons";

function KindIcon({ kind }: { kind: ProfileRow["kind"] }) {
  if (kind === "ssh") return <IconGlobe size={13} />;
  if (kind === "serial") return <IconUsb size={13} />;
  return <IconTerminal size={13} />;
}

export function Sidebar() {
  const profiles = useStore((s) => s.profiles);
  const openTerminal = useStore((s) => s.openTerminal);
  const deleteProfile = useStore((s) => s.deleteProfile);
  const setDialog = useStore((s) => s.setDialog);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = q ? profiles.filter((p) => p.name.toLowerCase().includes(q)) : profiles;

  return (
    <aside className="sidebar">
      <div className="sidebar-search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索档案…"
          spellCheck={false}
        />
      </div>

      <div className="sidebar-scroll">
        <div className="side-section">
          <div className="side-header">
            <span>连接档案</span>
            <button
              className="icon-btn"
              title="新建档案"
              onClick={() => setDialog({ type: "profile" })}
            >
              <IconPlus size={14} />
            </button>
          </div>

          {filtered.length === 0 && <div className="side-empty">暂无档案，点击 + 新建</div>}

          {filtered.map((p) => (
            <div
              key={p.id}
              className="profile-item"
              onClick={() => void openTerminal(p.id)}
              title="双击列表打开会话"
            >
              <span className={`kind-badge kind-${p.kind}`}>
                <KindIcon kind={p.kind} />
              </span>
              <div className="profile-meta">
                <div className="profile-name">{p.name}</div>
                <div className="profile-sub">{profileSubtitle(p)}</div>
              </div>
              <div className="profile-actions">
                <button
                  className="icon-btn"
                  title="编辑"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDialog({ type: "profile", profileId: p.id });
                  }}
                >
                  <IconEdit size={13} />
                </button>
                <button
                  className="icon-btn danger"
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteProfile(p.id);
                  }}
                >
                  <IconTrash size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <AccountSection />

      <div className="sidebar-footer">
        <button className="side-btn" onClick={() => setDialog({ type: "settings" })}>
          <IconGear size={14} /> 设置
        </button>
        <button className="side-btn" onClick={() => setDialog({ type: "about" })}>
          <IconInfo size={14} /> 关于
        </button>
      </div>
    </aside>
  );
}

function AccountSection() {
  const auth = useStore((s) => s.auth);
  const setDialog = useStore((s) => s.setDialog);
  const syncNow = useStore((s) => s.syncNow);
  const authLogout = useStore((s) => s.authLogout);

  if (!auth.token) {
    return (
      <div className="account-section">
        <button className="side-btn primary" onClick={() => setDialog({ type: "account" })}>
          <IconUser size={14} /> 登录 / 注册
        </button>
      </div>
    );
  }

  const syncState = auth.syncing
    ? "同步中…"
    : auth.error
      ? `同步失败：${auth.error}`
      : auth.lastSyncAt
        ? `已同步 ${new Date(auth.lastSyncAt).toLocaleTimeString()}`
        : "尚未同步";

  return (
    <div className="account-section">
      <div className="account-user" title={auth.user?.email}>
        <IconUser size={14} />
        <span>{auth.user?.email}</span>
      </div>
      <div className={`account-sync${auth.error ? " err" : ""}`}>{syncState}</div>
      <div className="account-actions">
        <button
          className="side-btn"
          disabled={auth.syncing}
          onClick={() => void syncNow(false)}
        >
          <IconSync size={14} /> 立即同步
        </button>
        <button className="side-btn" onClick={authLogout}>
          退出
        </button>
      </div>
    </div>
  );
}
