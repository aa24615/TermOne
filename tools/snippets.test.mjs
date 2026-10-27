import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { TerminalInputGuard } from "../apps/desktop/src/terminalInputGuard.ts";
import { filterSnippets, snippetCounts, snippetGroupId } from "../apps/desktop/src/plugins/snippetModel.ts";
import { activeCommandTarget, executePanelCommand } from "../apps/desktop/src/plugin/commandActions.ts";
import { registerCommandSender } from "../apps/desktop/src/plugin/terminalBridge.ts";
import { useStore } from "../apps/desktop/src/store.ts";
import { newPane, leafNode } from "../apps/desktop/src/paneTree.ts";

const safe = { risk: "safe", reasons: [], statementCount: 1, multiLine: false };
function guardFixture({ check = async () => safe, confirm = async () => true, filter = false } = {}) {
  const sent = [], errors = [];
  const guard = new TerminalInputGuard({
    check, confirm, visibleLine: () => "$ ", error: text => errors.push(text),
    send: data => { if (typeof filter === "function" ? filter() : filter) return false; sent.push(data); },
    paste: text => guard.input(`\x1b[200~${text}\x1b[201~`),
  });
  return { guard, sent, errors };
}

test("click execution submits once through the input guard, without a routine confirmation", async () => {
  let confirmations = 0;
  const f = guardFixture({ confirm: async () => { confirmations++; return true; } });
  assert.equal(await f.guard.execute("echo ready\n"), true);
  assert.deepEqual(f.sent, ["\x1b[200~echo ready\x1b[201~", "\r"]);
  assert.equal(confirmations, 0);
});

test("cancelled dangerous or multiline commands, filters and partial input cannot auto-submit", async () => {
  for (const risk of ["danger", "caution"]) {
    const f = guardFixture({ check: async () => ({ ...safe, risk }), confirm: async () => false });
    assert.equal(await f.guard.execute("fixture"), false);
    assert.deepEqual(f.sent, []);
  }
  const filtered = guardFixture({ filter: true });
  assert.equal(await filtered.guard.execute("echo filtered"), false);
  assert.equal(await filtered.guard.execute("echo filtered again"), false);
  assert.deepEqual(filtered.errors, []);
  const partial = guardFixture(); partial.guard.input("prefix"); await settle();
  assert.equal(await partial.guard.execute("echo accidental"), false);
  assert.equal(partial.sent.join(""), "prefix");
  assert.match(partial.errors[0], /未提交/);
  const closed = guardFixture(); closed.guard.dispose();
  assert.equal(await closed.guard.execute("echo closed"), false);
  let checked, invalid = false;
  const changing = guardFixture({ check: () => new Promise(resolve => { checked = resolve; }), filter: () => invalid });
  const attempt = changing.guard.execute("echo target-changed");
  invalid = true; checked(safe);
  assert.equal(await attempt, false);
  assert.deepEqual(changing.sent, []);
});

test("tab filters retain empty groups, legacy and orphan commands are ungrouped, search is literal", () => {
  const groups = [{ id: "ops", name: "运维" }, { id: "empty", name: "空分组" }];
  const rows = [{ id: "a", title: "目录", body: "ls -la", groupId: "ops" }, { id: "b", title: "旧命令", body: "echo old" }, { id: "c", title: "孤立", body: "echo orphan", groupId: "deleted" }, { id: "d", title: "隐藏", body: "secret", groupId: "ops", deleted: true }];
  assert.deepEqual(filterSnippets(rows, groups, "ops", "").map(x => x.id), ["a"]);
  assert.deepEqual(filterSnippets(rows, groups, "", "").map(x => x.id), ["b", "c"]);
  assert.equal(filterSnippets(rows, groups, "empty", "").length, 0);
  assert.equal(filterSnippets(rows, groups, "__all__", "ECHO").length, 2);
  assert.equal(filterSnippets(rows, groups, "__all__", "ls.*").length, 0);
  assert.equal(snippetGroupId(rows[2], groups), "");
  assert.deepEqual(Object.fromEntries(snippetCounts(rows, groups)), { __all__: 3, "": 2, ops: 1, empty: 0 });
});

test("panel sends only to the visible active pane and cancels if the target changes during authorization", async () => {
  const a = newPane({ kind: "local", sessionId: "session-a" });
  const b = newPane({ kind: "ssh", sessionId: "session-b" });
  const tabs = [{ id: "a", layout: leafNode(a) }, { id: "b", layout: leafNode(b) }];
  useStore.setState({ tabs, activeTabId: "a", activePaneId: a.id });
  const sent = [];
  const signal = new AbortController().signal;
  const cleanup = registerCommandSender("session-a", async (command, receivedSignal) => { assert.equal(receivedSignal, signal); sent.push(command); return true; });
  const host = { signal, authorize: async () => {} };
  assert.equal(await executePanelCommand(host, "pwd"), true);
  assert.deepEqual(sent, ["pwd"]);
  let authorized;
  const delayed = { ...host, authorize: () => new Promise(resolve => { authorized = resolve; }) };
  const pending = executePanelCommand(delayed, "should not send");
  await assert.rejects(executePanelCommand(host, "duplicate click"), /正在发送/);
  useStore.setState({ activeTabId: "b", activePaneId: b.id });
  authorized();
  await assert.rejects(pending, /已变化/);
  assert.deepEqual(sent, ["pwd"]);
  const ended = { ...b, exitInfo: { code: 0 } };
  assert.equal(activeCommandTarget({ tabs: [{ id: "b", layout: leafNode(ended) }], activeTabId: "b", activePaneId: b.id }), null);
  cleanup();
  useStore.setState({ activeTabId: "a", activePaneId: a.id });
  await assert.rejects(executePanelCommand(host, "closed sender"), /未准备好|已关闭/);
});
