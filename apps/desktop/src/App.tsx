import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { AboutDialog } from "./components/AboutDialog";
import { AccountDialog } from "./components/AccountDialog";
import { Modal } from "./components/Dialog";
import { ProfileDialog } from "./components/ProfileDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { TerminalView } from "./components/TerminalView";
import { Toasts } from "./components/Toasts";
import { TitleBar } from "./components/TitleBar";
import { WelcomePane } from "./components/WelcomePane";
import { isTauri } from "./env";
import { useStore } from "./store";

export default function App() {
  const init = useStore((s) => s.init);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const closeTab = useStore((s) => s.closeTab);
  const dialog = useStore((s) => s.dialog);
  const [confirmExit, setConfirmExit] = useState(false);
  const closingRef = useRef(false);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const alt = e.altKey && !mod;
      const k = e.key.toLowerCase();

      // Alt 组合键：终端聚焦时也可用；
      // stopPropagation 阻止 xterm 把它作为 ESC 序列发给 Shell
      if (alt && (k === "t" || k === "w")) {
        e.preventDefault();
        e.stopPropagation();
        if (k === "t") void s.openTerminal(null);
        else if (s.activeTabId) s.closeTab(s.activeTabId);
        return;
      }

      // Ctrl/Cmd+Tab 切换标签页（不是 Shell 编辑键，全局可用）
      if (mod && e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        s.cycleTab(e.shiftKey ? -1 : 1);
        return;
      }

      if (!mod) return;
      // 终端聚焦时，Ctrl+W（删除前一个词）、Ctrl+T（交换字符）等是 Shell
      // 的编辑键，必须交还 Shell 处理；输入框聚焦时同样放行，避免误关标签页
      const target = e.target as HTMLElement | null;
      if (target?.closest(".term-host, input, textarea, select")) return;

      if (k === "t") {
        e.preventDefault();
        e.stopPropagation();
        void s.openTerminal(null);
      } else if (k === "w") {
        e.preventDefault();
        e.stopPropagation();
        if (s.activeTabId) s.closeTab(s.activeTabId);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const openCount = tabs.filter((t) => t.sessionId).length;

  // 只订阅一次关闭请求，避免频繁重订阅导致监听器泄漏（泄漏的旧监听器会
  // 用过期状态重复 preventDefault，使退出流程卡死）
  useEffect(() => {
    if (!isTauri()) return; // 浏览器预览环境没有窗口 API
    let cancelled = false;
    let un: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (closingRef.current) return;
        const st = useStore.getState();
        const hasRunning = st.tabs.some((t) => t.sessionId);
        if (st.settings.confirmClose && hasRunning) {
          event.preventDefault();
          setConfirmExit(true);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else un = fn;
      });
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  return (
    <div className="app">
      <TitleBar />
      <div className="app-body">
        <Sidebar />
        <main className="main">
          <TabBar />
          <div className="term-stack">
            {tabs.map((t) => (
              <div key={t.id} className={`term-page${t.id === activeTabId ? " active" : ""}`}>
                {t.kind === "welcome" ? (
                  <WelcomePane />
                ) : (
                  <>
                    <TerminalView tab={t} active={t.id === activeTabId} />
                    {t.exitInfo && (
                      <div className="term-end">
                        <span>{t.exitInfo}</span>
                        <button className="btn small" onClick={() => closeTab(t.id)}>
                          关闭标签页
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <StatusBar />
        </main>
      </div>

      {dialog?.type === "profile" && <ProfileDialog profileId={dialog.profileId} />}
      {dialog?.type === "settings" && <SettingsDialog />}
      {dialog?.type === "account" && <AccountDialog />}
      {dialog?.type === "about" && <AboutDialog />}

      {confirmExit && (
        <Modal title="退出 TermOne" onClose={() => setConfirmExit(false)} width={380}>
          <p className="confirm-text">还有 {openCount} 个会话正在运行，退出将关闭它们。确定退出吗？</p>
          <div className="form-actions">
            <button className="btn" onClick={() => setConfirmExit(false)}>
              取消
            </button>
            <button
              className="btn danger"
              onClick={() => {
                closingRef.current = true;
                const win = getCurrentWindow();
                void win.close().catch(() => {});
                // 兜底：close 流程若被挂起，1.2s 后直接销毁窗口
                setTimeout(() => {
                  void win.destroy().catch(() => {});
                }, 1200);
              }}
            >
              退出
            </button>
          </div>
        </Modal>
      )}

      <Toasts />
    </div>
  );
}
