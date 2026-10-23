/**
 * 运行环境检测。
 *
 * 纯浏览器环境（如 `vite dev` 直接在浏览器里预览 UI）没有 Tauri 注入的
 * IPC 桥，调用 `@tauri-apps/api` 会同步抛错并使 React 整树崩溃。
 * 涉及窗口/进程 API 的副作用应先用 `isTauri()` 守卫。
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
