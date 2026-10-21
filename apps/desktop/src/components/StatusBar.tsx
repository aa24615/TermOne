import { profileSubtitle } from "../profile";
import { useStore } from "../store";
import type { ProfileRow, Tab } from "../types";

function describeTarget(tab: Tab, profile?: ProfileRow): string {
  if (profile) return `${profile.name} — ${profileSubtitle(profile)}`;
  return tab.sessionTitle ?? tab.title;
}

export function StatusBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const profiles = useStore((s) => s.profiles);
  const auth = useStore((s) => s.auth);
  const appInfo = useStore((s) => s.appInfo);

  const tab = tabs.find((t) => t.id === activeTabId);
  const profile = tab?.profileId ? profiles.find((p) => p.id === tab.profileId) : undefined;
  const target =
    tab && tab.kind !== "welcome" ? describeTarget(tab, profile) : "准备就绪";

  const syncLabel = auth.syncing
    ? "同步中…"
    : auth.token
      ? auth.error
        ? `同步失败：${auth.error}`
        : "云端已连接"
      : "本地模式";

  return (
    <footer className="statusbar">
      <span className={`status-dot${tab?.sessionId ? " ok" : ""}`} />
      <span className="status-target" title={target}>
        {target}
      </span>
      <span className="flex-1" />
      <span className="status-right">
        {syncLabel}
        {appInfo ? ` · v${appInfo.version}` : ""}
      </span>
    </footer>
  );
}
