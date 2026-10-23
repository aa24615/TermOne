import { useState } from "react";

import { api } from "../api";
import { clearLocalCred, credToConnect, getLocalCred, setLocalCred } from "../credStore";
import type { HostInput, SshHostMeta } from "../types";

/** create/edit = 主机 CRUD；temp = 不登记的一次性连接；cred = 为已登记主机补输凭据 */
export type HostDialogKind = "create" | "edit" | "temp" | "cred";

interface Props {
  kind: HostDialogKind;
  /** edit / cred 模式必传 */
  host?: SshHostMeta | null;
  onClose: () => void;
  onSaved: () => void;
  onConnect: (payload: { label: string; connect: Record<string, unknown> }) => void;
}

export function HostDialog({ kind, host, onClose, onSaved, onConnect }: Props) {
  const [name, setName] = useState(host?.name ?? "");
  const [hostAddr, setHostAddr] = useState(host?.host ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [username, setUsername] = useState(host?.username ?? "");
  const [authType, setAuthType] = useState<"password" | "key">(host?.authType ?? "password");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  // 默认**不上传**：凭据只在本机，连的时候临时带过去
  const [saveToServer, setSaveToServer] = useState(
    kind === "edit" ? !!host?.hasCredential : false,
  );
  const [rememberLocal, setRememberLocal] = useState(
    kind === "edit" && host ? !!getLocalCred(host.id) : false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCredOnly = kind === "cred";
  const isTemp = kind === "temp";
  const title = isTemp
    ? "临时连接（不登记、不保存）"
    : isCredOnly
      ? "输入凭据以连接"
      : kind === "edit"
        ? "编辑主机"
        : "新增主机";

  const submit = async () => {
    setError(null);
    if (!hostAddr.trim()) return setError("请填写主机地址");
    if (!username.trim()) return setError("请填写用户名");
    const portNum = Number(port) || 22;
    if (portNum < 1 || portNum > 65535) return setError("端口需在 1–65535 之间");

    const label = `${username.trim()}@${hostAddr.trim()}`;

    // ---- 临时连接：不产生任何主机记录 ----
    if (isTemp) {
      if (!secret) return setError(authType === "key" ? "请粘贴私钥" : "请填写密码");
      const connect: Record<string, unknown> = {
        host: hostAddr.trim(),
        port: portNum,
        username: username.trim(),
        authType,
        ...credToConnect({ authType, secret, passphrase: passphrase || undefined }),
        save: false,
      };
      onConnect({ label, connect });
      onClose();
      return;
    }

    // ---- 为已登记主机补输凭据后连接 ----
    if (isCredOnly && host) {
      if (!secret) return setError(authType === "key" ? "请粘贴私钥" : "请填写密码");
      setBusy(true);
      try {
        if (saveToServer) {
          const patch: HostInput = {
            name: host.name,
            host: host.host,
            port: host.port,
            username: host.username,
            authType,
          };
          if (authType === "key") patch.privateKey = secret;
          else patch.password = secret;
          if (authType === "key" && passphrase) patch.passphrase = passphrase;
          await api.updateHost(host.id, patch);
          onSaved();
          onConnect({ label, connect: { hostId: host.id } });
        } else {
          onConnect({
            label,
            connect: {
              hostId: host.id,
              ...credToConnect({ authType, secret, passphrase: passphrase || undefined }),
            },
          });
        }
        if (rememberLocal) setLocalCred(host.id, { authType, secret, passphrase: passphrase || undefined });
        else clearLocalCred(host.id);
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
      return;
    }

    // ---- 新增 / 编辑主机 ----
    const input: HostInput = {
      name: name.trim() || undefined,
      host: hostAddr.trim(),
      port: portNum,
      username: username.trim(),
      authType,
    };

    if (saveToServer) {
      if (secret) {
        if (authType === "key") input.privateKey = secret;
        else input.password = secret;
        if (authType === "key" && passphrase) input.passphrase = passphrase;
      } else if (kind === "create") {
        return setError(authType === "key" ? "请粘贴私钥" : "请填写密码");
      }
      // 编辑时留空 → 服务端保持原有凭据不变
    } else if (kind === "edit" && host?.hasCredential) {
      // 用户取消勾选 → 明确要求删除服务端已保存的凭据
      input.clearCredential = true;
    }

    setBusy(true);
    try {
      if (kind === "edit" && host) {
        await api.updateHost(host.id, input);
        if (rememberLocal && secret) {
          setLocalCred(host.id, { authType, secret, passphrase: passphrase || undefined });
        } else if (!rememberLocal) {
          clearLocalCred(host.id);
        }
      } else {
        const res = await api.createHost(input);
        if (rememberLocal && secret) {
          setLocalCred(res.id, { authType, secret, passphrase: passphrase || undefined });
        }
      }
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
          <span>{title}</span>
          <button className="btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>

        {isCredOnly ? (
          <p className="cred-target">
            {username}@{hostAddr}:{port}
          </p>
        ) : (
          <>
            {!isTemp && (
              <label className="field">
                <span>名称</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="可留空，默认 user@host"
                />
              </label>
            )}
            <div className="field-row">
              <label className="field grow">
                <span>主机</span>
                <input
                  value={hostAddr}
                  onChange={(e) => setHostAddr(e.target.value)}
                  placeholder="192.168.1.10"
                />
              </label>
              <label className="field narrow">
                <span>端口</span>
                <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
              </label>
            </div>
            <label className="field">
              <span>用户名</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="root"
              />
            </label>
          </>
        )}

        <div className="field">
          <span>认证方式</span>
          <div className="seg">
            <button
              className={authType === "password" ? "on" : ""}
              onClick={() => setAuthType("password")}
            >
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
            {!isCredOnly && <em className="hint"> · 可留空，连接时再输入</em>}
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
              placeholder="SSH 登录密码"
            />
          )}
        </label>

        {authType === "key" && (
          <label className="field">
            <span>私钥口令</span>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="若私钥有口令则填写"
            />
          </label>
        )}

        {!isTemp && (
          <div className="cred-opts">
            <label className="check">
              <input
                type="checkbox"
                checked={saveToServer}
                onChange={(e) => setSaveToServer(e.target.checked)}
              />
              <span>
                <strong>把凭据加密保存到服务端</strong>
                <em>
                  勾选后密码/私钥会上传并以 AES-256-GCM 加密保存，之后任意浏览器都能直连。
                  {kind === "edit" && host?.hasCredential && !saveToServer && (
                    <b className="warn"> 当前已保存，取消勾选会立即删除服务端凭据。</b>
                  )}
                </em>
              </span>
            </label>

            <label className={`check${saveToServer ? " muted" : ""}`}>
              <input
                type="checkbox"
                checked={rememberLocal || saveToServer}
                disabled={saveToServer}
                onChange={(e) => setRememberLocal(e.target.checked)}
              />
              <span>
                <strong>在本机浏览器记住凭据</strong>
                <em>明文存于本机 localStorage，永不上传；换设备或清除浏览器数据即失效。</em>
              </span>
            </label>
          </div>
        )}

        <p className={saveToServer ? "notice" : "notice ok"}>
          {isTemp ? (
            <>临时连接不会登记为主机，凭据仅用于本次连接，服务端与本机都不保存。</>
          ) : saveToServer ? (
            <>
              凭据将上传并以 <strong>AES-256-GCM</strong> 加密保存在服务端，接口永不返回明文。
            </>
          ) : (
            <>
              <strong>凭据不会上传</strong>
              ：服务端只登记主机地址/用户名等元数据；连接时由本机临时提交，用完即弃。
            </>
          )}
        </p>

        {error && <p className="error">{error}</p>}

        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? "处理中…" : isCredOnly || isTemp ? "连接" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
