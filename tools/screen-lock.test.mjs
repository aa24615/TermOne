import test from "node:test";
import assert from "node:assert/strict";
import { applyLockStatus, screenIsLocked, useScreenLock } from "../apps/desktop/src/screenLock.ts";
import { executePanelCommand } from "../apps/desktop/src/plugin/commandActions.ts";
import { useStore } from "../apps/desktop/src/store.ts";
import { newPane, leafNode } from "../apps/desktop/src/paneTree.ts";
import { registerCommandSender } from "../apps/desktop/src/plugin/terminalBridge.ts";

test("lock status fails closed until ready and ignores stale cross-window replies", () => {
  const previous = useScreenLock.getState();
  try {
    useScreenLock.setState({ ready: false, locked: false, revision: -1 });
    assert.equal(screenIsLocked(), true);
    applyLockStatus({ enabled: true, locked: true, revision: 2, retryAfterSeconds: 0 });
    applyLockStatus({ enabled: true, locked: false, revision: 1, retryAfterSeconds: 0 });
    assert.equal(screenIsLocked(), true);
    applyLockStatus({ enabled: true, locked: false, revision: 3, retryAfterSeconds: 0 });
    assert.equal(screenIsLocked(), false);
  } finally { useScreenLock.setState(previous); }
});

test("a command waiting for authorization cannot run after locking", async () => {
  const previous = useScreenLock.getState();
  const pane = newPane({ kind: "local", sessionId: "lock-fixture" });
  useStore.setState({ tabs: [{ id: "lock-tab", layout: leafNode(pane) }], activeTabId: "lock-tab", activePaneId: pane.id });
  useScreenLock.setState({ ready: true, locked: false });
  let authorize;
  let sent = 0;
  const cleanup = registerCommandSender(pane.sessionId, async () => { sent++; return true; });
  const host = { signal: new AbortController().signal, authorize: () => new Promise(resolve => { authorize = resolve; }) };
  try {
    const pending = executePanelCommand(host, "echo blocked");
    useScreenLock.setState({ locked: true });
    authorize();
    await assert.rejects(pending, /已锁定/);
    await assert.rejects(executePanelCommand(host, "echo blocked"), /已锁定/);
    assert.equal(sent, 0);
  } finally { cleanup(); useScreenLock.setState(previous); }
});
