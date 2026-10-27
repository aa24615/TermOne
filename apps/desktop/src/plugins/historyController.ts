import { observeCommands, type HistoryRow, type SubmittedCommand } from "../commandHistory";
import type { Host } from "../plugin/types";

export function createHistoryController(host: Pick<Host, "invoke" | "sessions" | "signal" | "toast">) {
  let disposed = false;
  let pending = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const changed = () => { if (!disposed) for (const listener of listeners) listener(); };
  const enqueue = <T,>(work: () => Promise<T>) => {
    if (disposed || host.signal.aborted) return Promise.reject(new Error("历史命令插件已停用"));
    if (pending >= 128) return Promise.reject(new Error("历史命令队列已满"));
    pending++;
    const task = tail.then(() => {
      if (disposed || host.signal.aborted) throw new Error("历史命令插件已停用");
      return work();
    }).finally(() => { pending--; });
    tail = task.catch(() => {});
    return task;
  };
  const record = (entry: SubmittedCommand) => {
    const session = host.sessions().find(s => s.id === entry.sessionId && ["local", "ssh"].includes(s.kind));
    if (!session) return;
    void enqueue(async () => {
      await host.invoke("history_add", { ...entry, hostId: session.kind === "ssh" ? session.profileId : null });
      changed();
    }).catch(error => { if (!disposed && !host.signal.aborted) host.toast(String(error), true); });
  };
  const stop = observeCommands(record);
  const dispose = () => { disposed = true; stop(); listeners.clear(); };
  host.signal.addEventListener("abort", dispose, { once: true });
  return {
    recent: (query: string) => enqueue(() => host.invoke<HistoryRow[]>("history_recent", { query })),
    clear: () => enqueue(async () => { await host.invoke("history_clear"); changed(); }),
    subscribe(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    dispose() { dispose(); host.signal.removeEventListener("abort", dispose); },
  };
}
