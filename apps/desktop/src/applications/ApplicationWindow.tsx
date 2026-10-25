import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useRegistry, matchesShortcut } from "../plugin/registry";
import { CommandsDialog } from "../components/CommandsDialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applicationIdFromLocation, installedKind } from "../plugin/kinds";
import {
  activatePlugin,
  initPlugins,
  stopPlugin,
  usePlugins,
} from "../plugin/runtime";
import {
  ExtensionContent,
  PluginBoundary,
  ContributionView,
} from "../plugin/PluginSurface";
import { Dialogs } from "../components/Dialog";
import { Toasts } from "../components/Toasts";
import { useStore } from "../store";
import { isTauri } from "../env";
import "../plugin/ui.css";

export default function ApplicationWindow() {
  const [id] = useState(applicationIdFromLocation);
  const [error, setError] = useState("");
  const contributions = useRegistry((s) => s.items);
  const dialog = useStore((s) => s.dialog);
  const item = usePlugins((s) => s.installed.find((p) => p.id === id));
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let settingsListener: (() => void) | undefined;
    void (async () => {
      // Applications do not initialize profiles, cloud sync, terminals, or main-window plugins.
      await useStore.getState().loadSettings();
      await initPlugins();
      if (isTauri())
        settingsListener = await listen<string>("settings:changed", (event) => {
          if (["theme", "customTheme"].includes(event.payload))
            void useStore.getState().loadSettings();
        });
      if (disposed) {
        settingsListener?.();
        return;
      }
      const p = usePlugins
        .getState()
        .installed.find((p) => p.id === id && p.enabled);
      if (!p || installedKind(p) !== "app")
        throw new Error("应用未安装、已停用或类型不符");
      if (isTauri())
        unlisten = await getCurrentWindow().onCloseRequested(() =>
          stopPlugin(p.id),
        );
      if (disposed) {
        unlisten?.();
        return;
      }
      await activatePlugin(p.id);
    })().catch((e) => {
      if (!disposed) setError(String(e));
    });
    return () => {
      disposed = true;
      unlisten?.();
      settingsListener?.();
      if (id) stopPlugin(id);
    };
  }, [id]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      for (const item of Object.values(useRegistry.getState().items))
        if (
          item.kind === "command" &&
          item.shortcut &&
          matchesShortcut(event, item.shortcut)
        ) {
          event.preventDefault();
          item.run?.();
          break;
        }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  return (
    <main
      className="application-window"
      aria-label={item?.manifest.name ?? "应用"}
    >
      <header className="application-header">
        <div>
          <h1>{item?.manifest.name ?? "应用"}</h1>
          <p className="muted">{item?.manifest.description}</p>
        </div>
        <button
          className="btn"
          onClick={() => {
            if (isTauri()) void getCurrentWindow().close();
          }}
        >
          关闭窗口
        </button>
      </header>
      <section className="application-content">
        {Object.values(contributions).some((c) => c.kind === "command") && (
          <button
            className="btn"
            onClick={() => useStore.getState().setDialog({ type: "commands" })}
          >
            应用命令
          </button>
        )}
        {Object.entries(contributions)
          .filter(([, c]) => c.kind === "setting")
          .map(([key, item]) => (
            <details key={key}>
              <summary>{item.title}</summary>
              <PluginBoundary
                label="应用"
                stop={() => {
                  if (id) stopPlugin(id);
                }}
              >
                <ContributionView render={item.render} />
              </PluginBoundary>
            </details>
          ))}
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : id && item?.enabled ? (
          <ExtensionContent id={id} label="应用" />
        ) : (
          <p>正在加载应用…</p>
        )}
      </section>
      {dialog?.type === "commands" && <CommandsDialog />}
      <Dialogs />
      <Toasts />
    </main>
  );
}
