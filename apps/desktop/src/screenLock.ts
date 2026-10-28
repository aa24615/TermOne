import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./env";

export interface LockStatus {
  enabled: boolean;
  locked: boolean;
  retryAfterSeconds: number;
  revision: number;
}
export const useScreenLock = create<LockStatus & { ready: boolean }>(() => ({
  enabled: false, locked: isTauri(), ready: !isTauri(), retryAfterSeconds: 0, revision: -1,
}));
export function applyLockStatus(status: LockStatus) {
  if (status.revision >= useScreenLock.getState().revision)
    useScreenLock.setState({ ...status, ready: true });
}
export function screenIsLocked() {
  const state = useScreenLock.getState();
  return !state.ready || state.locked;
}
export async function refreshLock() {
  applyLockStatus(await invoke<LockStatus>("screen_lock_status"));
}
export async function lockScreen() {
  applyLockStatus(await invoke<LockStatus>("screen_lock_now"));
}
export async function unlockScreen(password: string) {
  applyLockStatus(await invoke<LockStatus>("screen_lock_unlock", { password }));
}
export async function configureLock(currentPassword: string, newPassword: string | null) {
  applyLockStatus(await invoke<LockStatus>("screen_lock_configure", { currentPassword, newPassword }));
}
