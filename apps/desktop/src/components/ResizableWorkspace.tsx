import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { installedKind } from "../plugin/kinds";
import { PluginSurface } from "../plugin/PluginSurface";
import { usePlugins } from "../plugin/runtime";
import { Sidebar } from "./Sidebar";

const HANDLE = 6;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

function ResizeHandle({ side, value, min, max, onResize, onReset, onDragging }: {
  side: "left" | "right";
  value: number;
  min: number;
  max: number;
  onResize: (value: number) => void;
  onReset: () => void;
  onDragging: (dragging: boolean) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number } | null>(null);
  const direction = side === "left" ? 1 : -1;
  const label = side === "left" ? "调整左侧档案栏宽度" : "调整右侧插件栏宽度";
  const finish = useCallback(() => {
    const pointer = drag.current?.pointer;
    drag.current = null;
    if (pointer !== undefined && element.current?.hasPointerCapture(pointer))
      element.current.releasePointerCapture(pointer);
    onDragging(false);
  }, [onDragging]);

  useEffect(() => {
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("blur", finish);
      finish();
    };
  }, [finish]);

  return <div
    ref={element}
    className="workspace-resizer"
    role="separator"
    aria-label={label}
    aria-orientation="vertical"
    aria-valuemin={Math.round(min)}
    aria-valuemax={Math.round(max)}
    aria-valuenow={Math.round(value)}
    aria-valuetext={`${Math.round(value)} 像素`}
    tabIndex={0}
    title={`${label}：拖动调整，方向键微调，双击恢复默认`}
    onPointerDown={(event) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, x: event.clientX, width: value };
      onDragging(true);
    }}
    onPointerMove={(event) => {
      if (!drag.current || drag.current.pointer !== event.pointerId) return;
      onResize(clamp(drag.current.width + (event.clientX - drag.current.x) * direction, min, max));
    }}
    onPointerUp={finish}
    onPointerCancel={finish}
    onLostPointerCapture={finish}
    onDoubleClick={onReset}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = event.shiftKey ? 40 : 10;
        onResize(clamp(value + (event.key === "ArrowRight" ? step : -step) * direction, min, max));
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        onResize(event.key === "Home" ? min : max);
      }
    }}
  />;
}

/** Window-local widths; resizing never serializes or restores terminal layouts. */
export function ResizableWorkspace({ children }: { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(window.innerWidth);
  const [wantedLeft, setLeft] = useState(250);
  const [wantedRight, setRight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const selected = usePlugins((state) => state.selected);
  const plugin = usePlugins((state) => state.installed.find((item) => item.id === selected));
  const hasRight = !!selected && !!plugin?.enabled && installedKind(plugin) === "plugin";

  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Reserve terminal space; scale the minimums only for unusually small viewports.
  const available = Math.max(0, width - HANDLE * (hasRight ? 2 : 1));
  const scale = Math.min(1, available / (180 + 320 + (hasRight ? 240 : 0)));
  const minLeft = 180 * scale, minRight = hasRight ? 240 * scale : 0, minTerminal = 320 * scale;
  const left = clamp(wantedLeft, minLeft, Math.min(480, available - minTerminal - minRight));
  const right = hasRight ? clamp(wantedRight ?? Math.min(560, width * .46), minRight, Math.min(720, available - left - minTerminal)) : 0;
  const maxLeft = Math.max(minLeft, Math.min(480, available - minTerminal - right));
  const maxRight = Math.max(minRight, Math.min(720, available - minTerminal - left));

  return <div ref={container} className={`app-body${dragging ? " resizing-panels" : ""}`} style={{
    "--sidebar-width": `${left}px`, "--plugin-width": `${right}px`,
  } as CSSProperties}>
    <Sidebar />
    <ResizeHandle side="left" value={left} min={minLeft} max={maxLeft} onResize={setLeft} onReset={() => setLeft(250)} onDragging={setDragging} />
    {children}
    {hasRight && <ResizeHandle side="right" value={right} min={minRight} max={maxRight} onResize={setRight} onReset={() => setRight(null)} onDragging={setDragging} />}
    <PluginSurface />
  </div>;
}
