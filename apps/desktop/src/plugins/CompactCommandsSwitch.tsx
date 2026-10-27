import { useState } from "react";

export function useCompactCommands(pluginId: string) {
  const key = `termone.${pluginId}.compact`;
  const [compact, setCompact] = useState(() => {
    try { return localStorage.getItem(key) === "true"; } catch { return false; }
  });
  return [compact, (value: boolean) => {
    setCompact(value);
    try { localStorage.setItem(key, String(value)); } catch { /* Display changes still work without persistent storage. */ }
  }] as const;
}

export function CompactCommandsSwitch({ compact, onChange, label }: { compact: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" className="compact-commands-switch" role="switch" aria-label={`${label}简洁模式`} aria-checked={compact}
    title={compact ? "切换为完整列表" : "切换为仅显示命令"} onClick={() => onChange(!compact)}>
    <span>简洁模式</span><span className="compact-switch-track" aria-hidden="true"><span /></span>
  </button>;
}
