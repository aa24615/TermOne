import { useState, type FormEvent } from "react";

import { useStore } from "../store";
import { Modal } from "./Dialog";

export function AccountDialog() {
  const auth = useStore((s) => s.auth);
  const authLogin = useStore((s) => s.authLogin);
  const setDialog = useStore((s) => s.setDialog);

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (await authLogin(email.trim(), password, mode === "register")) {
        setDialog(null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={mode === "login" ? "登录同步服务" : "注册同步账号"}
      onClose={() => setDialog(null)}
      width={420}
    >
      <form className="form-grid" onSubmit={submit}>
        <label>邮箱</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          spellCheck={false}
          autoComplete="username"
        />

        <label>密码</label>
        <input
          type="password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="至少 6 位"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
        />

        {auth.error && <span className="form-span form-error">{auth.error}</span>}

        <span className="form-span" />

        <span className="form-span form-actions">
          <button type="button" className="btn" onClick={() => setDialog(null)}>
            稍后再说
          </button>
          <button type="button" className="btn" onClick={() => setMode(mode === "login" ? "register" : "login")}>
            {mode === "login" ? "没有账号？注册" : "已有账号？登录"}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并登录"}
          </button>
        </span>

        <span className="form-span">
          <p className="form-hint">
            服务器地址可在「设置」中修改。同步内容为连接档案与界面设置；SSH
            密码、密钥口令等机密仅保存在本机系统密钥环，永远不会上传。
          </p>
        </span>
      </form>
    </Modal>
  );
}
