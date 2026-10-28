import { lockScreen, useScreenLock } from "../screenLock";
import { useStore } from "../store";
import { isTauri } from "../env";

export function LockSettings() {
  const enabled = useScreenLock(state => state.enabled);
  const setDialog = useStore(state => state.setDialog);
  return <>
    <span className="form-span section-title">锁屏密码</span>
    <label htmlFor="lock-enabled">开启锁屏密码</label>
    <input id="lock-enabled" type="checkbox" role="switch" checked={enabled}
      disabled={!isTauri()} onChange={event => setDialog({
        type: "lock-password", mode: event.target.checked ? "enable" : "disable", fromSettings: true,
      })} />
    <span className="form-span form-hint">{enabled
      ? "已开启：可点击右上角锁屏，重新打开软件时也需要密码。"
      : "默认关闭，开启时在独立弹窗中设置密码。"}</span>
    {enabled && <div className="form-span input-row">
      <button className="btn" onClick={() => setDialog({ type: "lock-password", mode: "change", fromSettings: true })}>修改密码…</button>
      <button className="btn" onClick={() => void lockScreen().catch(error => useStore.getState().showToast(String(error), "error"))}>立即锁屏</button>
    </div>}
  </>;
}
