import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { ipc } from "../ipc";
import { defaultConfig, defaultProfileName } from "../profile";
import { useStore } from "../store";
import type { ProfileKind, ProfileRow, SerialPortDto } from "../types";
import { Dropdown } from "./Dropdown";
import { Modal } from "./Dialog";
import { IconRefresh } from "./icons";

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

interface Props {
  profileId?: string;
}

export function ProfileDialog({ profileId }: Props) {
  const profiles = useStore((s) => s.profiles);
  const saveProfile = useStore((s) => s.saveProfile);
  const setDialog = useStore((s) => s.setDialog);

  const existing = profileId ? profiles.find((p) => p.id === profileId) : undefined;

  const [kind, setKind] = useState<ProfileKind>(existing?.kind ?? "local");
  const [name, setName] = useState(existing?.name ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(
    existing ? { ...(existing.config as Record<string, unknown>) } : { ...defaultConfig("local") },
  );
  const [serialPorts, setSerialPorts] = useState<SerialPortDto[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (kind === "serial") {
      void refreshPorts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const refreshPorts = async (): Promise<void> => {
    try {
      setSerialPorts(await ipc.serialPorts());
    } catch {
      setSerialPorts([]);
    }
  };

  const patch = (partial: Record<string, unknown>) =>
    setConfig((c) => ({ ...c, ...partial }));

  const pickIdentityFile = async (): Promise<void> => {
    try {
      const path = await open({
        title: "选择 SSH 私钥",
        multiple: false,
        filters: [
          { name: "全部文件", extensions: ["*"] },
          { name: "密钥文件", extensions: ["pem", "key"] },
        ],
      });
      if (!path || Array.isArray(path)) return;
      patch({ identityFile: path });
    } catch {
      // 用户取消或对话框异常，忽略
    }
  };

  const switchKind = (next: ProfileKind) => {
    setKind(next);
    setConfig({ ...defaultConfig(next) });
  };

  const submit = async () => {
    const row: ProfileRow = {
      id: existing?.id ?? crypto.randomUUID(),
      kind,
      name: name.trim() || defaultProfileName(kind, config as never),
      config: config as never,
      sortOrder: existing?.sortOrder ?? 0,
      updatedAt: Date.now(),
      createdAt: existing?.createdAt ?? Date.now(),
      deleted: false,
      dirty: true,
    };
    setSaving(true);
    try {
      await saveProfile(row);
      setDialog(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={existing ? "编辑档案" : "新建档案"} onClose={() => setDialog(null)}>
      <div className="form-grid">
        <label>类型</label>
        <Dropdown
          value={kind}
          options={[
            { value: "local", label: "本地 Shell" },
            { value: "ssh", label: "SSH 远程" },
            { value: "serial", label: "串口 Serial" },
          ]}
          onChange={(v) => switchKind(v as ProfileKind)}
        />

        <label>名称</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={defaultProfileName(kind, config as never)}
          spellCheck={false}
        />

        {kind === "local" && (
          <>
            <label>Shell</label>
            <input
              value={(config.shell as string) ?? ""}
              onChange={(e) => patch({ shell: e.target.value })}
              placeholder="留空使用系统默认（如 powershell / zsh）"
              spellCheck={false}
            />
            <label>启动目录</label>
            <input
              value={(config.cwd as string) ?? ""}
              onChange={(e) => patch({ cwd: e.target.value })}
              placeholder="可选，如 D:\work 或 ~/projects"
              spellCheck={false}
            />
            <label>启动参数</label>
            <input
              value={((config.args as string[]) ?? []).join(" ")}
              onChange={(e) => patch({ args: e.target.value.split(" ").filter(Boolean) })}
              placeholder="可选，空格分隔"
              spellCheck={false}
            />
          </>
        )}

        {kind === "ssh" && (
          <>
            <label>主机</label>
            <input
              value={(config.host as string) ?? ""}
              onChange={(e) => patch({ host: e.target.value })}
              placeholder="example.com 或 IP"
              spellCheck={false}
            />
            <label>端口</label>
            <input
              type="number"
              min={1}
              max={65535}
              value={(config.port as number) ?? 22}
              onChange={(e) => patch({ port: Number(e.target.value) || 22 })}
            />
            <label>用户名</label>
            <input
              value={(config.user as string) ?? ""}
              onChange={(e) => patch({ user: e.target.value })}
              placeholder="root"
              spellCheck={false}
            />
            <label>认证方式</label>
            <Dropdown
              value={(config.auth as string) ?? "password"}
              options={[
                { value: "agent", label: "默认（密钥 / Agent）" },
                { value: "password", label: "密码（连接时在终端输入）" },
                { value: "key", label: "指定密钥文件" },
              ]}
              onChange={(v) => patch({ auth: v })}
            />
            {config.auth === "key" && (
              <>
                <label>私钥路径</label>
                <div className="input-row">
                  <input
                    value={(config.identityFile as string) ?? ""}
                    onChange={(e) => patch({ identityFile: e.target.value })}
                    placeholder="~/.ssh/id_ed25519"
                    spellCheck={false}
                  />
                  <button className="btn" onClick={() => void pickIdentityFile()}>
                    选择…
                  </button>
                </div>
              </>
            )}
            <span className="form-span" />
            <p className="form-hint">
              基于 OpenSSH：known_hosts、ssh-agent 与密钥体系与系统保持一致；首次连接会像 ssh
              命令一样提示确认指纹 / 输入密码。
            </p>
          </>
        )}

        {kind === "serial" && (
          <>
            <label>串口设备</label>
            <div className="input-row">
              <input
                value={(config.path as string) ?? ""}
                onChange={(e) => patch({ path: e.target.value })}
                placeholder="COM3 或 /dev/ttyUSB0"
                spellCheck={false}
              />
              <Dropdown
                className="flex-1"
                value={serialPorts.some((p) => p.name === config.path) ? (config.path as string) : ""}
                placeholder="选择设备…"
                options={serialPorts.map((p) => ({
                  value: p.name,
                  label: p.name,
                  description: p.product,
                }))}
                onChange={(v) => patch({ path: v })}
              />
              <button
                className="icon-btn"
                title="刷新设备列表"
                onClick={() => void refreshPorts()}
              >
                <IconRefresh size={14} />
              </button>
            </div>
            <label>波特率</label>
            <div className="input-row">
              <Dropdown
                className="flex-1"
                value={BAUD_RATES.includes(config.baud as number) ? String(config.baud) : ""}
                placeholder="自定义…"
                options={BAUD_RATES.map((b) => ({ value: String(b), label: String(b) }))}
                onChange={(v) => patch({ baud: Number(v) })}
              />
              <input
                type="number"
                min={300}
                max={4000000}
                value={(config.baud as number) ?? 115200}
                onChange={(e) => patch({ baud: Number(e.target.value) || 115200 })}
              />
            </div>
            <label>数据位</label>
            <Dropdown
              value={String(config.dataBits ?? 8)}
              options={[
                { value: "8", label: "8" },
                { value: "7", label: "7" },
              ]}
              onChange={(v) => patch({ dataBits: Number(v) })}
            />
            <label>校验位</label>
            <Dropdown
              value={(config.parity as string) ?? "none"}
              options={[
                { value: "none", label: "无 None" },
                { value: "even", label: "偶 Even" },
                { value: "odd", label: "奇 Odd" },
              ]}
              onChange={(v) => patch({ parity: v })}
            />
            <label>停止位</label>
            <Dropdown
              value={String(config.stopBits ?? 1)}
              options={[
                { value: "1", label: "1" },
                { value: "2", label: "2" },
              ]}
              onChange={(v) => patch({ stopBits: Number(v) })}
            />
            <label>流控</label>
            <Dropdown
              value={(config.flowControl as string) ?? "none"}
              options={[
                { value: "none", label: "无" },
                { value: "xon", label: "XON/XOFF" },
                { value: "rtscts", label: "RTS/CTS" },
              ]}
              onChange={(v) => patch({ flowControl: v })}
            />
          </>
        )}

        <span className="form-span" />
        <div className="form-actions">
          <button className="btn" onClick={() => setDialog(null)}>
            取消
          </button>
          <button className="btn primary" disabled={saving} onClick={() => void submit()}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
