import { type ReactNode, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../env";
import { applyLockStatus, refreshLock, unlockScreen, useScreenLock, type LockStatus } from "../screenLock";

export function ScreenLock({ children }: { children: ReactNode }) {
  const state = useScreenLock();
  const blocked = !state.ready || state.locked;
  const [hasOpened, setHasOpened] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<LockStatus>("screen-lock:changed", event => {
        if (!disposed) applyLockStatus(event.payload);
      });
      if (disposed) { unlisten(); return; }
      await refreshLock();
    })().catch(e => { if (!disposed) setError(`读取锁屏状态失败：${String(e)}`); });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    if (!blocked) setHasOpened(true);
    document.documentElement.dataset.screenLocked = String(blocked);
    if (content.current) content.current.inert = blocked;
    setPassword("");
    setError("");
    if (blocked) input.current?.focus();
    return () => { delete document.documentElement.dataset.screenLocked; };
  }, [blocked]);

  useEffect(() => {
    if (blocked && state.ready && !busy) input.current?.focus();
  }, [blocked, state.ready, busy]);

  useEffect(() => {
    if (!state.locked || state.retryAfterSeconds <= 0) return;
    const timer = setInterval(() => { void refreshLock().catch(() => {}); }, 1000);
    return () => clearInterval(timer);
  }, [state.locked, state.retryAfterSeconds]);

  return <>
    <div ref={content} className="screen-lock-content" aria-hidden={blocked} style={{ visibility: blocked ? "hidden" : undefined }}>
      {(hasOpened || !blocked) && children}
    </div>
    {blocked && <section className="screen-lock-overlay" aria-label="TermOne 锁屏">
      <div className="screen-lock-drag" data-tauri-drag-region />
      <form className="screen-lock-card" onSubmit={event => {
        event.preventDefault();
        if (busy || !password || state.retryAfterSeconds > 0) return;
        setBusy(true); setError("");
        void unlockScreen(password).catch(async e => {
          setError(String(e)); setPassword("");
          await refreshLock().catch(() => {});
        }).finally(() => { setBusy(false); input.current?.focus(); });
      }}>
        <span className="screen-lock-logo" aria-hidden="true">❯1</span>
        <h1>{state.ready ? "TermOne 已锁定" : "正在读取锁屏设置…"}</h1>
        {state.ready && <>
          <p>输入锁屏密码以继续使用</p>
          <label htmlFor="unlock-password">锁屏密码</label>
          <input ref={input} id="unlock-password" type="password" autoComplete="current-password" maxLength={128}
            value={password} onChange={event => setPassword(event.target.value)} autoFocus disabled={busy}
            placeholder="请输入锁屏密码" />
          <button className="btn primary" type="submit" disabled={busy || !password || state.retryAfterSeconds > 0}>
            {busy ? "正在验证…" : state.retryAfterSeconds > 0 ? `${state.retryAfterSeconds} 秒后重试` : "解锁"}
          </button>
          <p className="form-hint">已有终端会话继续运行</p>
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        {!state.ready && error && <button className="btn" type="button" onClick={() => void refreshLock().then(() => setError("")).catch(e => setError(String(e)))}>重试</button>}
      </form>
    </section>}
  </>;
}
