import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

import { b64decode, b64encode } from "../b64";
import { getToken } from "../api";
import type { ServerFrame } from "../types";

export interface SshSession {
  /** 变化即重连 */
  key: string;
  label: string;
  /** connect 帧内容：hostId 或内联连接参数 */
  connect: Record<string, unknown>;
}

type Status = "connecting" | "live" | "closed" | "error";

const THEME = {
  background: "#0f1115",
  foreground: "#d7dbe0",
  cursor: "#6ea8fe",
  selectionBackground: "#2b3a55",
  black: "#1b1e24",
  red: "#ff6b6b",
  green: "#51cf66",
  yellow: "#fcc419",
  blue: "#6ea8fe",
  magenta: "#cc5de8",
  cyan: "#3bc9db",
  white: "#d7dbe0",
};

export function Terminal({ session, onExit }: { session: SshSession; onExit?: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef<TextDecoder | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [notice, setNotice] = useState<string>("");

  useEffect(() => {
    const el = holder.current;
    if (!el) return;

    decoderRef.current = new TextDecoder("utf-8");
    const term = new XTerm({
      fontFamily: '"Cascadia Mono", "Menlo", "Consolas", monospace',
      fontSize: 14,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    term.writeln(`\x1b[90m正在连接 ${session.label} …\x1b[0m`);

    try {
      fit.fit();
    } catch {
      /* 容器尚未布局 */
    }

    const token = getToken() ?? "";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/ws/ssh?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      const dims = fit.proposeDimensions();
      ws.send(
        JSON.stringify({
          type: "connect",
          cols: dims?.cols ?? 120,
          rows: dims?.rows ?? 32,
          ...session.connect,
        }),
      );
    };

    ws.onmessage = (ev) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      switch (frame.type) {
        case "ready":
          setStatus("live");
          term.clear();
          break;
        case "data": {
          const chunk = decoderRef.current?.decode(b64decode(frame.data), { stream: true }) ?? "";
          term.write(chunk);
          break;
        }
        case "hostkey":
          if (frame.firstUse) {
            setNotice(`已信任新主机指纹 ${frame.fingerprint}`);
          }
          break;
        case "error":
          term.writeln(`\r\n\x1b[31m${frame.message}\x1b[0m`);
          if (frame.fatal) {
            setStatus("error");
            setNotice(frame.message);
          }
          break;
        case "exit":
          setStatus("closed");
          term.writeln(
            `\r\n\x1b[90m会话已结束${frame.code !== undefined ? `（退出码 ${frame.code}）` : ""}\x1b[0m`,
          );
          onExit?.();
          break;
      }
    };

    ws.onerror = () => {
      setStatus("error");
      setNotice("WebSocket 连接错误");
    };

    ws.onclose = (ev) => {
      if (ev.code === 4401) {
        setStatus("error");
        setNotice("未登录或登录已过期");
        return;
      }
      // 用函数式更新，避免闭包中的 status 过期
      setStatus((s) => (s === "error" || s === "closed" ? s : "closed"));
    };

    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "data", data: b64encode(data) }));
      }
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    const onWinResize = () => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", onWinResize);
    const ro = new ResizeObserver(onWinResize);
    ro.observe(el);

    return () => {
      window.removeEventListener("resize", onWinResize);
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      } catch {
        /* ignore */
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
    // 仅在 session.key 变化时重建连接
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.key]);

  const statusText: Record<Status, string> = {
    connecting: "连接中",
    live: "已连接",
    closed: "已断开",
    error: "出错",
  };

  return (
    <div className="term-wrap">
      <div className="term-bar">
        <span className="term-title">{session.label}</span>
        <span className={`term-status ${status}`}>{statusText[status]}</span>
        {notice && <span className="term-notice">{notice}</span>}
        <button
          className="btn-ghost"
          onClick={() => {
            termRef.current?.clear();
          }}
        >
          清屏
        </button>
      </div>
      <div className="term-host" ref={holder} />
    </div>
  );
}
