import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { onSessionOutput, onSessionExit } from "../sessionEvents";
import "@xterm/xterm/css/xterm.css";

import { fromB64, ipc, toB64 } from "../ipc";
import { useStore } from "../store";
import { getTermTheme } from "../themes";
import type { Pane } from "../types";
import { TerminalInputGuard, RISK_REASONS } from "../terminalInputGuard";
import { confirm } from "./Dialog";
import { registerTerminal } from "../plugin/terminalBridge";
import { historyRecording, notifyCommand, resolveSubmittedCommand } from "../commandHistory";

export function TerminalView({
  pane,
  active,
}: {
  pane: Pane;
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const theme = useStore((s) => s.settings.theme);
  const customTheme = useStore((s) => s.settings.customTheme);
  const fontFamily = useStore((s) => s.settings.fontFamily);
  const fontSize = useStore((s) => s.settings.fontSize);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const settings = useStore.getState().settings;
    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      scrollback: settings.scrollback,
      cursorBlink: true,
      theme: getTermTheme(settings.theme),
      allowProposedApi: true,
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new SearchAddon());
    term.open(host);
    try {
      fit.fit();
    } catch {
      // 容器尺寸尚未就绪时忽略
    }

    const sessionId = pane.sessionId;
    const bridge = sessionId ? registerTerminal(sessionId, term) : null;
    const visibleLine = () => {
      const buffer = term.buffer.active;
      let at = buffer.baseY + buffer.cursorY;
      let text = buffer.getLine(at)?.translateToString(true) ?? "";
      for (let n = 0; n < 32 && at > 0 && buffer.getLine(at)?.isWrapped; n++) {
        at--;
        text = (buffer.getLine(at)?.translateToString(true) ?? "") + text;
      }
      return text;
    };
    const guard = new TerminalInputGuard({
      check: ipc.commandCheck,
      confirm: (check, text, signal) =>
        confirm(
          {
            title: check.risk === "danger" ? "危险命令确认" : "终端输入确认",
            confirmText: check.risk === "danger" ? "仍然发送" : "确认发送",
            message:
              "目标：" +
              (pane.title || pane.sessionTitle || "当前终端") +
              "\n\n" +
              check.reasons.map((r) => RISK_REASONS[r] ?? r).join("\n") +
              "\n\n待发送内容：\n" +
              text.slice(0, 8192) +
              (text.length > 8192
                ? "\n…（预览已截断，检查覆盖全部内容）"
                : "") +
              "\n\n确认后才会发送；取消保留已输入内容。",
          },
          signal,
        ),
      send: (data) => {
        const input = bridge ? bridge.input(data) : data;
        if (sessionId && input !== null)
          void ipc
            .sessionWrite(sessionId, toB64(input))
            .catch((e) => useStore.getState().showToast(String(e), "error"));
        return !!sessionId && input !== null;
      },
      paste: (text) => term.paste(text),
      visibleLine,
      historyEnabled: historyRecording,
      submitted: (entry) => {
        if (!sessionId || !["local", "ssh"].includes(pane.kind)) return;
        const command = resolveSubmittedCommand(entry, visibleLine(), term.buffer.active.type === "alternate");
        if (command) notifyCommand({ sessionId, command });
      },
      error: (message) => useStore.getState().showToast(message, "error"),
      focus: () => {
        if (useStore.getState().activePaneId === pane.id) term.focus();
      },
    });
    const onPaste = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      guard.paste(event.clipboardData.getData("text/plain"));
    };
    host.addEventListener("paste", onPaste, true);
    const dataDisposer = term.onData((data) => {
      if (term.hasSelection()) term.clearSelection();
      guard.input(data);
    });
    // Esc 清除选区（其次才作为普通按键发给 Shell）
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === "keydown" && ev.key === "Escape" && term.hasSelection()) {
        term.clearSelection();
        return false;
      }
      return true;
    });
    const resizeDisposer = term.onResize(({ cols, rows }) => {
      if (sessionId)
        void ipc.sessionResize(sessionId, cols, rows).catch(() => {});
    });
    if (sessionId) {
      void ipc.sessionResize(sessionId, term.cols, term.rows).catch(() => {});
    }

    let unOutput: (() => void) | undefined;
    let unExit: (() => void) | undefined;
    // 输出合批：高频输出时合并 12ms 窗口内的数据块一次写入，
    // 避免每块都触发事件分发 + 渲染调度冲卡主线程
    let pendingChunks: Uint8Array[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPending = () => {
      flushTimer = null;
      if (pendingChunks.length === 0) return;
      const total = pendingChunks.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of pendingChunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      pendingChunks = [];
      const output = bridge ? bridge.output(merged) : merged;
      if (output) term.write(output);
    };
    if (sessionId) {
      unOutput = onSessionOutput(sessionId, (data) => {
        pendingChunks.push(fromB64(data));
        if (flushTimer === null) flushTimer = setTimeout(flushPending, 12);
      });
      unExit = onSessionExit(sessionId, (code) => {
        if (pendingChunks.length > 0) flushPending();
        guard.dispose();
        term.write("\r\n\x1b[2m── 会话已结束 ──\x1b[0m\r\n");
        useStore.getState().markSessionExit(sessionId, code);
      });
    }

    let fitScheduled = false;
    const scheduleFit = () => {
      if (fitScheduled) return;
      fitScheduled = true;
      requestAnimationFrame(() => {
        fitScheduled = false;
        if (useStore.getState().activePaneId !== pane.id) return;
        try {
          fit.fit();
        } catch {
          // 尺寸异常时忽略
        }
      });
    };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(host);

    return () => {
      guard.dispose();
      host.removeEventListener("paste", onPaste, true);
      bridge?.dispose();
      dataDisposer.dispose();
      resizeDisposer.dispose();
      ro.disconnect();
      unOutput?.();
      unExit?.();
      if (flushTimer !== null) clearTimeout(flushTimer);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // 仅随面板挂载/卸载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = getTermTheme(theme);
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
    try {
      fitRef.current?.fit();
    } catch {
      // 忽略
    }
  }, [theme, customTheme, fontFamily, fontSize]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // 忽略
      }
      termRef.current?.focus();
    });
  }, [active]);

  return (
    <div className="term-wrap">
      <div ref={hostRef} className="term-host" />
    </div>
  );
}
