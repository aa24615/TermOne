import { useEffect, useState } from "react";
import type { HistoryRow } from "../commandHistory";
import type { Host } from "../plugin/types";
import { report } from "../plugin/shared";
import { createHistoryController } from "./historyController";

const controllers = new WeakMap<Host, ReturnType<typeof createHistoryController>>();
export function activate(host: Host) {
  const controller = createHistoryController(host);
  controllers.set(host, controller);
  return () => { controller.dispose(); controllers.delete(host); };
}

export default function CommandHistory({ host }: { host: Host }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const controller = controllers.get(host);
  useEffect(() => controller?.subscribe(() => setRevision(n => n + 1)), [controller]);
  useEffect(() => {
    if (!controller) return;
    let alive = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void controller.recent(query).then(next => { if (alive && !host.signal.aborted) setRows(next); })
        .catch(error => { if (alive && !host.signal.aborted) host.toast(String(error), true); })
        .finally(() => { if (alive) setLoading(false); });
    }, 100);
    return () => { alive = false; clearTimeout(timer); };
  }, [controller, host, query, revision]);
  return <div className="plugin-stack command-history">
    <p className="muted">记录已提交的本地 / SSH 命令，相同命令合并，仅保存在本机。</p>
    <input aria-label="搜索历史命令" placeholder="搜索历史命令…" value={query} onChange={event => setQuery(event.target.value)} />
    <div className="plugin-actions history-summary">
      <span className="muted">{loading ? "正在加载…" : `${rows.length} 条命令${rows.length === 500 ? "（最多显示 500 条，可搜索更多）" : ""}`}</span>
      <button className="btn small danger" disabled={!controller || !rows.length || loading} onClick={() => report(host, async () => {
        if (controller && await host.confirm("清空本机全部历史命令？此操作不会影响终端中的 Shell 历史。")) await controller.clear();
      })}>清空历史</button>
    </div>
    {!loading && !rows.length && <p className="muted history-empty">{query.trim() ? "没有匹配的命令" : "暂无历史命令，回到终端输入命令并按回车后会自动记录。"}</p>}
    <div className="history-list" aria-label="历史命令列表" aria-live="polite">
      {rows.map(row => <section className="history-entry" key={row.command}>
        <pre>{row.command}</pre>
        <div className="history-entry-meta">
          <span>{new Date(row.timestamp).toLocaleString("zh-CN", { hour12: false })} · 使用 {row.useCount} 次</span>
          <button className="btn small" aria-label={`复制命令 ${row.command}`} onClick={() => report(host, async () => {
            await navigator.clipboard.writeText(row.command);
            host.toast("命令已复制");
          })}>复制</button>
        </div>
      </section>)}
    </div>
  </div>;
}
