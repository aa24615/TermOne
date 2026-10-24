import { create } from "zustand";
import type { ReactNode } from "react";
export interface Contribution {
  pluginId: string;
  kind: "panel" | "command" | "setting" | "status";
  title: string;
  render?: () => ReactNode;
  run?: () => void;
  shortcut?: string;
}
export const useRegistry = create<{ items: Record<string, Contribution> }>(
  () => ({ items: {} }),
);
export function register(id: string, item: Contribution) {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(id)) throw new Error("贡献点 ID 非法");
  const key = item.pluginId + ":" + id;
  const items = useRegistry.getState().items;
  if (items[key]) throw new Error("贡献点重复: " + id);
  if (
    Object.values(items).filter((i) => i.pluginId === item.pluginId).length >=
    32
  )
    throw new Error("单插件最多注册 32 个贡献点");
  useRegistry.setState({
    items: { ...items, [key]: { ...item, title: item.title.slice(0, 200) } },
  });
  return () =>
    useRegistry.setState((s) => {
      const items = { ...s.items };
      delete items[key];
      return { items };
    });
}
export function matchesShortcut(e: KeyboardEvent, shortcut: string) {
  const parts = shortcut.toLowerCase().split("+");
  let key = parts.pop();
  if (
    !key ||
    (!parts.includes("alt") &&
      !parts.some((p) =>
        ["ctrl", "control", "command", "meta", "commandorcontrol"].includes(p),
      ))
  )
    return false;
  const mac = navigator.userAgent.includes("Macintosh");
  const mod = parts.includes("commandorcontrol");
  const ctrl =
    parts.includes("ctrl") || parts.includes("control") || (mod && !mac);
  const meta =
    parts.includes("command") || parts.includes("meta") || (mod && mac);
  if (key === "backquote") key = "`";
  return (
    e.key.toLowerCase() === key &&
    e.ctrlKey === ctrl &&
    e.metaKey === meta &&
    e.altKey === parts.includes("alt") &&
    e.shiftKey === parts.includes("shift")
  );
}
