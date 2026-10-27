export type CommandRisk = "safe" | "caution" | "danger";
export interface CommandCheck {
  statementCount: number;
  multiLine: boolean;
  risk: CommandRisk;
  reasons: string[];
}
export const RISK_REASONS: Record<string, string> = {
  editedInput: "历史记录、补全或终端编辑改变了输入，请核对终端中的完整命令",
  multiLinePaste: "多行内容可能连续执行多条命令",
  recursiveDelete: "递归删除文件或目录",
  formatFilesystem: "格式化或修改磁盘分区",
  diskOverwrite: "直接写入磁盘或文件",
  forkBomb: "可能耗尽系统进程资源",
  deviceRedirect: "向设备文件重定向写入",
  powerControl: "关闭或重启系统",
  pipeToShell: "下载内容后直接交给 Shell 执行",
  forceGit: "可能丢弃 Git 修改或覆盖远端历史",
  zeroPerms: "批量修改或清除文件权限",
};
const MAX_INPUT = 1024 * 1024;
const MAX_LINE = 16 * 1024;
const stripPaste = (s: string) => s.replace(/\x1b\[20[01]~/g, "");

/** Guards user text only. Protocol bytes and terminal response sequences stay untouched. */
export class TerminalInputGuard {
  private line = "";
  private cursor = 0;
  private unknown = false;
  private approved: string | null = null;
  private pending = false;
  private disposed = false;
  private pasting = false;
  private historyPrompt: string | null = null;
  private controller = new AbortController();
  constructor(
    private options: {
      check(input: string): Promise<CommandCheck>;
      confirm(
        check: CommandCheck,
        text: string,
        signal: AbortSignal,
      ): Promise<boolean>;
      send(data: string): void | boolean;
      paste(text: string): void;
      visibleLine(): string;
      error(message: string): void;
      focus?(): void;
      historyEnabled?(): boolean;
      submitted?(entry: { command: string; prompt: string; uncertain: boolean }): void;
    },
  ) {}

  input(data: string) {
    if (this.disposed) return;
    this.capturePrompt();
    if (this.pasting) {
      this.forward(data, stripPaste(data), data.startsWith("\x1b[200~"));
      return;
    }
    if (this.pending) return;
    const plain = stripPaste(data);
    // Keyboard/IME events remain synchronous; only submission and bulk text need IPC.
    const bulk =
      data.startsWith("\x1b[200~") ||
      (!data.startsWith("\x1b") &&
        Array.from(plain).length > 1 &&
        !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(plain));
    if (/[\r\n]/.test(plain) || bulk) {
      if (
        /^[\r\n]$/.test(plain) &&
        !this.unknown &&
        this.approved === this.line
      ) {
        this.forward(data, plain);
        return;
      }
      void this.checked(data, plain, false);
    } else {
      this.forward(data, plain);
    }
  }

  paste(text: string) {
    if (this.disposed || this.pending) return;
    this.capturePrompt();
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
      this.options.error("粘贴包含终端控制字符，请改用纯文本");
      return;
    }
    void this.checked(text, text, true);
  }

  private async checked(data: string, plain: string, clipboard: boolean) {
    this.pending = true;
    try {
      if (new TextEncoder().encode(plain).byteLength > MAX_INPUT)
        throw new Error("一次粘贴最多支持 1 MiB 文本");
      const prefix = this.unknown ? this.options.visibleLine() : this.line;
      const candidate = /^[\r\n]$/.test(plain)
        ? prefix + plain
        : prefix.slice(0, this.unknown ? prefix.length : this.cursor) +
          plain +
          (this.unknown ? "" : prefix.slice(this.cursor));
      let result = await this.options.check(candidate.replace(/\r\n?/g, "\n"));
      if (this.disposed) return;
      if (this.unknown)
        result = {
          ...result,
          risk: result.risk === "safe" ? "caution" : result.risk,
          reasons: [...result.reasons, "editedInput"],
        };
      if (
        result.risk !== "safe" &&
        !(await this.options.confirm(result, candidate, this.controller.signal))
      )
        return;
      if (this.disposed) return;
      if (clipboard) {
        // xterm preserves the peer's bracketed-paste mode and does not add Enter.
        this.pasting = true;
        try {
          this.options.paste(data);
        } finally {
          this.pasting = false;
        }
      } else {
        this.forward(data, plain);
      }
      if (!this.unknown) this.approved = this.line;
    } catch (e) {
      if (!this.disposed) this.options.error("输入未发送：" + String(e));
    } finally {
      this.pending = false;
      if (!this.disposed) this.options.focus?.();
    }
  }

  private capturePrompt() {
    if (this.historyPrompt === null && !this.line && !this.unknown && this.options.historyEnabled?.())
      this.historyPrompt = this.options.visibleLine();
  }

  private forward(data: string, plain: string, bracketedPaste = false) {
    const submitted: { command: string; prompt: string; uncertain: boolean }[] = [];
    this.track(plain, submitted, bracketedPaste);
    if (this.options.send(data) !== false) {
      for (const entry of submitted) {
        try { this.options.submitted?.(entry); } catch { /* History must never interrupt input. */ }
      }
    }
  }

  private track(data: string, submitted: { command: string; prompt: string; uncertain: boolean }[], bracketedPaste: boolean) {
    this.approved = null;
    if (data.startsWith("\x1b")) {
      if (data === "\x1b[D" || data === "\x1bOD")
        this.cursor = Math.max(0, this.cursor - 1);
      else if (data === "\x1b[C" || data === "\x1bOC")
        this.cursor = Math.min(this.line.length, this.cursor + 1);
      else if (["\x1b[H", "\x1bOH", "\x1b[1~"].includes(data)) this.cursor = 0;
      else if (["\x1b[F", "\x1bOF", "\x1b[4~"].includes(data))
        this.cursor = this.line.length;
      else if (data === "\x1b[3~")
        this.line =
          this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
      else if (
        /^\x1b(?:\[[AB]|O[AB])$/.test(data) ||
        data === "\x1bb" ||
        data === "\x1bf"
      )
        this.unknown = true;
      return;
    }
    for (const ch of data) {
      if (ch === "\r" || ch === "\n" || ch === "\x03" || ch === "\x04") {
        const continuation = ch === "\r" || ch === "\n";
        if (continuation && bracketedPaste) {
          this.line = this.line.slice(0, this.cursor) + "\n" + this.line.slice(this.cursor);
          this.cursor++;
          continue;
        }
        const slashes = this.line.match(/\\+$/)?.[0].length ?? 0;
        if (continuation && slashes % 2 === 1) {
          this.line = this.line.slice(0, -1);
          this.cursor = this.line.length;
        } else {
          let quote = "";
          let escaped = false;
          for (const c of this.line) {
            if (escaped) {
              escaped = false;
              continue;
            }
            if (c === "\\" && quote !== "'") {
              escaped = true;
              continue;
            }
            if (c === quote) quote = "";
            else if (!quote && (c === "'" || c === '"' || c === "`")) quote = c;
          }
          if (continuation && quote) {
            this.line += "\n";
            this.cursor = this.line.length;
          } else {
            if (continuation && this.historyPrompt !== null && this.options.historyEnabled?.())
              submitted.push({ command: this.line, prompt: this.historyPrompt, uncertain: this.unknown });
            this.line = "";
            this.cursor = 0;
            this.unknown = false;
            this.historyPrompt = null;
          }
        }
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.cursor) {
          this.line =
            this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
          this.cursor--;
        }
      } else if (ch === "\x01") this.cursor = 0;
      else if (ch === "\x05") this.cursor = this.line.length;
      else if (ch === "\x15") {
        this.line = this.line.slice(this.cursor);
        this.cursor = 0;
      } else if (ch === "\x0b") this.line = this.line.slice(0, this.cursor);
      else if (ch === "\x17") {
        const before = this.line
          .slice(0, this.cursor)
          .replace(/\s*\S+\s*$/, "");
        this.line = before + this.line.slice(this.cursor);
        this.cursor = before.length;
      } else if (ch === "\t" || ch.charCodeAt(0) < 32) this.unknown = true;
      else {
        this.line =
          this.line.slice(0, this.cursor) + ch + this.line.slice(this.cursor);
        this.cursor += ch.length;
      }
      if (this.line.length > MAX_LINE) {
        this.line = this.line.slice(-MAX_LINE);
        this.cursor = this.line.length;
        this.unknown = true;
      }
    }
  }

  dispose() {
    this.disposed = true;
    this.controller.abort();
    this.line = "";
    this.historyPrompt = null;
    this.approved = null;
  }
}
