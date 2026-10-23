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
  const groups = useStore((s) => s.groups);
  const openTerminal = useStore((s) => s.openTerminal);
  const deleteProfile = useStore((s) => s.deleteProfile);
  const setDialog = useStore((s) => s.setDialog);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = q ? profiles.filter((p) => p.name.toLowerCase().includes(q)) : profiles;

  // 按分组（文件夹）归类；分组按 sortOrder 排序，未分组档案放在最后。
  const groupOrder = [...groups].sort((a, b) => a.sortOrder - b.sortOrder);
  const groupName = new Map(groupOrder.map((g) => [g.id, g.name]));
  const byGroup = new Map<string | null, typeof filtered>();
  for (const p of filtered) {
    const key = p.groupId && groupName.has(p.groupId) ? p.groupId : null;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(p);
  }
  const orderedKeys: (string | null)[] = [...groupOrder.map((g) => g.id), null];
  const renderKeys = orderedKeys.filter((k) => byGroup.has(k));

  return (
    <aside className="sidebar">
      <div className="sidebar-search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索终端…"
          spellCheck={false}
        />
      </div>

      <div className="sidebar-scroll">
        <div className="side-section">
          <div className="side-header">
            <span>终端列表</span>
            <button
              className="icon-btn"
              title="新建档案"
              onClick={() => setDialog({ type: "profile" })}
            >
              <IconPlus size={14} />
            </button>
          </div>

          {filtered.length === 0 && <div className="side-empty">暂无终端，点击 + 新建</div>}

          {renderKeys.map((key) => {
            const list = byGroup.get(key)!;
            return (
              <div className="profile-group" key={key ?? "__ungrouped__"}>
                {key && (
                  <div className="group-header">
                    <span>{groupName.get(key)}</span>
                    <span className="group-count">{list.length}</span>
                  </div>
                )}
                {!key && list.length > 0 && (
                  <div className="group-header">
                    <span>未分组</span>
                    <span className="group-count">{list.length}</span>
                  </div>
                )}
                {list.map((p) => {
                  const color = (p.config as { color?: string }).color;
                  return (
                    <div
                      key={p.id}
                      className="profile-item"
                      onClick={() => void openTerminal(p.id)}
                      title="点击打开会话"
                    >
                      <span
                        className={`kind-badge kind-${p.kind}`}
                        style={color ? { background: color, color: "#fff" } : undefined}
                      >
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
                  );
                })}
              </div>
            );
          })}
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
