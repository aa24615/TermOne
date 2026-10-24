import type { PaneNode, ProfileKind, Tab } from "./types";
export type SavedNode =
  | { type: "leaf"; profileId: string | null; kind: ProfileKind | "welcome" }
  | {
      type: "split";
      dir: "row" | "col";
      sizes: number[];
      children: SavedNode[];
    };
export function saveLayouts(tabs: Tab[]): string {
  const save = (node: PaneNode): SavedNode =>
    node.type === "leaf"
      ? { type: "leaf", kind: node.pane.kind, profileId: node.pane.profileId }
      : {
          type: "split",
          dir: node.dir,
          sizes: node.sizes,
          children: node.children.map(save),
        };
  return JSON.stringify({
    version: 1,
    tabs: tabs
      .filter((t) => t.id !== "welcome" || t.layout.type === "split")
      .slice(0, 8)
      .map((t) => save(t.layout)),
  });
}
export function readLayouts(raw: string): SavedNode[] {
  if (raw.length > 65536) throw new Error("布局数据过大");
  const value = JSON.parse(raw);
  let nodes = 0;
  const read = (v: SavedNode, depth: number): SavedNode => {
    if (++nodes > 64 || depth > 12 || !v || typeof v !== "object")
      throw new Error("布局层级或节点过多");
    if (
      v.type === "leaf" &&
      ["local", "ssh", "serial", "welcome"].includes(v.kind) &&
      (v.profileId === null || typeof v.profileId === "string")
    )
      return { type: "leaf", kind: v.kind, profileId: v.profileId };
    if (
      v.type === "split" &&
      (v.dir === "row" || v.dir === "col") &&
      Array.isArray(v.children) &&
      v.children.length >= 2 &&
      v.children.length <= 16 &&
      Array.isArray(v.sizes) &&
      v.sizes.length === v.children.length &&
      v.sizes.every((n) => Number.isFinite(n) && n > 0)
    )
      return {
        type: "split",
        dir: v.dir,
        sizes: v.sizes,
        children: v.children.map((c) => read(c, depth + 1)),
      };
    throw new Error("布局格式无效");
  };
  if (
    value.version !== 1 ||
    !Array.isArray(value.tabs) ||
    value.tabs.length > 8
  )
    throw new Error("布局版本或标签页数量无效");
  return value.tabs.map((v: SavedNode) => read(v, 0));
}
