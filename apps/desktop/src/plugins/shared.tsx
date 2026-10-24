import { useEffect, useState } from "react";
import "../plugin/ui.css";
import type { Host, Session } from "../plugin/types";
export function useSessions(host: Host) {
  const [sessions, setSessions] = useState<Session[]>(host.sessions());
  useEffect(() => {
    const timer = setInterval(() => setSessions(host.sessions()), 800);
    return () => clearInterval(timer);
  }, [host]);
  return sessions;
}
export function SessionPicker({
  host,
  value,
  onChange,
}: {
  host: Host;
  value: string;
  onChange: (id: string) => void;
}) {
  const sessions = useSessions(host);
  return (
    <label>
      目标会话
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">请选择会话</option>
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title} · {s.id.slice(0, 6)}
          </option>
        ))}
      </select>
    </label>
  );
}
export function downloadText(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function report(host: Host, fn: () => Promise<unknown>) {
  void fn().catch((e) => {
    if (!host.signal.aborted) host.toast(String(e), true);
  });
}
export function joinPath(dir: string, name: string) {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir ? dir.replace(/[\\/]$/, "") + sep + name : name;
}
