import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useStore } from "../store";
import { isTauri } from "../env";
import { IconMinus, IconSquare, IconX } from "./icons";

export function TitleBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const [isMac, setIsMac] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    setIsMac(navigator.userAgent.includes("Macintosh"));
  }, []);

  useEffect(() => {
    if (!isTauri()) return; // 浏览器预览环境没有窗口 API
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void win.isMaximized().then(setIsMaximized).catch(() => {});
    void win
      .onResized(() => {
        void win.isMaximized().then(setIsMaximized).catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const title = activeTab && activeTab.kind !== "welcome" ? activeTab.title : "TermOne";

  return (
    <header className={`titlebar${isMac ? " mac" : ""}`}>
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="logo">❯1</span>
        <span className="app-name">TermOne</span>
      </div>
      <div className="titlebar-title" data-tauri-drag-region>
        {title}
      </div>
      {!isMac && (
        <div className="win-controls">
          <button
            className="win-btn"
            aria-label="最小化"
            onClick={() => { if (isTauri()) void getCurrentWindow().minimize(); }}
          >
            <IconMinus size={12} />
          </button>
          <button
            className="win-btn"
            aria-label={isMaximized ? "还原" : "最大化"}
            onClick={() => { if (isTauri()) void getCurrentWindow().toggleMaximize(); }}
          >
            <IconSquare size={10} />
          </button>
          <button
            className="win-btn close"
            aria-label="关闭"
            onClick={() => { if (isTauri()) void getCurrentWindow().close(); }}
          >
            <IconX size={12} />
          </button>
        </div>
      )}
    </header>
  );
}
