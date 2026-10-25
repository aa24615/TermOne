import { useState, type DragEvent, type ReactNode } from "react";
import { profileSubtitle } from "../profile";
import { ipc } from "../ipc";
import { scheduleSync, useStore } from "../store";
import type { ProfileRow } from "../types";
import { confirm, promptText } from "./Dialog";
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
  return kind === "ssh" ? (
    <IconGlobe size={13} />
  ) : kind === "serial" ? (
    <IconUsb size={13} />
  ) : (
    <IconTerminal size={13} />
  );
}
export function Sidebar() {
  const profiles = useStore((s) => s.profiles);
  const groups = useStore((s) => s.groups);
  const openTerminal = useStore((s) => s.openTerminal);
  const saveProfile = useStore((s) => s.saveProfile);
  const deleteProfile = useStore((s) => s.deleteProfile);
  const setDialog = useStore((s) => s.setDialog);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? profiles.filter((p) =>
        (p.name + " " + profileSubtitle(p)).toLowerCase().includes(q),
      )
    : profiles;
  const run = (fn: () => Promise<unknown>) => {
    void fn()
      .then(async () => {
        await useStore.getState().loadGroups();
        await useStore.getState().loadProfiles();
        scheduleSync();
      })
      .catch((e) => useStore.getState().showToast(String(e), "error"));
  };
  const create = (parentId: string | null) =>
    run(async () => {
      const name = await promptText("新分组名称");
      if (name?.trim()) await ipc.groupCreate(name.trim(), parentId);
    });
  const drop = (
    event: DragEvent,
    groupId: string | null,
    before?: ProfileRow,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const profileId = event.dataTransfer.getData(
      "application/x-termone-profile",
    );
    const moving = profiles.find((p) => p.id === profileId);
    if (moving)
      run(async () => {
        const list = profiles.filter(
          (p) => p.groupId === groupId && p.id !== moving.id,
        );
        const at = before
          ? list.findIndex((p) => p.id === before.id)
          : list.length;
        list.splice(at < 0 ? list.length : at, 0, { ...moving, groupId });
        for (let i = 0; i < list.length; i++)
          if (!(await saveProfile({ ...list[i], sortOrder: i })))
            throw new Error("档案排序保存失败");
      });
    const group = event.dataTransfer.getData("application/x-termone-group");
    if (group) run(() => ipc.groupMove(group, groupId));
  };
  const highlight = (text: string) => {
    const at = q ? text.toLowerCase().indexOf(q) : -1;
    return at < 0 ? (
      text
    ) : (
      <>
        {text.slice(0, at)}
        <mark>{text.slice(at, at + q.length)}</mark>
        {text.slice(at + q.length)}
      </>
    );
  };
  const rows = (groupId: string | null) =>
    filtered
      .filter((p) =>
        groupId
          ? p.groupId === groupId
          : !p.groupId || !groups.some((g) => g.id === p.groupId),
      )
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((p) => (
        <div
          className="profile-item"
          key={p.id}
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData("application/x-termone-profile", p.id);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => drop(e, groupId, p)}
          onClick={() => void openTerminal(p.id)}
          title="点击连接，拖动调整分组或顺序"
        >
          <span
            className={"kind-badge kind-" + p.kind}
            style={
              p.config.color
                ? { background: p.config.color, color: "#fff" }
                : undefined
            }
          >
            <KindIcon kind={p.kind} />
          </span>
          <div className="profile-meta">
            <div className="profile-name">{highlight(p.name)}</div>
            <div className="profile-sub">{highlight(profileSubtitle(p))}</div>
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
                run(async () => {
                  if (
                    await confirm({
                      title: "删除档案",
                      message: "删除「" + p.name + "」？",
                    })
                  )
                    await deleteProfile(p.id);
                });
              }}
            >
              <IconTrash size={13} />
            </button>
          </div>
        </div>
      ));
  const visited = new Set<string>();
  const groupNode = (id: string, depth = 0): ReactNode => {
    const g = groups.find((g) => g.id === id);
    if (!g || visited.has(id) || depth > 20) return null;
    visited.add(id);
    return (
      <section
        key={id}
        className="profile-group"
        style={{ marginLeft: depth ? 8 : 0 }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => drop(e, id)}
      >
        <div
          className="group-header"
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData("application/x-termone-group", id);
          }}
        >
          <button
            className="group-toggle"
            onClick={() => run(() => ipc.groupCollapsed(id, !g.collapsed))}
          >
            {g.collapsed && !q ? "▸" : "▾"} {g.name}
          </button>
          <div className="profile-actions">
            <button
              className="icon-btn"
              title="新建子分组"
              onClick={() => create(id)}
            >
              <IconPlus size={12} />
            </button>
            <button
              className="icon-btn"
              title="重命名分组"
              onClick={() =>
                run(async () => {
                  const name = await promptText("分组名称", g.name);
                  if (name?.trim()) await ipc.groupRename(id, name.trim());
                })
              }
            >
              <IconEdit size={12} />
            </button>
            <button
              className="icon-btn danger"
              title="删除分组（保留档案）"
              onClick={() =>
                run(async () => {
                  if (
                    await confirm({
                      title: "删除分组",
                      message: "删除「" + g.name + "」并将档案移至未分组？",
                    })
                  )
                    await ipc.groupDelete(id);
                })
              }
            >
              <IconTrash size={12} />
            </button>
          </div>
        </div>
        {(!g.collapsed || q) && (
          <>
            {rows(id)}
            {groups
              .filter((child) => child.parentId === id)
              .map((child) => groupNode(child.id, depth + 1))}
          </>
        )}
      </section>
    );
  };
  const tree = groups
    .filter((g) => !g.parentId || !groups.some((p) => p.id === g.parentId))
    .map((g) => groupNode(g.id));
  const orphaned = groups
    .filter(
      (g) =>
        !visited.has(g.id) &&
        (!g.parentId || !groups.some((p) => p.id === g.parentId)),
    )
    .map((g) => groupNode(g.id));
  return (
    <aside className="sidebar">
      <div className="sidebar-search">
        <input
          placeholder="搜索名称、主机或用户名…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="sidebar-scroll">
        <div className="side-section">
          <div className="side-header">
            <span>终端列表</span>
            <div>
              <button
                className="icon-btn"
                title="新建分组"
                onClick={() => create(null)}
              >
                ▣
              </button>
              <button
                className="icon-btn"
                title="新建档案"
                onClick={() => setDialog({ type: "profile" })}
              >
                <IconPlus size={14} />
              </button>
            </div>
          </div>
          {tree}
          {orphaned}
          <section
            className="profile-group"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => drop(e, null)}
          >
            <div className="group-header">未分组（拖入此处移出分组）</div>
            {rows(null)}
          </section>
          {filtered.length === 0 && (
            <div className="side-empty">暂无匹配终端</div>
          )}
        </div>
      </div>
      <AccountSection />
      <div className="sidebar-footer">
        <button className="side-btn" onClick={() => setDialog({type:"applications"})}>▦ 应用管理</button>
        <button
          className="side-btn"
          onClick={() => setDialog({ type: "plugins" })}
        >
          ◇ 插件管理
        </button>
        <button
          className="side-btn"
          onClick={() => setDialog({ type: "settings" })}
        >
          <IconGear size={14} /> 设置
        </button>
        <button
          className="side-btn"
          onClick={() => setDialog({ type: "about" })}
        >
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
        <button
          className="side-btn primary"
          onClick={() => setDialog({ type: "account" })}
        >
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
      <div className={`account-sync${auth.error ? " err" : ""}`}>
        {syncState}
      </div>
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
