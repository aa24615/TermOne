export interface Snippet { id: string; title: string; body: string; groupId?: string | null; sortOrder: number; updatedAt: number; createdAt: number; deleted: boolean; dirty: boolean }
export interface SnippetGroup { id: string; name: string }
export function snippetGroupId(snippet: Snippet, groups: SnippetGroup[]) {
  return groups.some(group => group.id === snippet.groupId) ? snippet.groupId! : "";
}
export function filterSnippets(rows: Snippet[], groups: SnippetGroup[], group: string, query: string) {
  const text = query.trim().toLocaleLowerCase();
  const known = new Set(groups.map(item => item.id));
  return rows.filter(row => !row.deleted && (group === "__all__" || (row.groupId && known.has(row.groupId) ? row.groupId : "") === group) && (!text || `${row.title}\n${row.body}`.toLocaleLowerCase().includes(text)));
}
export function snippetCounts(rows: Snippet[], groups: SnippetGroup[]) {
  const known = new Set(groups.map(item => item.id));
  const counts = new Map<string, number>([["__all__", 0], ["", 0], ...groups.map(item => [item.id, 0] as [string, number])]);
  for (const row of rows) {
    if (row.deleted) continue;
    const group = row.groupId && known.has(row.groupId) ? row.groupId : "";
    counts.set(group, (counts.get(group) ?? 0) + 1);
    counts.set("__all__", (counts.get("__all__") ?? 0) + 1);
  }
  return counts;
}
