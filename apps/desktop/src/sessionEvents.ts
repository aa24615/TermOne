import { listen } from "@tauri-apps/api/event";
type Output = { id: string; data: string };
type Exit = { id: string; code: number | null };
const outputs = new Map<string, (data: string) => void>();
const exits = new Map<string, (code: number | null) => void>();
const buffered = new Map<string, string[]>();
const ended = new Map<string, number | null>();
let ready: Promise<void> | null = null;
export function ensureSessionEvents() {
  if (!ready)
    ready = (async () => {
      const unlistenOutput = await listen<Output>(
        "session:output",
        ({ payload }) => {
          const cb = outputs.get(payload.id);
          if (cb) cb(payload.data);
          else {
            const queue = buffered.get(payload.id) ?? [];
            queue.push(payload.data);
            while (queue.reduce((n, s) => n + s.length, 0) > 350_000)
              queue.shift();
            buffered.set(payload.id, queue);
            if (buffered.size > 32)
              buffered.delete(buffered.keys().next().value!);
          }
        },
      );
      try {
        await listen<Exit>("session:exit", ({ payload }) => {
          const cb = exits.get(payload.id);
          if (cb) cb(payload.code);
          else {
            ended.set(payload.id, payload.code);
            if (ended.size > 128) ended.delete(ended.keys().next().value!);
          }
        });
      } catch (e) {
        unlistenOutput();
        throw e;
      }
    })().catch((e) => {
      ready = null;
      throw e;
    });
  return ready;
}
export function onSessionOutput(id: string, cb: (data: string) => void) {
  outputs.set(id, cb);
  const queue = buffered.get(id) ?? [];
  buffered.delete(id);
  queue.forEach(cb);
  return () => {
    outputs.delete(id);
    buffered.delete(id);
  };
}
export function onSessionExit(id: string, cb: (code: number | null) => void) {
  exits.set(id, cb);
  if (ended.has(id)) {
    const code = ended.get(id)!;
    ended.delete(id);
    cb(code);
  }
  return () => {
    exits.delete(id);
    ended.delete(id);
  };
}
