import { ask, open, save } from "@tauri-apps/plugin-dialog";

import { ipc } from "../ipc";
import { useStore } from "../store";
import { THEME_NAMES } from "../types";
import { Modal } from "./Dialog";
import { Dropdown } from "./Dropdown";

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
  const enableE2ee = useStore((s) => s.enableE2ee);
  const disableE2ee = useStore((s) => s.disableE2ee);

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
        <Dropdown
          value={settings.defaultProfileId ?? ""}
          placeholder="系统默认 Shell"
          options={profiles.map((p) => ({
            value: p.id,
            label: `${p.name}（${p.kind}）`,
          }))}
          onChange={(v) => void saveSetting("defaultProfileId", v || null)}
        />

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

        <span className="form-span">
          <p className="form-hint">
            <strong>密钥永不上传</strong>
            ：密码与私钥只保存在本机系统钥匙串（Windows 凭据管理器 / macOS 钥匙串 / Secret
            Service），从不进入档案配置，因此同步到云端的只有连接地址等非敏感信息。
          </p>
        </span>

        <span className="form-span section-title">端到端加密（E2EE）</span>

        <label>启用加密</label>
        <input
          type="checkbox"
          checked={settings.e2eeEnabled}
          onChange={(e) => {
            if (e.target.checked) {
              const pass = window.prompt("设置同步加密口令（仅存于内存，服务端零知识）");
              if (pass) enableE2ee(pass);
            } else {
              disableE2ee();
            }
          }}
        />

        {settings.e2eeEnabled && (
          <>
            <label>解锁口令</label>
            <div className="input-row">
              <input
                type="password"
                placeholder="重新输入口令以解密"
                onBlur={(e) => {
                  if (e.target.value) {
                    enableE2ee(e.target.value);
                    e.target.value = "";
                  }
                }}
              />
              <span className="form-hint">重启后需重新输入</span>
            </div>
          </>
        )}
        <span className="form-span">
          <p className="form-hint">
            开启后同步数据在本地加密，服务端仅存储密文、无法读取内容；口令不落盘，更换设备需用同一口令解密。
          </p>
        </span>

        <span className="form-span section-title">窗口</span>

        <label>退出前确认</label>
        <input
          type="checkbox"
          checked={settings.confirmClose}
          onChange={(e) => void saveSetting("confirmClose", e.target.checked)}
        />

        <label>记录会话日志</label>
        <input
          type="checkbox"
          checked={settings.logSessions}
          onChange={(e) => void saveSetting("logSessions", e.target.checked)}
        />
        <span className="form-span">
          <p className="form-hint">
            开启后，会话输出会写入本地日志文件，可在面板工具条点击「日志」回放查看。
          </p>
        </span>
      </div>
    </Modal>
  );
}
