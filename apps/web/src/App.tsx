import { useCallback, useEffect, useState } from "react";

import { api, clearToken, getToken } from "./api";
import { clearAllLocalCreds, clearLocalCred, credToConnect, getLocalCred } from "./credStore";
import { HostDialog, type HostDialogKind } from "./components/HostDialog";
import { Login } from "./components/Login";
import { Terminal, type SshSession } from "./components/Terminal";
import type { SshHostMeta, UserDto } from "./types";

/** 凭据存放位置：服务端加密 / 仅本机浏览器 / 未保存（连接时输入） */
function credBadge(h: SshHostMeta): { text: string; cls: string; title: string } {
  if (h.hasCredential) {
    return { text: "服务端", cls: "badge server", title: "凭据已 AES-256-GCM 加密保存在服务端" };
  }
  if (getLocalCred(h.id)) {
    return { text: "仅本机", cls: "badge local", title: "凭据只记在本机浏览器 localStorage，永不上传" };
  }
  return { text: "未保存", cls: "badge none", title: "未保存凭据，连接时需手动输入" };
}

export function App() {
  const [user, setUser] = useState<UserDto | null>(null);
  const [hosts, setHosts] = useState<SshHostMeta[]>([]);
  const [session, setSession] = useState<SshSession | null>(null);
  const [dialog, setDialog] = useState<{ kind: HostDialogKind; host?: SshHostMeta } | null>(null);
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

  /** 打开主机：优先服务端凭据 → 本机缓存 → 弹窗手动输入（默认路径） */
  const openHost = (h: SshHostMeta) => {
    const label = `${h.username}@${h.host}`;
    if (h.hasCredential) return connect(label, { hostId: h.id });
    const local = getLocalCred(h.id);
    if (local) return connect(label, { hostId: h.id, ...credToConnect(local) });
    setDialog({ kind: "cred", host: h });
  };

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
          {hosts.map((h) => {
            const badge = credBadge(h);
            return (
              <div key={h.id} className="host-item">
                <button
                  className="host-main"
                  onClick={() => openHost(h)}
                  title={`${h.username}@${h.host}:${h.port}`}
                >
                  <span className="host-name">
                    {h.name}
                    <em className={badge.cls} title={badge.title}>
                      {badge.text}
                    </em>
                  </span>
                  <span className="host-sub">
                    {h.username}@{h.host}:{h.port} · {h.authType === "key" ? "私钥" : "密码"}
                  </span>
                </button>
                <span className="host-ops">
                  <button className="btn-ghost" onClick={() => setDialog({ kind: "edit", host: h })}>
                    编辑
                  </button>
                  {badge.text === "仅本机" && (
                    <button
                      className="btn-ghost"
                      title="删除本机浏览器中记住的凭据"
                      onClick={() => {
                        clearLocalCred(h.id);
                        setError(null);
                        setHosts((list) => [...list]);
                      }}
                    >
                      忘掉
                    </button>
                  )}
                  <button
                    className="btn-ghost danger"
                    onClick={async () => {
                      if (!confirm(`删除主机「${h.name}」？`)) return;
                      try {
                        await api.deleteHost(h.id);
                        clearLocalCred(h.id);
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
            );
          })}
        </div>

        <div className="side-foot">
          <span title={user.email}>{user.name || user.email}</span>
          <button
            className="btn-ghost"
            title="删除本机浏览器中所有记住的 SSH 凭据"
            onClick={() => {
              if (!confirm("清除本机浏览器中记住的全部 SSH 凭据？")) return;
              clearAllLocalCreds();
              setHosts((list) => [...list]);
            }}
          >
            清除本机凭据
          </button>
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
            <p>从左侧选择一台主机开始连接，或用「临时连接」不登记、不保存直接连。</p>
            <ul>
              <li>
                <strong>凭据默认不上传</strong>
                ：主机只登记地址/用户名，连接时由本机临时提交，服务端用完即弃
              </li>
              <li>只有你勾选「保存到服务端」时才上传，且以 AES-256-GCM 加密落盘，接口永不返回明文</li>
              <li>主机公钥首次信任（TOFU），指纹变更自动拒绝，防中间人</li>
              <li>仅支持远程 SSH —— 不做本地终端与串口</li>
            </ul>
          </div>
        )}
      </main>

      {dialog && (
        <HostDialog
          kind={dialog.kind}
          host={dialog.host ?? null}
          onClose={() => setDialog(null)}
          onSaved={refreshHosts}
          onConnect={({ label, connect: payload }) => connect(label, payload)}
        />
      )}
    </div>
  );
}
