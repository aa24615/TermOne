import { Fragment, useState, type MouseEvent } from "react";

import { ipc } from "../ipc";
import { useStore } from "../store";
import type { PaneNode } from "../types";
import { TerminalView } from "./TerminalView";
import { WelcomePane } from "./WelcomePane";
import { Modal } from "./Dialog";
import { IconInfo, IconSplitH, IconSplitV, IconX } from "./icons";

/** 去除 ANSI 转义序列，便于日志回放阅读。 */
function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function startResize(
  e: MouseEvent,
  node: Extract<PaneNode, { type: "split" }>,
  index: number,
) {
  e.preventDefault();
  const container = (e.currentTarget as HTMLElement).parentElement;
  if (!container) return;
  const horizontal = node.dir === "row";
  const startPos = horizontal ? e.clientX : e.clientY;
  const base = node.sizes.slice();
  const total = base.reduce((a, b) => a + b, 0) || 1;

  const onMove = (ev: globalThis.MouseEvent) => {
    const delta = (horizontal ? ev.clientX : ev.clientY) - startPos;
    const rect = container.getBoundingClientRect();
    const len = horizontal ? rect.width : rect.height;
    if (len <= 0) return;
    const ratioDelta = (delta / len) * total;
    const min = 0.08 * total;
    let a = base[index] + ratioDelta;
    let b = base[index + 1] - ratioDelta;
    a = Math.max(min, a);
    b = Math.max(min, b);
    const next = base.slice();
    next[index] = a;
    next[index + 1] = b;
    useStore.getState().setSplitSizes(node.id, next);
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = "";
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  document.body.style.userSelect = "none";
}

export function PaneView({ node, tabId }: { node: PaneNode; tabId: string }) {
  const activeTabId = useStore((s) => s.activeTabId);
  const activePaneId = useStore((s) => s.activePaneId);
  const setActivePane = useStore((s) => s.setActivePane);
  const splitPane = useStore((s) => s.splitPane);
  const closePane = useStore((s) => s.closePane);
  const openTerminal = useStore((s) => s.openTerminal);
  const [log, setLog] = useState<string | null>(null);

  const openLog = async (sessionId: string) => {
    try {
      const text = await ipc.sessionLogRead(sessionId);
      setLog(stripAnsi(text));
    } catch {
      setLog("(无法读取日志)");
    }
  };

  if (node.type === "split") {
    return (
      <div className={`split ${node.dir === "row" ? "split-row" : "split-col"}`}>
        {node.children.map((c, i) => (
          <Fragment key={c.id}>
            <div className="pane-cell" style={{ flexGrow: node.sizes[i] ?? 1, flexBasis: 0 }}>
              <PaneView node={c} tabId={tabId} />
            </div>
            {i < node.children.length - 1 && (
              <div
                className={`splitter ${node.dir === "row" ? "splitter-v" : "splitter-h"}`}
                onMouseDown={(e) => startResize(e, node, i)}
              />
            )}
          </Fragment>
        ))}
      </div>
    );
  }

  const pane = node.pane;
  const active = activeTabId === tabId && pane.id === activePaneId;
  return (
    <div
      className={`pane${active ? " active" : ""}`}
      onMouseDown={() => setActivePane(pane.id)}
    >
      {pane.kind === "welcome" ? (
        <WelcomePane />
      ) : pane.sessionId ? (
        <TerminalView pane={pane} active={active} />
      ) : (
        <div className="pane-empty">
          <p>空面板</p>
          <div className="pane-empty-actions">
            <button className="btn small" onClick={() => void openTerminal(null)}>
              新建本地终端
            </button>
          </div>
        </div>
      )}

      {pane.exitInfo && (
        <div className="term-end">
          <span>{pane.exitInfo}</span>
          <button className="btn small" onClick={() => closePane(pane.id)}>
            关闭面板
          </button>
        </div>
      )}

      <div className="pane-bar">
        <span className="pane-title" title={pane.sessionTitle ?? pane.title}>
          {pane.title || "空面板"}
        </span>
        <span className="pane-bar-actions">
          {pane.sessionId && (
            <button
              className="icon-btn"
              title="会话日志回放"
              onClick={() => void openLog(pane.sessionId!)}
            >
              <IconInfo size={13} />
            </button>
          )}
          <button
            className="icon-btn"
            title="水平分屏（上下）"
            onClick={() => void splitPane(pane.id, "col")}
          >
            <IconSplitH size={13} />
          </button>
          <button
            className="icon-btn"
            title="垂直分屏（左右）"
            onClick={() => void splitPane(pane.id, "row")}
          >
            <IconSplitV size={13} />
          </button>
          <button className="icon-btn" title="关闭面板" onClick={() => closePane(pane.id)}>
            <IconX size={12} />
          </button>
        </span>
      </div>

      {log !== null && (
        <Modal title={`会话日志 · ${pane.title || pane.sessionId || ""}`} onClose={() => setLog(null)} width={720}>
          <pre className="log-view">{log || "（暂无日志，请先在设置中开启「记录会话日志」）"}</pre>
        </Modal>
      )}
    </div>
  );
}
