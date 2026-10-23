import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useStore } from "../store";
import { isTauri } from "../env";
import { firstLeaf } from "../paneTree";
import { IconFolder, IconMinus, IconSquare, IconX } from "./icons";

export function TitleBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const sftpOpen = useStore((s) => s.sftpOpen);
  const toggleSftp = useStore((s) => s.toggleSftp);
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
  const activeLeaf = activeTab ? firstLeaf(activeTab.layout) : null;
  const title = activeLeaf && activeLeaf.kind !== "welcome" ? activeLeaf.title : "TermOne";

  return (
    <header className={`titlebar${isMac ? " mac" : ""}`}>
      <div className="titlebar-brand" data-tauri-drag-region>
        <span className="logo">❯1</span>
        <span className="app-name">TermOne</span>
      </div>
      <div className="titlebar-title" data-tauri-drag-region>
        {title}
      </div>
      <div className="titlebar-tools">
        <button
          className={`titlebar-tool${sftpOpen ? " active" : ""}`}
          aria-label="SFTP 文件管理"
          title="SFTP 文件管理"
          onClick={toggleSftp}
        >
          <IconFolder size={15} />
          <span className="titlebar-tool-label">文件</span>
        </button>
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
