import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
import { useStore } from "./store";

export default function App() {
  const init = useStore((s) => s.init);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const closeTab = useStore((s) => s.closeTab);
  const dialog = useStore((s) => s.dialog);
  const confirmClose = useStore((s) => s.settings.confirmClose);
  const [confirmExit, setConfirmExit] = useState(false);
  const closingRef = useRef(false);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const s = useStore.getState();
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        void s.openTerminal(null);
      } else if (k === "w") {
        e.preventDefault();
        if (s.activeTabId) s.closeTab(s.activeTabId);
      } else if (e.key === "Tab") {
        e.preventDefault();
        s.cycleTab(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const openCount = tabs.filter((t) => t.sessionId).length;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (closingRef.current) return;
        if (confirmClose && openCount > 0) {
          event.preventDefault();
          setConfirmExit(true);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [confirmClose, openCount]);

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
                void getCurrentWindow().close();
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
