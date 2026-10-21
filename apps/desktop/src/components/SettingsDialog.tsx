import { ask, open, save } from "@tauri-apps/plugin-dialog";

import { ipc } from "../ipc";
import { useStore } from "../store";
import { THEME_NAMES } from "../types";
import { Modal } from "./Dialog";

const DEFAULT_FS = 14;
const DEFAULT_SB = 5000;
const BACKUP_FILTER = [{ name: "TermOne 备份", extensions: ["json"] }];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SettingsDialog() {
  const settings = useStore((s) => s.settings);
  const saveSetting = useStore((s) => s.saveSetting);
  const profiles = useStore((s) => s.profiles);
  const setDialog = useStore((s) => s.setDialog);
  const showToast = useStore((s) => s.showToast);
  const reloadAfterImport = useStore((s) => s.reloadAfterImport);

  const handleExport = async () => {
    try {
      const path = await save({
        title: "导出备份",
        defaultPath: `termone-backup-${new Date().toISOString().slice(0, 10)}.json`,
        filters: BACKUP_FILTER,
      });
      if (!path) return;
      const stats = await ipc.backupExport(path);
      showToast(
        `已导出 ${stats.profiles} 个档案、${stats.settings} 项设置（不含密码等机密）`,
        "success",
      );
    } catch (e) {
      showToast(`导出失败: ${errMsg(e)}`, "error");
    }
  };

  const handleImport = async (replace: boolean) => {
    try {
      const path = await open({
        title: "导入备份",
        multiple: false,
        filters: BACKUP_FILTER,
      });
      if (!path || Array.isArray(path)) return;
      if (replace) {
        const ok = await ask("覆盖导入将清空现有档案与设置，并整体恢复为备份内容。确定继续？", {
          title: "覆盖导入",
          kind: "warning",
          okLabel: "覆盖导入",
          cancelLabel: "取消",
        });
        if (!ok) return;
      }
      const stats = await ipc.backupImport(path, replace);
      await reloadAfterImport();
      showToast(
        `已导入 ${stats.profiles} 个档案、${stats.settings} 项设置${replace ? "（覆盖模式）" : "（合并模式）"}`,
        "success",
      );
    } catch (e) {
      showToast(`导入失败: ${errMsg(e)}`, "error");
    }
  };

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
          onChange={(e) => void saveSetting("fontSize", Number(e.target.value) || DEFAULT_FS)}
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

        <span className="form-span section-title">备份与恢复</span>

        <label>导出</label>
        <div className="input-row">
          <button className="btn" onClick={() => void handleExport()}>
            导出备份…
          </button>
          <span className="form-hint">档案 + 设置 → JSON 文件，不含密码等机密</span>
        </div>

        <label>导入</label>
        <div className="input-row">
          <button className="btn" onClick={() => void handleImport(false)}>
            合并导入…
          </button>
          <button className="btn danger" onClick={() => void handleImport(true)}>
            覆盖导入…
          </button>
        </div>

        <span className="form-span">
          <p className="form-hint">
            合并：仅导入比本地更新的数据，保留本地新增；覆盖：清空现有档案与设置后整体恢复。
          </p>
        </span>

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
