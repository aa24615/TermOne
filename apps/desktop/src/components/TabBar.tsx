import { useStore } from "../store";
import type { ProfileConfig } from "../types";
import { IconPlus, IconX } from "./icons";

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const profiles = useStore((s) => s.profiles);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const openTerminal = useStore((s) => s.openTerminal);

  return (
    <div className="tabbar">
      <div className="tabs">
        {tabs.map((t) => {
          const profile = t.profileId ? profiles.find((p) => p.id === t.profileId) : undefined;
          const color = profile ? (profile.config as ProfileConfig).color : undefined;
          return (
          <div
            key={t.id}
            className={`tab${t.id === activeTabId ? " active" : ""}${t.exitInfo ? " ended" : ""}`}
            onClick={() => setActiveTab(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.id);
            }}
            title={t.sessionTitle ?? t.title}
          >
            <span
              className={`tab-dot dot-${t.kind}`}
              style={color ? { background: color } : undefined}
            />
            <span className="tab-title">{t.title}</span>
            <button
              className="tab-close"
              title="关闭"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              <IconX size={11} />
            </button>
          </div>
          );
        })}
      </div>
      <button
        className="icon-btn tab-add"
        title="新建本地终端 (Ctrl+T)"
        onClick={() => void openTerminal(null)}
      >
        <IconPlus size={15} />
      </button>
    </div>
  );
}
