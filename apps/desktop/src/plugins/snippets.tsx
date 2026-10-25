import { useEffect, useState } from "react";
import type { Host } from "../plugin/types";
import { SessionPicker, report } from "../plugin/shared";
interface Snippet {
  id: string;
  title: string;
  body: string;
}
export default function Snippets({ host }: { host: Host }) {
  const [rows, setRows] = useState<Snippet[]>([]);
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [target, setTarget] = useState("");
  const reload = async () => setRows(await host.invoke("snippet_list"));
  useEffect(() => {
    report(host, reload);
  }, [host]);
  return (
    <div className="plugin-stack">
      <SessionPicker host={host} value={target} onChange={setTarget} />
      <label>
        名称
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        命令
        <textarea
          rows={6}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="plugin-actions">
        <button
          className="btn"
          disabled={!title.trim() || !body}
          onClick={() =>
            report(host, async () => {
              await host.invoke("snippet_save", {
                snippet: {
                  id: id || crypto.randomUUID(),
                  title: title.trim(),
                  body,
                  sortOrder: 0,
                  updatedAt: 0,
                  createdAt: 0,
                  deleted: false,
                  dirty: true,
                },
              });
              await reload();
            })
          }
        >
          保存片段
        </button>
        <button
          className="btn"
          onClick={() => {
            setId("");
            setTitle("");
            setBody("");
          }}
        >
          新建
        </button>
        <button
          className="btn primary"
          disabled={!target || !body}
          onClick={() =>
            report(host, async () => {
              if (await host.confirm("将向选定会话执行：\n\n" + body))
                await host.write(target, body + "\r");
            })
          }
        >
          确认后执行
        </button>
      </div>
      {rows.map((s) => (
        <section className="plugin-card" key={s.id}>
          <strong>{s.title}</strong>
          <pre>{s.body}</pre>
          <button
            className="btn"
            onClick={() => {
              setId(s.id);
              setTitle(s.title);
              setBody(s.body);
            }}
          >
            编辑
          </button>{" "}
          <button
            className="btn danger"
            onClick={() =>
              report(host, async () => {
                if (await host.confirm("删除片段「" + s.title + "」？")) {
                  await host.invoke("snippet_delete", { id: s.id });
                  await reload();
                }
              })
            }
          >
            删除
          </button>
        </section>
      ))}
    </div>
  );
}
