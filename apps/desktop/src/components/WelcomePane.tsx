import { useStore } from "../store";

export function WelcomePane() {
  const openTerminal = useStore((s) => s.openTerminal);
  const setDialog = useStore((s) => s.setDialog);

  return (
    <div className="welcome">
      <div className="welcome-logo">❯1</div>
      <h1>TermOne</h1>
      <p>轻量、漂亮的跨平台终端</p>
      <div className="welcome-actions">
        <button className="btn primary" onClick={() => void openTerminal(null)}>
          新建本地终端
        </button>
        <button className="btn" onClick={() => setDialog({ type: "profile" })}>
          新建 SSH / 串口档案
        </button>
      </div>
      <div className="welcome-tips">
        <div>
          <kbd>Alt + T</kbd> 新建标签页
        </div>
        <div>
          <kbd>Alt + W</kbd> 关闭标签页
        </div>
        <div>
          <kbd>Ctrl/Cmd + Tab</kbd> 切换标签页
        </div>
      </div>
      <p className="welcome-note">终端内 Ctrl+W（删词）、Ctrl+T 等编辑键由 Shell 正常处理</p>
    </div>
  );
}
