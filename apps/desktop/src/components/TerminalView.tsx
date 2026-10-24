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
import { registerTerminal } from "../plugin/terminalBridge";

export function TerminalView({ pane, active }: { pane: Pane; active: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const theme = useStore((s) => s.settings.theme);
  const customTheme = useStore(s => s.settings.customTheme);
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
    const dataDisposer = term.onData((d) => {
      // 输入任意内容（含回车）时清除意外触发/残留的文本选区
      if (term.hasSelection()) term.clearSelection();
      const input = bridge ? bridge.input(d) : d;
      if (sessionId && input !== null) void ipc.sessionWrite(sessionId, toB64(input)).catch(() => {});
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
      if (sessionId) void ipc.sessionResize(sessionId, cols, rows).catch(() => {});
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
      unOutput = onSessionOutput(sessionId, data => {
        pendingChunks.push(fromB64(data));
        if (flushTimer === null) flushTimer = setTimeout(flushPending, 12);
      });
      unExit = onSessionExit(sessionId, code => {
        if (pendingChunks.length > 0) flushPending();
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
