import { useState } from "react";
import { configureLock, lockScreen, useScreenLock } from "../screenLock";
import { useStore } from "../store";
import { isTauri } from "../env";

export function LockSettings() {
  const enabled = useScreenLock(state => state.enabled);
  const retry = useScreenLock(state => state.retryAfterSeconds);
  const [mode, setMode] = useState<"idle" | "enable" | "change" | "disable">("idle");
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (disable = false) => {
    if (busy) return;
    setError("");
    if (!disable && (Array.from(password).length < 6 || Array.from(password).length > 128)) { setError("锁屏密码需要 6–128 个字符"); return; }
    if (!disable && password !== confirmation) { setError("两次输入的密码不一致"); return; }
    setBusy(true);
    try {
      await configureLock(current, disable ? null : password);
      setCurrent(""); setPassword(""); setConfirmation("");
      setMode("idle");
      useStore.getState().showToast(disable ? "已关闭锁屏密码" : enabled ? "锁屏密码已修改" : "锁屏密码已设置", "success");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <>
    <span className="form-span section-title">锁屏密码</span>
    <label htmlFor="lock-enabled">开启锁屏密码</label>
    <input id="lock-enabled" type="checkbox" role="switch" checked={mode === "enable" || (enabled && mode !== "disable")}
      disabled={busy || !isTauri()} onChange={e => {
        setMode(e.target.checked ? enabled ? "idle" : "enable" : enabled ? "disable" : "idle");
        setCurrent(""); setPassword(""); setConfirmation(""); setError("");
      }} />
    <span className="form-span form-hint">{enabled ? mode === "disable" ? "验证原密码后才会关闭锁屏密码。" : "已开启：可点击右上角锁屏，重新打开软件时也需要密码。" : mode === "enable" ? "请设置并确认密码，保存成功后开启。" : "默认关闭，开启时再设置密码。"}</span>
    {mode !== "idle" && enabled && <>
      <label htmlFor="lock-current">原密码</label>
      <input id="lock-current" type="password" autoComplete="current-password" maxLength={128} value={current} onChange={e => setCurrent(e.target.value)} disabled={busy} />
    </>}
    {(mode === "enable" || mode === "change") && <>
    <label htmlFor="lock-new">{enabled ? "新密码" : "设置密码"}</label>
    <input id="lock-new" type="password" autoComplete="new-password" maxLength={128} placeholder="6–128 个字符" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} />
    <label htmlFor="lock-confirm">确认密码</label>
    <input id="lock-confirm" type="password" autoComplete="new-password" maxLength={128} value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy} />
    </>}
    <div className="form-span input-row">
      {(mode === "enable" || mode === "change") && <button className="btn primary" disabled={busy || !isTauri()} onClick={() => void save()}>{busy ? "正在保存…" : enabled ? "保存新密码" : "设置密码并开启"}</button>}
      {mode === "disable" && <button className="btn danger" disabled={busy || !current} onClick={() => void save(true)}>验证并关闭</button>}
      {mode !== "idle" && <button className="btn" disabled={busy} onClick={() => { setMode("idle"); setCurrent(""); setPassword(""); setConfirmation(""); setError(""); }}>取消</button>}
      {enabled && mode === "idle" && <>
        <button className="btn" onClick={() => setMode("change")}>修改密码</button>
        <button className="btn" disabled={busy} onClick={() => void lockScreen().catch(e => setError(String(e)))}>立即锁屏</button>
      </>}
    </div>
    {error && <p className="form-span error" role="alert">{error}{retry > 0 ? "，请等待 30 秒后重试" : ""}</p>}
    <span className="form-span form-hint">密码仅在本机保存加盐校验值，不参与同步和备份。锁屏期间会话继续运行。</span>
  </>;
}
