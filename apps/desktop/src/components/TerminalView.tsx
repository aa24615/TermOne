import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

import { fromB64, ipc, toB64 } from "../ipc";
import { useStore } from "../store";
import { getTermTheme } from "../themes";
import type { Tab } from "../types";

interface OutputPayload {
  id: string;
  data: string;
}

interface ExitPayload {
  id: string;
  code: number | null;
}

export function TerminalView({ tab, active }: { tab: Tab; active: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const theme = useStore((s) => s.settings.theme);
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

    const sessionId = tab.sessionId;
    const dataDisposer = term.onData((d) => {
      if (sessionId) void ipc.sessionWrite(sessionId, toB64(d)).catch(() => {});
    });
    const resizeDisposer = term.onResize(({ cols, rows }) => {
      if (sessionId) void ipc.sessionResize(sessionId, cols, rows).catch(() => {});
    });
    if (sessionId) {
      void ipc.sessionResize(sessionId, term.cols, term.rows).catch(() => {});
    }

    let unOutput: UnlistenFn | undefined;
    let unExit: UnlistenFn | undefined;
    void listen<OutputPayload>("session:output", (e) => {
      if (e.payload.id === sessionId) term.write(fromB64(e.payload.data));
    }).then((fn) => {
      unOutput = fn;
    });
    void listen<ExitPayload>("session:exit", (e) => {
      if (e.payload.id === sessionId) {
        term.write("\r\n\x1b[2m── 会话已结束 ──\x1b[0m\r\n");
        useStore.getState().markSessionExit(sessionId, e.payload.code);
      }
    }).then((fn) => {
      unExit = fn;
    });

    const ro = new ResizeObserver(() => {
      if (useStore.getState().activeTabId !== tab.id) return;
      try {
        fit.fit();
      } catch {
        // 尺寸异常时忽略
      }
    });
    ro.observe(host);

    return () => {
      dataDisposer.dispose();
      resizeDisposer.dispose();
      ro.disconnect();
      unOutput?.();
      unExit?.();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // 仅随标签页挂载/卸载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

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
  }, [theme, fontFamily, fontSize]);

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
