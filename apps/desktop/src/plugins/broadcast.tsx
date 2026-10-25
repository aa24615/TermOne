import { useState } from "react";
import type { Host } from "../plugin/types";
import { report, useSessions } from "../plugin/shared";
export default function Broadcast({ host }: { host: Host }) {
  const sessions = useSessions(host);
  const [targets, setTargets] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [execute, setExecute] = useState(false);
  return (
    <div className="plugin-stack">
      <p>勾选接收会话并检查内容；每次发送都需要确认。</p>
      {sessions.map((s) => (
        <label className="check-row" key={s.id}>
          <input
            type="checkbox"
            checked={targets.includes(s.id)}
            onChange={(e) =>
              setTargets((t) =>
                e.target.checked ? [...t, s.id] : t.filter((id) => id !== s.id),
              )
            }
          />
          {s.title} · {s.id.slice(0, 6)}
        </label>
      ))}
      <textarea
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="要发送的内容"
      />
      <label className="check-row">
        <input
          type="checkbox"
          checked={execute}
          onChange={(e) => setExecute(e.target.checked)}
        />
        追加回车并执行
      </label>
      <button
        className="btn primary"
        disabled={!targets.length || !text}
        onClick={() =>
          report(host, async () => {
            const live = sessions.filter((s) => targets.includes(s.id));
            if (!live.length) throw new Error("目标会话均已结束");
            if (
              await host.confirm(
                "发送到 " +
                  live.map((s) => s.title).join("、") +
                  "：\n\n" +
                  text +
                  (execute ? "\n\n将追加回车执行。" : ""),
              )
            ) {
              const results = await Promise.allSettled(
                live.map((s) => host.write(s.id, text + (execute ? "\r" : ""))),
              );
              host.toast(
                "发送完成：" +
                  results.filter((r) => r.status === "fulfilled").length +
                  "/" +
                  live.length,
              );
            }
          })
        }
      >
        发送到所选会话
      </button>
    </div>
  );
}
