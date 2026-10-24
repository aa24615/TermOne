import { useState } from "react";
import type { Host, Session } from "../plugin/types";
import { report } from "./shared";
interface Rule {
  id: string;
  name: string;
  event: "output" | "connect";
  contains: string;
  command: string;
  enabled: boolean;
  cooldown: number;
  limit: number;
}
const live = new WeakMap<Host, { rules: Rule[] }>();
export async function activate(host: Host) {
  const state = { rules: (await host.storage.get<Rule[]>("rules")) ?? [] };
  live.set(host, state);
  const last = new Map<string, number>();
  const counts = new Map<string, number>();
  const tails = new Map<string, string>();
  const seen = new Set(host.sessions().map((s) => s.id));
  const fire = (rule: Rule, id: string) => {
    const key = rule.id + ":" + id;
    const now = Date.now();
    if (
      now - (last.get(key) ?? 0) < Math.max(1000, rule.cooldown) ||
      (counts.get(key) ?? 0) >= Math.max(1, Math.min(100, rule.limit))
    )
      return;
    last.set(key, now);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (rule.command) report(host, () => host.write(id, rule.command + "\r"));
    else host.toast("触发规则：" + rule.name);
  };
  host.output((id, text) => {
    const full = (tails.get(id) ?? "") + text;
    tails.set(id, full.slice(-512));
    for (const rule of state.rules)
      if (
        rule.enabled &&
        rule.event === "output" &&
        rule.contains &&
        full.includes(rule.contains)
      ) {
        fire(rule, id);
        tails.set(id, "");
      }
  });
  host.onSessions((sessions: Session[]) => {
    for (const s of sessions) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        for (const rule of state.rules)
          if (rule.enabled && rule.event === "connect") fire(rule, s.id);
      }
    }
    for (const id of seen)
      if (!sessions.some((s) => s.id === id)) {
        seen.delete(id);
        tails.delete(id);
      }
  });
  return () => {
    live.delete(host);
    tails.clear();
    counts.clear();
    last.clear();
    seen.clear();
  };
}
export default function Triggers({ host }: { host: Host }) {
  const [rules, setRules] = useState<Rule[]>(live.get(host)?.rules ?? []);
  const [name, setName] = useState("");
  const [contains, setContains] = useState("");
  const [command, setCommand] = useState("");
  const [event, setEvent] = useState<Rule["event"]>("output");
  const save = async (next: Rule[]) => {
    await host.storage.set("rules", next);
    const state = live.get(host);
    if (state) state.rules = next;
    setRules(next);
  };
  return (
    <div className="plugin-stack">
      <p className="muted">
        只匹配文字，不运行正则或脚本。规则默认停用；发送的命令必须由你填写。每条规则每会话最多触发一次，避免循环执行。
      </p>
      <input
        placeholder="规则名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <select
        value={event}
        onChange={(e) => setEvent(e.target.value as Rule["event"])}
      >
        <option value="output">输出包含文字</option>
        <option value="connect">新建会话</option>
      </select>
      {event === "output" && (
        <input
          placeholder="匹配文字"
          value={contains}
          onChange={(e) => setContains(e.target.value)}
        />
      )}
      <textarea
        placeholder="要发送的固定命令（留空则仅通知）"
        value={command}
        onChange={(e) => setCommand(e.target.value)}
      />
      <button
        className="btn"
        disabled={!name || (event === "output" && !contains)}
        onClick={() =>
          report(host, async () => {
            await save([
              ...rules,
              {
                id: crypto.randomUUID(),
                name,
                event,
                contains,
                command,
                enabled: false,
                cooldown: 5000,
                limit: 1,
              },
            ]);
            setName("");
            setContains("");
            setCommand("");
          })
        }
      >
        保存规则
      </button>
      {rules.map((r) => (
        <section className="plugin-card" key={r.id}>
          <strong>{r.name}</strong>
          <p>
            {r.event === "connect"
              ? "新建会话"
              : "输出包含「" + r.contains + "」"}{" "}
            → {r.command || "通知"}
          </p>
          <button
            className="btn"
            onClick={() =>
              report(host, async () => {
                if (
                  !r.enabled &&
                  r.command &&
                  !(await host.confirm(
                    "启用后，规则匹配时会向会话自动执行：\n\n" +
                      r.command +
                      "\n\n每个会话最多执行一次。是否启用？",
                  ))
                )
                  return;
                await save(
                  rules.map((x) =>
                    x.id === r.id ? { ...x, enabled: !x.enabled } : x,
                  ),
                );
              })
            }
          >
            {r.enabled ? "停用" : "启用"}
          </button>{" "}
          <button
            className="btn danger"
            onClick={() =>
              report(host, () => save(rules.filter((x) => x.id !== r.id)))
            }
          >
            删除
          </button>
        </section>
      ))}
    </div>
  );
}
