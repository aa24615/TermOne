import { useStore } from "../store";
import { firstLeaf } from "../paneTree";
import type { ProfileConfig, Tab } from "../types";
import { IconPlus, IconX } from "./icons";

function tabMeta(t: Tab) {
  const leaf = firstLeaf(t.layout);
  return {
    kind: leaf.kind,
    profileId: leaf.profileId,
    title: leaf.title,
    sessionTitle: leaf.sessionTitle,
    exitInfo: leaf.exitInfo,
  };
}

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const profiles = useStore((s) => s.profiles);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const openTerminal = useStore((s) => s.openTerminal);

  // 会话序号：欢迎页不计数，其余按位置从 1 编号
  const tabNumbers = new Map<string, number>();
  let seq = 0;
  for (const t of tabs) {
    if (tabMeta(t).kind !== "welcome") tabNumbers.set(t.id, ++seq);
  }

  return (
    <div className="tabbar">
      <div className="tabs">
        {tabs.map((t) => {
          const m = tabMeta(t);
          const profile = m.profileId ? profiles.find((p) => p.id === m.profileId) : undefined;
          const color = profile ? (profile.config as ProfileConfig).color : undefined;
          return (
          <div
            key={t.id}
            className={`tab${t.id === activeTabId ? " active" : ""}${m.exitInfo ? " ended" : ""}`}
            onClick={() => setActiveTab(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.id);
            }}
            title={m.sessionTitle ?? m.title}
          >
            <span
              className={`tab-dot dot-${m.kind}`}
              style={color ? { background: color } : undefined}
            />
            {tabNumbers.has(t.id) && (
              <span className="tab-index">{tabNumbers.get(t.id)}</span>
            )}
            <span className="tab-title">{m.title}</span>
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
