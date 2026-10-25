import catalog from "./catalog.json";
import type { ExtensionKind, Installed } from "./types";
export function kindOf(manifest: { kind?: string }): ExtensionKind {
  return manifest.kind === "app" ? "app" : "plugin";
}
export function installedKind(item: Installed): ExtensionKind {
  return item.source === "builtin"
    ? kindOf(catalog.find((m) => m.id === item.id) ?? item.manifest)
    : kindOf(item.manifest);
}
export function kindName(kind: ExtensionKind) {
  return kind === "app" ? "应用" : "插件";
}
export function applicationIdFromLocation(): string | null {
  return typeof window !== "undefined" && window.location
    ? new URLSearchParams(window.location.search).get("application")
    : null;
}
