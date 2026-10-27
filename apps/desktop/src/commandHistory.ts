export interface SubmittedCommand { sessionId: string; command: string }
export interface HistoryRow { command: string; hostId: string | null; timestamp: number; useCount: number }
const observers = new Set<(entry: SubmittedCommand) => void>();
export const historyRecording = () => observers.size > 0;
export function observeCommands(callback: (entry: SubmittedCommand) => void) {
  observers.add(callback);
  return () => { observers.delete(callback); };
}

/** Only persist input visibly echoed by a normal terminal; never guess a hidden password. */
export function resolveSubmittedCommand(entry: { command: string; prompt: string; uncertain: boolean }, visible: string, alternate: boolean): string | null {
  if (alternate || /(?:password|passphrase|verification code|one.time.*code|密码|口令|验证码)\s*[:：]?\s*$/i.test(entry.prompt)) return null;
  const command = (entry.uncertain
    ? entry.prompt && visible.startsWith(entry.prompt) ? visible.slice(entry.prompt.length) : ""
    : entry.command).replace(/\r\n?/g, "\n").trim();
  if (!command || command.length > 16_384 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command)) return null;
  const tail = command.split("\n").filter(line => line.trim()).at(-1)?.trimEnd();
  if (!tail || !visible.trimEnd().endsWith(tail)) return null;
  // A password without echo leaves the prompt unchanged, even when it ends in the typed characters.
  if (visible === entry.prompt) return null;
  return command;
}
export function notifyCommand(entry: SubmittedCommand) {
  for (const observer of observers) {
    try { observer(entry); } catch { /* Plugin isolation. */ }
  }
}
