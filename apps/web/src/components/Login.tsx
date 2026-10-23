import { useState } from "react";

import { api } from "../api";
import type { UserDto } from "../types";

export function Login({ onOk }: { onOk: (user: UserDto) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!email.trim()) return setError("请填写邮箱");
    if (password.length < 6) return setError("密码至少 6 位");
    setBusy(true);
    try {
      const res =
        mode === "login"
          ? await api.login(email.trim(), password)
          : await api.register(email.trim(), password, name.trim() || undefined);
      localStorage.setItem("termone.web.token", res.token);
      onOk(res.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>TermOne Web</h1>
        <p className="login-sub">SSH 远程管理 · 仅远程 SSH</p>

        <div className="seg full">
          <button className={mode === "login" ? "on" : ""} onClick={() => setMode("login")}>
            登录
          </button>
          <button className={mode === "register" ? "on" : ""} onClick={() => setMode("register")}>
            注册
          </button>
        </div>

        <label className="field">
          <span>邮箱</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </label>
        {mode === "register" && (
          <label className="field">
            <span>昵称</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="可留空" />
          </label>
        )}
        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button className="btn-primary full" onClick={submit} disabled={busy}>
          {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并登录"}
        </button>
      </div>
    </div>
  );
}
