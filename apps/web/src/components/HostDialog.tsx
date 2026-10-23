import { useState } from "react";

import { api } from "../api";
import type { HostInput, SshHostMeta } from "../types";

interface Props {
  /** 传入即编辑模式；凭据留空表示保持不变 */
  editing: SshHostMeta | null;
  /** true = 临时连接：凭据不保存到服务端，仅用于本次会话 */
  ephemeral?: boolean;
  onClose: () => void;
  onSaved: () => void;
  onEphemeral?: (payload: { label: string; connect: Record<string, unknown> }) => void;
}

export function HostDialog({ editing, ephemeral, onClose, onSaved, onEphemeral }: Props) {
  const [name, setName] = useState(editing?.name ?? "");
  const [host, setHost] = useState(editing?.host ?? "");
  const [port, setPort] = useState(String(editing?.port ?? 22));
  const [username, setUsername] = useState(editing?.username ?? "");
  const [authType, setAuthType] = useState<"password" | "key">(editing?.authType ?? "password");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!host.trim()) return setError("请填写主机地址");
    if (!username.trim()) return setError("请填写用户名");
    const portNum = Number(port) || 22;
    if (portNum < 1 || portNum > 65535) return setError("端口需在 1–65535 之间");

    const input: HostInput = {
      name: name.trim() || undefined,
      host: host.trim(),
      port: portNum,
      username: username.trim(),
      authType,
    };
    if (secret) {
      if (authType === "key") input.privateKey = secret;
      else input.password = secret;
    } else if (!editing) {
      return setError(authType === "key" ? "请粘贴私钥" : "请填写密码");
    }
    if (authType === "key" && passphrase) input.passphrase = passphrase;

    // 临时连接：凭据只经 WebSocket 传给服务端用于本次连接，不落盘
    if (ephemeral) {
      const connect: Record<string, unknown> = {
        host: input.host,
        port: input.port,
        username: input.username,
        authType: input.authType,
        save: false,
      };
      if (authType === "key") connect.privateKey = secret;
      else connect.password = secret;
      if (authType === "key" && passphrase) connect.passphrase = passphrase;
      onEphemeral?.({ label: `${input.username}@${input.host}`, connect });
      onClose();
      return;
    }

    setBusy(true);
    try {
      if (editing) await api.updateHost(editing.id, input);
      else await api.createHost(input);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{ephemeral ? "临时连接（不保存）" : editing ? "编辑主机" : "新增主机"}</span>
          <button className="btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        <label className="field">
          <span>名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="可留空，默认 user@host" />
        </label>
        <div className="field-row">
          <label className="field grow">
            <span>主机</span>
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" />
          </label>
          <label className="field narrow">
            <span>端口</span>
            <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
          </label>
        </div>
        <label className="field">
          <span>用户名</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
        </label>

        <div className="field">
          <span>认证方式</span>
          <div className="seg">
            <button className={authType === "password" ? "on" : ""} onClick={() => setAuthType("password")}>
              密码
            </button>
            <button className={authType === "key" ? "on" : ""} onClick={() => setAuthType("key")}>
              私钥
            </button>
          </div>
        </div>

        <label className="field">
          <span>
            {authType === "key" ? "私钥（PEM）" : "密码"}
            {editing && <em className="hint"> · 留空则保持原有凭据不变</em>}
          </span>
          {authType === "key" ? (
            <textarea
              rows={5}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            />
          ) : (
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={editing ? "保持不变" : "SSH 登录密码"}
            />
          )}
        </label>

        {authType === "key" && (
          <label className="field">
            <span>
              私钥口令
              {editing && <em className="hint"> · 可留空</em>}
            </span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="若私钥有口令则填写"
            />
          </label>
        )}

        <p className="notice">
          凭据将以 <strong>AES-256-GCM</strong> 加密后保存在服务端，用于建立 SSH 连接；
          服务端接口永不返回明文。若不希望保存，请用顶部「临时连接」。
        </p>

        {error && <p className="error">{error}</p>}

        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
