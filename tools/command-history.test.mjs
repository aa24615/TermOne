import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { TerminalInputGuard } from "../apps/desktop/src/terminalInputGuard.ts";
import { historyRecording, notifyCommand, observeCommands, resolveSubmittedCommand } from "../apps/desktop/src/commandHistory.ts";
import { createHistoryController } from "../apps/desktop/src/plugins/historyController.ts";

function terminal({ confirm = async () => true, send = () => {}, prompt = "$ " } = {}) {
  const rows = [];
  let visible = prompt;
  let alternate = false;
  const guard = new TerminalInputGuard({
    check: async () => ({ risk: "caution", statementCount: 1, multiLine: false, reasons: [] }),
    confirm, send, visibleLine: () => visible, error: message => { throw Error(message); },
    paste: text => guard.input(`\x1b[200~${text}\x1b[201~`),
    historyEnabled: () => true,
    submitted: entry => { const command = resolveSubmittedCommand(entry, visible, alternate); if (command) rows.push(command); },
  });
  return { guard, rows, echo: text => { visible = text; }, alternate: value => { alternate = value; } };
}

test("command history records complete edited submissions, never partial or cancelled input", async () => {
  const f = terminal();
  f.guard.input("git statux"); await settle();
  assert.deepEqual(f.rows, []);
  f.guard.input("\x7f"); f.guard.input("s");
  f.echo("$ git status"); f.guard.input("\r"); await settle();
  assert.deepEqual(f.rows, ["git status"]);
  f.echo("$ "); f.guard.input("discard"); await settle(); f.guard.input("\x03");
  f.guard.input("\r"); await settle();
  assert.deepEqual(f.rows, ["git status"]);
  const cancelled = terminal({ confirm: async () => false });
  cancelled.guard.input("rm -rf fixture"); await settle(); cancelled.echo("$ rm -rf fixture"); cancelled.guard.input("\r"); await settle();
  assert.deepEqual(cancelled.rows, []);
});

test("bracketed multiline paste records once only after explicit submission", async () => {
  const f = terminal();
  f.guard.paste("echo one\necho two"); await settle();
  assert.deepEqual(f.rows, []);
  f.echo("echo two"); f.guard.input("\r"); await settle();
  assert.deepEqual(f.rows, ["echo one\necho two"]);
});

test("history recall resolves visible commands without saving prompts, passwords or TUI input", async () => {
  const f = terminal();
  f.guard.input("\x1b[A"); f.echo("$ ls -la"); f.guard.input("\r"); await settle();
  assert.deepEqual(f.rows, ["ls -la"]);
  const hidden = terminal({ prompt: "[sudo] password for user: " });
  hidden.guard.input("secret"); await settle(); hidden.guard.input("\r"); await settle();
  assert.deepEqual(hidden.rows, []);
  const tui = terminal(); tui.alternate(true); tui.guard.input("not a shell command"); await settle(); tui.echo("not a shell command"); tui.guard.input("\r"); await settle();
  assert.deepEqual(tui.rows, []);
  const dropped = terminal({ send: () => false }); dropped.guard.input("filtered"); await settle(); dropped.echo("$ filtered"); dropped.guard.input("\r"); await settle();
  assert.deepEqual(dropped.rows, []);
});

test("history bridge isolates listener failures and unsubscribes", () => {
  const rows = [];
  const broken = observeCommands(() => { throw Error("plugin failure"); });
  const stop = observeCommands(entry => rows.push(entry.command));
  assert.equal(historyRecording(), true);
  notifyCommand({ sessionId: "a", command: "ls" });
  stop(); broken();
  notifyCommand({ sessionId: "a", command: "pwd" });
  assert.deepEqual(rows, ["ls"]);
  assert.equal(historyRecording(), false);
});

test("background recording serializes saves and clear, ignores serial/ended sessions and stops on disable", async () => {
  const calls = [];
  const abort = new AbortController();
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const controller = createHistoryController({
    signal: abort.signal,
    sessions: () => [{ id: "a", kind: "ssh", profileId: "host-a" }, { id: "serial", kind: "serial" }],
    invoke: async (command, args) => { calls.push([command, args]); if (calls.length === 1) await first; return []; },
    toast: message => { throw Error(message); },
  });
  notifyCommand({ sessionId: "a", command: "ls" });
  notifyCommand({ sessionId: "serial", command: "hardware" });
  notifyCommand({ sessionId: "gone", command: "stale" });
  const clearing = controller.clear();
  notifyCommand({ sessionId: "a", command: "pwd" });
  await settle();
  assert.equal(calls.length, 1);
  release(); await clearing; await settle();
  assert.deepEqual(calls.map(call => call[0]), ["history_add", "history_clear", "history_add"]);
  assert.equal(calls[0][1].hostId, "host-a");
  abort.abort();
  notifyCommand({ sessionId: "a", command: "after disable" });
  await settle(); assert.equal(calls.length, 3);
  await assert.rejects(controller.recent(""), /停用/);
  controller.dispose();
});
