import { Component, type ReactNode } from "react";
import { usePlugins } from "./runtime";
import { installedKind } from "./kinds";
import { useRegistry } from "./registry";
export class PluginBoundary extends Component<
  { children: ReactNode; stop?: () => void; label?: string },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(e: unknown) {
    return { error: String(e) };
  }
  componentDidCatch() {
    this.props.stop?.();
  }
  render() {
    return this.state.error ? (
      <div role="alert">
        {this.props.label ?? "插件"}出错：{this.state.error}
      </div>
    ) : (
      this.props.children
    );
  }
}
export function ContributionView({ render }: { render?: () => ReactNode }) {
  return <>{render?.()}</>;
}
export function ExtensionContent({
  id,
  label = "插件",
}: {
  id: string;
  label?: string;
}) {
  const active = usePlugins((s) => s.active[id]);
  const error = usePlugins((s) => s.errors[id]);
  const p = usePlugins((s) => s.installed.find((p) => p.id === id));
  const contributions = useRegistry((s) => s.items);
  const Panel = active?.module.default;
  return (
    <>
      <PluginBoundary
        key={id + p?.manifest.version}
        label={label}
        stop={() => active?.host.dispose()}
      >
        {error ? (
          <p role="alert">{error}</p>
        ) : Panel && active ? (
          <Panel host={active.host} />
        ) : (
          <p>正在加载…</p>
        )}
      </PluginBoundary>
      {Object.entries(contributions)
        .filter(([, item]) => item.pluginId === id && item.kind === "panel")
        .map(([key, item]) => (
          <PluginBoundary
            key={key}
            label={label}
            stop={() => active?.host.dispose()}
          >
            <h4>{item.title}</h4>
            <ContributionView render={item.render} />
          </PluginBoundary>
        ))}
    </>
  );
}
export function PluginSurface() {
  const id = usePlugins((s) => s.selected);
  const p = usePlugins((s) => s.installed.find((p) => p.id === id));
  if (!id || !p?.enabled || installedKind(p) !== "plugin") return null;
  return (
    <aside className="plugin-surface" aria-label={p.manifest.name}>
      <header>
        <strong>{p.manifest.name}</strong>
        <button
          className="icon-btn"
          aria-label="关闭插件面板"
          onClick={() => usePlugins.setState({ selected: null })}
        >
          ×
        </button>
      </header>
      <div className="plugin-content">
        <ExtensionContent id={id} />
      </div>
    </aside>
  );
}
