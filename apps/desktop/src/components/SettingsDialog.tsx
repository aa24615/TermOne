import { useStore } from "../store";
import { THEME_NAMES } from "../types";
import { Modal } from "./Dialog";

export function SettingsDialog() {
  const settings = useStore((s) => s.settings);
  const saveSetting = useStore((s) => s.saveSetting);
  const profiles = useStore((s) => s.profiles);
  const setDialog = useStore((s) => s.setDialog);

  return (
    <Modal title="设置" onClose={() => setDialog(null)}>
      <div className="form-grid">
        <label>主题</label>
        <div className="theme-options">
          {Object.entries(THEME_NAMES).map(([id, name]) => (
            <button
              key={id}
              className={`theme-chip${settings.theme === id ? " active" : ""}`}
              data-preview-theme={id}
              onClick={() => void saveSetting("theme", id)}
            >
              {name}
            </button>
          ))}
        </div>

        <label>终端字体</label>
        <input
          value={settings.fontFamily}
          onChange={(e) => void saveSetting("fontFamily", e.target.value)}
          spellCheck={false}
        />

        <label>字号</label>
        <input
          type="number"
          min={8}
          max={32}
          value={settings.fontSize}
          onChange={(e) =>
            void saveSetting("fontSize", Number(e.target.value) || DEFAULT_FS)
          }
        />

        <label>回滚行数</label>
        <input
          type="number"
          min={100}
          max={100000}
          value={settings.scrollback}
          onChange={(e) =>
            void saveSetting("scrollback", Number(e.target.value) || DEFAULT_SB)
          }
        />

        <label>默认档案</label>
        <select
          value={settings.defaultProfileId ?? ""}
          onChange={(e) => void saveSetting("defaultProfileId", e.target.value || null)}
        >
          <option value="">系统默认 Shell</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{p.kind}）
            </option>
          ))}
        </select>

        <span className="form-span section-title">同步</span>

        <label>服务器地址</label>
        <input
          value={settings.serverUrl}
          onChange={(e) => void saveSetting("serverUrl", e.target.value)}
          placeholder="http://127.0.0.1:8787"
          spellCheck={false}
        />

        <label>自动同步</label>
        <input
          type="checkbox"
          checked={settings.autoSync}
          onChange={(e) => void saveSetting("autoSync", e.target.checked)}
        />

        <span className="form-span section-title">窗口</span>

        <label>退出前确认</label>
        <input
          type="checkbox"
          checked={settings.confirmClose}
          onChange={(e) => void saveSetting("confirmClose", e.target.checked)}
        />
      </div>
    </Modal>
  );
}

const DEFAULT_FS = 14;
const DEFAULT_SB = 5000;
