import { Component, type ReactNode } from "react";
import { usePlugins } from "./runtime";
import { useRegistry } from "./registry";
export class PluginBoundary extends Component<
  { children: ReactNode; stop?: () => void },
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
      <div role="alert">插件出错：{this.state.error}</div>
    ) : (
      this.props.children
    );
  }
}
export function ContributionView({ render }: { render?: () => ReactNode }) {
  return <>{render?.()}</>;
}
export function PluginSurface() {
  const id = usePlugins((s) => s.selected);
  const active = usePlugins((s) => (id ? s.active[id] : undefined));
  const error = usePlugins((s) => (id ? s.errors[id] : ""));
  const p = usePlugins((s) => s.installed.find((p) => p.id === id));
  const contributions = useRegistry((s) => s.items);
  if (!id || !p?.enabled) return null;
  const Panel = active?.module.default;
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
        <PluginBoundary
          key={id + p.manifest.version}
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
            <PluginBoundary key={key} stop={() => active?.host.dispose()}>
              <h4>{item.title}</h4>
              <ContributionView render={item.render} />
            </PluginBoundary>
          ))}
      </div>
    </aside>
  );
}
