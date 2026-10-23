import type { Pane, PaneNode } from "./types";

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function newPane(partial: Partial<Pane> = {}): Pane {
  return {
    id: uid("pane"),
    kind: partial.kind ?? "local",
    sessionId: partial.sessionId ?? null,
    sessionTitle: partial.sessionTitle ?? null,
    profileId: partial.profileId ?? null,
    title: partial.title ?? "",
    exitInfo: partial.exitInfo ?? null,
  };
}

export function leafNode(pane: Pane): PaneNode {
  return { type: "leaf", id: pane.id, pane };
}

export function firstLeaf(node: PaneNode): Pane {
  return node.type === "leaf" ? node.pane : firstLeaf(node.children[0]);
}

export function allLeaves(node: PaneNode): Pane[] {
  return node.type === "leaf" ? [node.pane] : node.children.flatMap(allLeaves);
}

export function findPane(node: PaneNode, paneId: string): Pane | null {
  if (node.type === "leaf") return node.pane.id === paneId ? node.pane : null;
  for (const c of node.children) {
    const r = findPane(c, paneId);
    if (r) return r;
  }
  return null;
}

export function findPaneBySession(node: PaneNode, sessionId: string): Pane | null {
  if (node.type === "leaf") {
    return node.pane.sessionId === sessionId ? node.pane : null;
  }
  for (const c of node.children) {
    const r = findPaneBySession(c, sessionId);
    if (r) return r;
  }
  return null;
}

/** 把 leaf 替换为 split（含原 pane + 新 pane）。返回新树。 */
export function splitLeaf(
  node: PaneNode,
  paneId: string,
  dir: "row" | "col",
  newPane: Pane,
): PaneNode {
  if (node.type === "leaf") {
    if (node.pane.id !== paneId) return node;
    return {
      type: "split",
      id: uid("split"),
      dir,
      children: [node, leafNode(newPane)],
      sizes: [1, 1],
    };
  }
  return { ...node, children: node.children.map((c) => splitLeaf(c, paneId, dir, newPane)) };
}

/** 删除 leaf；若父 split 仅剩 1 子，则上提该子节点。无节点返回 null。 */
export function removeLeaf(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === "leaf") return node.pane.id === paneId ? null : node;
  const children = node.children
    .map((c) => removeLeaf(c, paneId))
    .filter((c): c is PaneNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children, sizes: children.map(() => 1) };
}

export function updatePane(node: PaneNode, paneId: string, patch: Partial<Pane>): PaneNode {
  if (node.type === "leaf") {
    if (node.pane.id !== paneId) return node;
    return { ...node, pane: { ...node.pane, ...patch } };
  }
  return { ...node, children: node.children.map((c) => updatePane(c, paneId, patch)) };
}

export function updatePaneBySession(
  node: PaneNode,
  sessionId: string,
  patch: Partial<Pane>,
): PaneNode {
  if (node.type === "leaf") {
    if (node.pane.sessionId !== sessionId) return node;
    return { ...node, pane: { ...node.pane, ...patch } };
  }
  return { ...node, children: node.children.map((c) => updatePaneBySession(c, sessionId, patch)) };
}

export function setSplitSizes(
  node: PaneNode,
  splitId: string,
  sizes: number[],
): PaneNode {
  if (node.type === "split") {
    if (node.id === splitId) return { ...node, sizes };
    return { ...node, children: node.children.map((c) => setSplitSizes(c, splitId, sizes)) };
  }
  return node;
}
