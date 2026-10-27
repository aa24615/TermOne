import type { Terminal } from "@xterm/xterm";
import type { Dispose, TerminalHandle } from "./types";

const terminals = new Map<string, TerminalHandle>();
const listeners = new Set<(h: TerminalHandle) => Dispose>();
const cleanups = new Map<
  TerminalHandle,
  Map<(h: TerminalHandle) => Dispose, Dispose>
>();
const observers = new Set<(id: string, text: string) => void>();
const inputs = new Set<(id: string, text: string) => void>();
const commandSenders = new Map<string, (command: string, signal?: AbortSignal) => Promise<boolean>>();
export function registerCommandSender(id: string, sender: (command: string, signal?: AbortSignal) => Promise<boolean>) {
  commandSenders.set(id, sender);
  return () => { if (commandSenders.get(id) === sender) commandSenders.delete(id); };
}
export function executeTerminalCommand(id: string, command: string, signal?: AbortSignal): Promise<boolean> {
  const sender = commandSenders.get(id);
  if (!sender) throw new Error("终端尚未准备好或已关闭");
  return sender(command, signal);
}
export function observeOutput(cb: (id: string, text: string) => void): Dispose {
  observers.add(cb);
  return () => {
    observers.delete(cb);
  };
}
export function observeInput(cb: (id: string, text: string) => void): Dispose {
  inputs.add(cb);
  return () => {
    inputs.delete(cb);
  };
}
export function notifyInput(id: string, text: string) {
  for (const cb of inputs) {
    try {
      cb(id, text);
    } catch {
      /* plugin isolation */
    }
  }
}
export function attachTerminals(cb: (h: TerminalHandle) => Dispose): Dispose {
  listeners.add(cb);
  for (const h of terminals.values()) {
    try {
      cleanups.get(h)!.set(cb, cb(h));
    } catch {
      /* plugin isolation */
    }
  }
  return () => {
    listeners.delete(cb);
    for (const h of terminals.values()) {
      cleanups.get(h)?.get(cb)?.();
      cleanups.get(h)?.delete(cb);
    }
  };
}
export function registerTerminal(id: string, term: Terminal) {
  const outputs = new Set<(b: Uint8Array) => Uint8Array | null>();
  const filters = new Set<(t: string) => string | null>();
  const decoder = new TextDecoder();
  const h: TerminalHandle = {
    id,
    term,
    output(fn) {
      outputs.add(fn);
      return () => {
        outputs.delete(fn);
      };
    },
    input(fn) {
      filters.add(fn);
      return () => {
        filters.delete(fn);
      };
    },
    addon(addon) {
      term.loadAddon(addon);
      return () => addon.dispose();
    },
  };
  terminals.set(id, h);
  const disposals = new Map<(h: TerminalHandle) => Dispose, Dispose>();
  cleanups.set(h, disposals);
  for (const cb of listeners) {
    try {
      disposals.set(cb, cb(h));
    } catch {
      /* plugin isolation */
    }
  }
  return {
    output(bytes: Uint8Array): Uint8Array | null {
      const text = decoder.decode(bytes, { stream: true });
      for (const cb of observers) {
        try {
          cb(id, text);
        } catch {
          /* plugin isolation */
        }
      }
      let value: Uint8Array | null = bytes;
      for (const fn of outputs) {
        if (value) {
          try {
            value = fn(value);
          } catch {
            /* keep terminal running */
          }
        }
      }
      return value;
    },
    input(text: string): string | null {
      let value: string | null = text;
      for (const fn of filters) {
        if (value !== null) {
          try {
            value = fn(value);
          } catch {
            /* keep terminal running */
          }
        }
      }
      if (value !== null) notifyInput(id, value);
      return value;
    },
    dispose() {
      for (const dispose of disposals.values()) {
        try {
          dispose();
        } catch {
          /* cleanup continues */
        }
      }
      terminals.delete(id);
      cleanups.delete(h);
    },
  };
}
