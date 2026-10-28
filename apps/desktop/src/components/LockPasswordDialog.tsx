import { useState } from "react";
import { configureLock, useScreenLock } from "../screenLock";
import { useStore } from "../store";
import { isTauri } from "../env";
import { Modal } from "./Dialog";

export type LockPasswordMode = "enable" | "change" | "disable";

export function LockPasswordDialog({ mode, fromSettings }: {
  mode: LockPasswordMode;
  fromSettings?: boolean;
}) {
  const retry = useScreenLock(state => state.retryAfterSeconds);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const disabling = mode === "disable";
  const title = disabling ? "关闭锁屏密码" : mode === "change" ? "修改锁屏密码" : "设置锁屏密码";
  const close = () => useStore.getState().setDialog(fromSettings ? { type: "settings" } : null);
  const save = async () => {
    if (busy) return;
    setError("");
    if (!disabling && (Array.from(password).length < 6 || Array.from(password).length > 128)) {
      setError("锁屏密码需要 6–128 个字符"); return;
    }
    if (!disabling && password !== confirmation) { setError("两次输入的密码不一致"); return; }
    setBusy(true);
    try {
      await configureLock(current, disabling ? null : password);
      close();
      useStore.getState().showToast(disabling ? "已关闭锁屏密码" : mode === "change" ? "锁屏密码已修改" : "锁屏密码已设置并开启", "success");
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  return <Modal title={title} width={440} onClose={() => { if (!busy) close(); }}>
    <form onSubmit={event => { event.preventDefault(); void save(); }} onKeyDown={event => {
      if (event.key === "Escape" && !busy) { event.stopPropagation(); close(); }
    }}>
      <div className="form-grid">
        <p className="form-span form-hint">{disabling ? "验证原密码后关闭锁屏。" : mode === "enable" ? "设置并确认密码，保存成功后开启锁屏。" : "验证原密码后设置新密码。"}</p>
        {mode !== "enable" && <>
          <label htmlFor="lock-current">原密码</label>
          <input id="lock-current" type="password" autoComplete="current-password" maxLength={128}
            value={current} onChange={event => setCurrent(event.target.value)} disabled={busy} autoFocus />
        </>}
        {!disabling && <>
          <label htmlFor="lock-new">{mode === "change" ? "新密码" : "设置密码"}</label>
          <input id="lock-new" type="password" autoComplete="new-password" maxLength={128} placeholder="6–128 个字符"
            value={password} onChange={event => setPassword(event.target.value)} disabled={busy} autoFocus={mode === "enable"} />
          <label htmlFor="lock-confirm">确认密码</label>
          <input id="lock-confirm" type="password" autoComplete="new-password" maxLength={128}
            value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} />
        </>}
        {error && <p className="form-span error" role="alert">{error}{retry > 0 ? "，请等待 30 秒后重试" : ""}</p>}
        <p className="form-span form-hint">密码仅在本机保存加盐校验值，不参与同步和备份。</p>
      </div>
      <div className="form-actions">
        <button type="button" className="btn" disabled={busy} onClick={close}>取消</button>
        <button type="submit" className={`btn ${disabling ? "danger" : "primary"}`} disabled={busy || !isTauri() || (mode !== "enable" && !current)}>
          {busy ? "正在保存…" : disabling ? "验证并关闭" : mode === "change" ? "保存新密码" : "设置密码并开启"}
        </button>
      </div>
    </form>
  </Modal>;
}
