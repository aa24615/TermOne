import type { Host } from "../plugin/types";
export interface MonitorSample {
  sequence: number; sampledAt: number; cpuPct: number | null; memoryTotal: number; memoryUsed: number; memoryPct: number; uptimeSeconds: number;
  load: { one: number; five: number; fifteen: number } | null;
  disks: { filesystem: string; total_bytes: number; used_bytes: number; available_bytes: number; capacity_pct: number; mountpoint: string }[];
  network: { name: string; rx_bytes_per_sec: number; tx_bytes_per_sec: number }[];
}
export interface MonitorStatus { phase: string; sample: MonitorSample | null; error: string | null }
export function createMonitorController(host: Pick<Host, "invoke" | "signal">, changed: (status: MonitorStatus) => void, paused = () => false) {
  let generation = 0, disposed = false;
  let runId: string | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const enqueue = (work: () => Promise<void>) => { const task = tail.catch(() => {}).then(work); tail = task; return task; };
  const cancelTimer = () => { clearTimeout(timer); timer = undefined; };
  const current = (id: string, version: number) => !disposed && !host.signal.aborted && runId === id && generation === version;
  const poll = async (id: string, version: number) => {
    if (!current(id, version)) return;
    if (paused()) { timer = setTimeout(() => void poll(id, version), 750); return; }
    try {
      const status = await host.invoke<MonitorStatus>("monitor_poll", { runId: id });
      if (!current(id, version)) return;
      changed(status);
      if (!["error", "stopped"].includes(status.phase)) timer = setTimeout(() => void poll(id, version), 750);
    } catch (error) {
      if (current(id, version)) {
        if (paused()) timer = setTimeout(() => void poll(id, version), 750);
        else { changed({ phase: "error", sample: null, error: String(error) }); void enqueue(async () => { await host.invoke("monitor_stop", { runId: id }); }).catch(() => {}); }
      }
    }
  };
  const stop = () => {
    const id = runId;
    generation++; runId = null; cancelTimer();
    if (id) return enqueue(async () => { await host.invoke("monitor_stop", { runId: id }); }).catch(() => {});
    return Promise.resolve();
  };
  const dispose = () => { if (disposed) return; void stop(); disposed = true; host.signal.removeEventListener("abort", dispose); };
  host.signal.addEventListener("abort", dispose, { once: true });
  return {
    async start(profileId: string, interval: number) {
      if (disposed || host.signal.aborted) return;
      void stop();
      const id = crypto.randomUUID(), version = ++generation;
      runId = id;
      changed({ phase: "connecting", sample: null, error: null });
      return enqueue(async () => {
        if (!current(id, version)) return;
        try {
          const status = await host.invoke<MonitorStatus>("monitor_start", { runId: id, profileId, interval });
          if (!current(id, version)) { await host.invoke("monitor_stop", { runId: id }); return; }
          changed(status); void poll(id, version);
        } catch (error) { if (current(id, version)) changed({ phase: "error", sample: null, error: String(error) }); }
      });
    },
    async authenticate(secret: string) {
      const id = runId, version = generation;
      if (!id || !current(id, version)) return;
      await enqueue(async () => { if (current(id, version)) await host.invoke("monitor_auth", { runId: id, secret }); });
    },
    stop, dispose,
  };
}
export function appendSample(rows: MonitorSample[], sample: MonitorSample) {
  if (rows.at(-1)?.sequence === sample.sequence) return rows;
  return [...rows, sample].slice(-60);
}
export function networkTotal(sample: MonitorSample, name = "") {
  const rows = sample.network.filter(row => name ? row.name === name : row.name !== "lo");
  return rows.length ? { rx: rows.reduce((sum, row) => sum + row.rx_bytes_per_sec, 0), tx: rows.reduce((sum, row) => sum + row.tx_bytes_per_sec, 0) } : null;
}
export function diskPeak(sample: MonitorSample) { return [...sample.disks].sort((a, b) => b.capacity_pct - a.capacity_pct)[0]; }
