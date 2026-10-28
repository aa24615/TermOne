import { allLeaves } from "../paneTree";
import { useStore } from "../store";
import type { Host } from "./types";
import { executeTerminalCommand } from "./terminalBridge";
import { screenIsLocked } from "../screenLock";

export function activeCommandTarget(state: Pick<ReturnType<typeof useStore.getState>, "tabs" | "activeTabId" | "activePaneId">) {
  const tab = state.tabs.find(tab => tab.id === state.activeTabId);
  const panes = tab ? allLeaves(tab.layout) : [];
  const pane = panes.find(pane => pane.id === state.activePaneId) ?? panes[0];
  return pane?.sessionId && !pane.exitInfo && ["local", "ssh"].includes(pane.kind) ? pane : null;
}
const sending = new Set<string>();
export async function executePanelCommand(host: Host, command: string) {
  if (screenIsLocked()) throw new Error("TermOne 已锁定，请先解锁");
  const target = activeCommandTarget(useStore.getState());
  if (!target?.sessionId) throw new Error("请先选中一个活动的本地或 SSH 终端");
  if (sending.has(target.sessionId)) throw new Error("该终端正在发送命令，请稍后重试");
  sending.add(target.sessionId);
  try {
    await host.authorize({ type: "session-write" }, "command.execute");
    if (host.signal.aborted) return false;
    if (screenIsLocked()) throw new Error("TermOne 已锁定，命令未发送");
    if (activeCommandTarget(useStore.getState())?.sessionId !== target.sessionId)
      throw new Error("活动终端已变化，请重新点击命令");
    return await executeTerminalCommand(target.sessionId, command, host.signal);
  } finally { sending.delete(target.sessionId); }
}
