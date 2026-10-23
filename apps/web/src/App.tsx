import { useCallback, useEffect, useState } from "react";

import { api, clearToken, getToken } from "./api";
import { HostDialog } from "./components/HostDialog";
import { Login } from "./components/Login";
import { Terminal, type SshSession } from "./components/Terminal";
import type { SshHostMeta, UserDto } from "./types";

export function App() {
  const [user, setUser] = useState<UserDto | null>(null);
  const [hosts, setHosts] = useState<SshHostMeta[]>([]);
  const [session, setSession] = useState<SshSession | null>(null);
  const [dialog, setDialog] = useState<
    { kind: "create" } | { kind: "edit"; host: SshHostMeta } | { kind: "temp" } | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const refreshHosts = useCallback(async () => {
    try {
      const res = await api.listHosts();
      setHosts(res.hosts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!getToken()) return;
    void (async () => {
      try {
        const res = await api.me();
        setUser(res.user);
        await refreshHosts();
      } catch {
        clearToken();
      }
    })();
  }, [refreshHosts]);

  const connect = useCallback((label: string, payload: Record<string, unknown>) => {
    setSession({ key: `${label}-${Date.now()}`, label, connect: payload });
  }, []);

  const logout = () => {
    clearToken();
    setUser(null);
    setHosts([]);
    setSession(null);
  };

  if (!user) {
    return <Login onOk={(u) => void (setUser(u), refreshHosts())} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">TermOne Web</div>
        <div className="side-actions">
          <button className="btn-primary" onClick={() => setDialog({ kind: "create" })}>
            新增主机
          </button>
          <button className="btn-ghost" onClick={() => setDialog({ kind: "temp" })}>
            临时连接
          </button>
        </div>

        <div className="host-list">
          {hosts.length === 0 && <p className="empty">暂无主机，点「新增主机」添加</p>}
          {hosts.map((h) => (
            <div key={h.id} className="host-item">
              <button
                className="host-main"
                onClick={() => connect(`${h.username}@${h.host}`, { hostId: h.id })}
                title={`${h.username}@${h.host}:${h.port}`}
              >
                <span className="host-name">{h.name}</span>
                <span className="host-sub">
                  {h.username}@{h.host}:{h.port} · {h.authType === "key" ? "私钥" : "密码"}
                </span>
              </button>
              <span className="host-ops">
                <button className="btn-ghost" onClick={() => setDialog({ kind: "edit", host: h })}>
                  编辑
                </button>
                <button
                  className="btn-ghost danger"
                  onClick={async () => {
                    if (!confirm(`删除主机「${h.name}」？`)) return;
                    try {
                      await api.deleteHost(h.id);
                      await refreshHosts();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                    }
                  }}
                >
                  删除
                </button>
              </span>
            </div>
          ))}
        </div>

        <div className="side-foot">
          <span title={user.email}>{user.name || user.email}</span>
          <button className="btn-ghost" onClick={logout}>
            退出
          </button>
        </div>
      </aside>

      <main className="main">
        {error && <div className="banner">{error}</div>}
        {session ? (
          <Terminal session={session} onExit={() => undefined} />
        ) : (
          <div className="welcome">
            <h2>SSH 远程管理</h2>
            <p>从左侧选择一台主机开始连接，或用「临时连接」不保存凭据直接连。</p>
            <ul>
              <li>凭据以 AES-256-GCM 加密保存在服务端，接口永不返回明文</li>
              <li>主机公钥首次信任（TOFU），指纹变更自动拒绝，防中间人</li>
              <li>仅支持远程 SSH —— 不做本地终端与串口</li>
            </ul>
          </div>
        )}
      </main>

      {dialog && (
        <HostDialog
          editing={dialog.kind === "edit" ? dialog.host : null}
          ephemeral={dialog.kind === "temp"}
          onClose={() => setDialog(null)}
          onSaved={refreshHosts}
          onEphemeral={({ label, connect: payload }) => connect(label, payload)}
        />
      )}
    </div>
  );
}
