import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Host } from "../plugin/types";
import { report } from "../plugin/shared";
import { Modal } from "../components/Dialog";
import { Dropdown } from "../components/Dropdown";
import { useStore } from "../store";
import { activeCommandTarget, executePanelCommand } from "../plugin/commandActions";
import { filterSnippets, snippetCounts, snippetGroupId, type Snippet, type SnippetGroup } from "./snippetModel";

const ALL = "__all__";
const blank = (groupId: string | null = null): Snippet => ({ id: "", title: "", body: "", groupId, sortOrder: 0, updatedAt: 0, createdAt: 0, deleted: false, dirty: true });

export default function Snippets({ host }: { host: Host }) {
  const [rows, setRows] = useState<Snippet[]>([]);
  const [groups, setGroups] = useState<SnippetGroup[]>([]);
  const [group, setGroup] = useState(ALL);
  const [query, setQuery] = useState("");
  const [manage, setManage] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const tabs = useStore(s => s.tabs);
  const activeTabId = useStore(s => s.activeTabId);
  const activePaneId = useStore(s => s.activePaneId);
  const target = activeCommandTarget({ tabs, activeTabId, activePaneId });
  const reload = useCallback(async () => {
    try {
      const [commands, nextGroups] = await Promise.all([host.invoke<Snippet[]>("snippet_list"), host.invoke<SnippetGroup[]>("snippet_group_list")]);
      if (!host.signal.aborted) { setRows(commands); setGroups(nextGroups); setError(""); }
    } catch (error) {
      if (!host.signal.aborted) setError(`加载失败：${String(error)}。旧版插件请先在插件管理中更新并重新启用。`);
      throw error;
    }
  }, [host]);
  useEffect(() => { report(host, reload); }, [host, reload]);
  useEffect(() => { if (group !== ALL && group && !groups.some(g => g.id === group)) setGroup(""); }, [group, groups]);
  const shown = filterSnippets(rows, groups, group, query);
  const counts = useMemo(() => snippetCounts(rows, groups), [rows, groups]);
  const items = [{ id: ALL, name: "全部" }, { id: "", name: "未分组" }, ...groups];
  return <div className="plugin-stack snippets-panel">
    <div className="snippet-toolbar"><span className="muted">{target ? `当前终端：${target.title || target.sessionTitle || "终端"}` : "请先选中本地或 SSH 终端"}</span><button className="btn small" onClick={() => setManage(true)}>管理命令</button></div>
    <div className="snippet-tabs" role="tablist" aria-label="常用命令分组">
      {items.map((item, index) => <button key={item.id} role="tab" aria-selected={group === item.id} tabIndex={group === item.id ? 0 : -1} className={group === item.id ? "selected" : ""}
        onClick={() => setGroup(item.id)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % items.length : event.key === "ArrowLeft" ? (index + items.length - 1) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
          if (next >= 0) { event.preventDefault(); setGroup(items[next].id); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus(); }
        }}>{item.name}<small>{counts.get(item.id) ?? 0}</small></button>)}
    </div>
    <input aria-label="搜索常用命令" placeholder="搜索名称或命令…" value={query} onChange={event => setQuery(event.target.value)} />
    {error && <p className="error" role="alert">{error}</p>}
    {!error && !shown.length && <p className="muted history-empty">{query.trim() ? "没有匹配的命令" : "此分组暂无命令，点击「管理命令」添加。"}</p>}
    <div className="snippet-command-list" role="tabpanel" aria-label="常用命令列表">
      {shown.map(snippet => <button key={snippet.id} className="command-launch" disabled={!target || sending} title="点击发送到当前终端并自动回车执行" onClick={() => {
        if (sending) return;
        setSending(true);
        void executePanelCommand(host, snippet.body).catch(error => { if (!host.signal.aborted) host.toast(String(error), true); }).finally(() => setSending(false));
      }}><strong>{snippet.title}</strong><pre>{snippet.body}</pre><span className="muted">点击执行</span></button>)}
    </div>
    {manage && createPortal(<div className="snippet-manager-layer"><SnippetManager host={host} rows={rows} groups={groups} initialGroup={group} reload={reload} onClose={() => setManage(false)} /></div>, document.body)}
  </div>;
}

function SnippetManager({ host, rows, groups, initialGroup, reload, onClose }: { host: Host; rows: Snippet[]; groups: SnippetGroup[]; initialGroup: string; reload: () => Promise<void>; onClose: () => void }) {
  const [group, setGroup] = useState(initialGroup);
  const [draft, setDraft] = useState<Snippet>(() => blank(initialGroup === ALL ? null : initialGroup || null));
  const [groupDraft, setGroupDraft] = useState<SnippetGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const currentGroup = groups.find(item => item.id === group);
  const shown = filterSnippets(rows, groups, group, "");
  const run = (task: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    report(host, async () => { try { await task(); } finally { setBusy(false); } });
  };
  const groupOptions = [{ value: "", label: "未分组" }, ...groups.map(item => ({ value: item.id, label: item.name }))];
  useEffect(() => { if (group && group !== ALL && !groups.some(g => g.id === group)) setGroup(""); }, [groups, group]);
  return <Modal title="管理常用命令" width={900} onClose={onClose}>
    <div className="snippet-manager plugin-stack">
      <aside className="snippet-manager-browser">
        <label>筛选分组<Dropdown ariaLabel="管理命令分组筛选" value={group} onChange={setGroup} options={[{ value: ALL, label: "全部分组" }, ...groupOptions]} /></label>
        <div className="plugin-actions">
          <button className="btn small" disabled={busy} onClick={() => setGroupDraft({ id: crypto.randomUUID(), name: "" })}>新建分组</button>
          <button className="btn small" disabled={busy || !currentGroup} onClick={() => currentGroup && setGroupDraft({ ...currentGroup })}>重命名分组</button>
          <button className="btn small danger" disabled={busy || !currentGroup} onClick={() => run(async () => {
            if (!currentGroup || !(await host.confirm(`删除分组「${currentGroup.name}」？组内命令将移入未分组，命令不会删除。`))) return;
            await host.invoke("snippet_group_delete", { id: currentGroup.id });
            if (draft.groupId === currentGroup.id) setDraft(previous => ({ ...previous, groupId: null }));
            setGroup(""); await reload();
          })}>删除分组</button>
        </div>
        {groupDraft && <form className="snippet-group-editor" onSubmit={event => { event.preventDefault(); run(async () => {
          await host.invoke("snippet_group_save", { ...groupDraft });
          await reload(); setGroup(groupDraft.id); if (!draft.id) setDraft(previous => ({ ...previous, groupId: groupDraft.id })); setGroupDraft(null);
        }); }}>
          <label>分组名称<input autoFocus aria-label="分组名称" maxLength={64} value={groupDraft.name} onChange={event => setGroupDraft({ ...groupDraft, name: event.target.value })} /></label>
          <div className="plugin-actions"><button className="btn primary small" type="submit" disabled={busy || !groupDraft.name.trim()}>保存分组</button><button className="btn small" type="button" onClick={() => setGroupDraft(null)}>取消</button></div>
        </form>}
        <button className="btn" disabled={busy} onClick={() => setDraft(blank(group === ALL ? null : group || null))}>新增命令</button>
        <div className="snippet-manager-list" aria-label="待管理命令">
          {shown.map(snippet => <button className={`snippet-edit-row${draft.id === snippet.id ? " selected" : ""}`} key={snippet.id} disabled={busy} onClick={() => setDraft({ ...snippet, groupId: snippetGroupId(snippet, groups) || null })}><strong>{snippet.title}</strong><span>{snippet.body}</span></button>)}
          {!shown.length && <p className="muted">此分组暂无命令</p>}
        </div>
      </aside>
      <form className="plugin-stack snippet-editor" onSubmit={event => { event.preventDefault(); run(async () => {
        const saved = await host.invoke<Snippet>("snippet_save", { snippet: { ...draft, id: draft.id || crypto.randomUUID(), title: draft.title.trim() } });
        await reload(); setDraft(saved); host.toast("命令已保存");
      }); }}>
        <h3>{draft.id ? "编辑命令" : "新增命令"}</h3>
        <label>命令名称<input aria-label="命令名称" maxLength={256} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>所属分组<Dropdown ariaLabel="命令所属分组" value={draft.groupId || ""} options={groupOptions} onChange={value => setDraft({ ...draft, groupId: value || null })} /></label>
        <label>命令内容<textarea aria-label="命令内容" rows={9} value={draft.body} onChange={event => setDraft({ ...draft, body: event.target.value })} /></label>
        <div className="plugin-actions">
          <button className="btn primary" type="submit" disabled={busy || !draft.title.trim() || !draft.body.trim()}>保存命令</button>
          <button className="btn danger" type="button" disabled={busy || !draft.id} onClick={() => run(async () => {
            if (!(await host.confirm(`删除命令「${draft.title}」？`))) return;
            await host.invoke("snippet_delete", { id: draft.id }); await reload(); setDraft(blank(group === ALL ? null : group || null));
          })}>删除命令</button>
        </div>
      </form>
    </div>
  </Modal>;
}
