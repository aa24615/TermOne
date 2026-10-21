import { openUrl } from "@tauri-apps/plugin-opener";

import { CHANGELOG, GITHUB_ISSUES_URL, GITHUB_URL } from "../changelog";
import { useStore } from "../store";
import { Modal } from "./Dialog";
import { IconGlobe } from "./icons";

export function AboutDialog() {
  const appInfo = useStore((s) => s.appInfo);
  const setDialog = useStore((s) => s.setDialog);

  return (
    <Modal title="关于 TermOne" onClose={() => setDialog(null)} width={460}>
      <div className="about">
        <div className="about-hero">
          <div className="about-logo">&gt;_</div>
          <div>
            <div className="about-name">
              TermOne{appInfo ? <span className="about-ver">v{appInfo.version}</span> : null}
            </div>
            <div className="about-desc">轻量、漂亮的跨平台终端</div>
          </div>
        </div>

        <div className="about-links">
          <button className="btn primary" onClick={() => void openUrl(GITHUB_URL)}>
            <IconGlobe size={13} /> GitHub 仓库
          </button>
          <button className="btn" onClick={() => void openUrl(GITHUB_ISSUES_URL)}>
            问题反馈
          </button>
        </div>

        <div className="about-changelog">
          <div className="section-title">版本更新记录</div>
          {CHANGELOG.map((entry) => (
            <div className="cl-entry" key={entry.version}>
              <div className="cl-head">
                <span className="cl-version">v{entry.version}</span>
                {appInfo?.version === entry.version && (
                  <span className="cl-current">当前版本</span>
                )}
                <span className="cl-date">{entry.date}</span>
              </div>
              <ul className="cl-items">
                {entry.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="about-foot">MIT License · 基于 Tauri / React / xterm.js 构建</p>
      </div>
    </Modal>
  );
}
