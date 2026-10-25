import { Dropdown } from "../components/Dropdown";
import { useEffect, useState } from "react";
import type { Host } from "../plugin/types";
import { downloadText, report } from "../plugin/shared";
interface Log {
  id: string;
  size: number;
  modified: number;
}
export default function SessionLog({ host }: { host: Host }) {
  const [logs, setLogs] = useState<Log[]>([]);
  const [id, setId] = useState("");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const reload = async () => setLogs(await host.invoke("session_log_list"));
  useEffect(() => {
    report(host, reload);
  }, [host]);
  const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
  return (
    <div className="plugin-stack">
      <p className="muted">
        在核心设置中开启「记录会话日志」后，新会话输出才会录制。日志仅保存在本机。
      </p>
      <div className="plugin-actions">
        <Dropdown
          ariaLabel="录制会话" value={id}
          onChange={(value) => {
            setId(value);
            if (!value) { setText(""); return; }
            report(host, async () => setText(await host.invoke("session_log_read", { id: value })));
          }}
          options={[{ value: "", label: "选择录制会话" }, ...logs.map((log) => ({
            value: log.id,
            label: `${new Date(log.modified).toLocaleString()} · ${log.id.slice(0, 8)} · ${log.size} B`,
          }))]}
        />
        <button className="btn" onClick={() => report(host, reload)}>
          刷新
        </button>
        <button
          className="btn"
          disabled={!text}
          onClick={() => downloadText(id + ".log", text)}
        >
          导出
        </button>
      </div>
      <input
        placeholder="搜索日志"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <pre className="plugin-log">
        {lines
          .filter(
            (l) => !query || l.toLowerCase().includes(query.toLowerCase()),
          )
          .join("\n")}
      </pre>
    </div>
  );
}
