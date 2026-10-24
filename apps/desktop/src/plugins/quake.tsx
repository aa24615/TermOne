import { useState } from "react";
import type { Dispose, Host } from "../plugin/types";
import { report } from "./shared";
const state = new WeakMap<Host, { shortcut: string; dispose: Dispose }>();
export async function activate(host: Host) {
  const shortcut =
    (await host.storage.get<string>("shortcut")) ??
    "CommandOrControl+Backquote";
  const dispose = await host.globalShortcut(shortcut);
  state.set(host, { shortcut, dispose });
  return () => {
    dispose();
    state.delete(host);
  };
}
export default function Quake({ host }: { host: Host }) {
  const [shortcut, setShortcut] = useState(
    state.get(host)?.shortcut ?? "CommandOrControl+Backquote",
  );
  return (
    <div className="plugin-stack">
      <p>
        全局热键可在其他应用前台时呼出窗口；TermOne
        已在前台时隐藏。停用或卸载插件后会注销热键。
      </p>
      <label>
        快捷键
        <input value={shortcut} onChange={(e) => setShortcut(e.target.value)} />
      </label>
      <p className="muted">
        例如 CommandOrControl+Backquote 或 Alt+Shift+T；部分 Linux Wayland
        桌面会限制全局快捷键。
      </p>
      <button
        className="btn"
        onClick={() =>
          report(host, async () => {
            state.get(host)?.dispose();
            const dispose = await host.globalShortcut(shortcut);
            await host.storage.set("shortcut", shortcut);
            state.set(host, { shortcut, dispose });
            host.toast("快捷键已注册");
          })
        }
      >
        注册并保存
      </button>
    </div>
  );
}
