import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { IconCaretDown, IconCheck } from "./icons";

export interface DropdownOption {
  value: string;
  label: string;
  description?: string;
}

interface Props {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

/** 主题化下拉选择框：替代原生 <select>，支持键盘导航与点击外部关闭。 */
export function Dropdown({ value, options, onChange, placeholder, disabled, className, ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const [position, setPosition] = useState<CSSProperties>({});

  const selected = options.find((o) => o.value === value);
  const selectedIndex = options.findIndex((o) => o.value === value);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const upwards = below < Math.min(264, options.length * 34 + 8) && above > below;
      const width = Math.min(rect.width, window.innerWidth - 16);
      setPosition({
        width,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: upwards ? undefined : rect.bottom + 4,
        bottom: upwards ? window.innerHeight - rect.top + 4 : undefined,
        maxHeight: Math.max(0, Math.min(264, upwards ? above : below)),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (buttonRef.current) observer.observe(buttonRef.current);
    const onScroll = (event: Event) => {
      if (!listRef.current?.contains(event.target as Node)) place();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node) && !listRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setActive(selectedIndex >= 0 ? selectedIndex : 0);
    }
  }, [open, selectedIndex]);

  useEffect(() => {
    if (open) listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <div className={`dropdown${className ? ` ${className}` : ""}`} ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
        className={`dropdown-btn${open ? " open" : ""}`}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) {
              setOpen(true);
              return;
            }
            setActive((a) => {
              const next = e.key === "ArrowDown" ? a + 1 : a - 1;
              return Math.max(0, Math.min(options.length - 1, next));
            });
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (open && active >= 0 && options[active]) commit(options[active].value);
            else setOpen(true);
          } else if (e.key === "Escape") {
            if (open) { e.preventDefault(); e.stopPropagation(); }
            setOpen(false);
          } else if (open && (e.key === "Home" || e.key === "End")) {
            e.preventDefault();
            setOpen(true);
            setActive(e.key === "Home" ? 0 : options.length - 1);
          } else if (e.key === "Tab") {
            setOpen(false);
          }
        }}
      >
        <span className={`dropdown-value${selected && value ? "" : " placeholder"}`} title={selected?.label}>
          {selected ? selected.label : (placeholder ?? "请选择…")}
        </span>
        <IconCaretDown size={13} className={`dropdown-caret${open ? " open" : ""}`} />
      </button>

      {open && options.length > 0 && createPortal(
        <div className="dropdown-list" role="listbox" id={listId} ref={listRef} style={position} aria-label={ariaLabel}
          onMouseDown={(event) => { if ((event.target as Element).closest("[role=option]")) event.preventDefault(); }}>
          {options.map((o, i) => (
            <div
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              title={[o.label, o.description].filter(Boolean).join(" · ")}
              className={`dropdown-option${i === active ? " active" : ""}${
                o.value === value ? " selected" : ""
              }`}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(o.value)}
            >
              <span className="opt-label">{o.label}</span>
              {o.description && <span className="opt-desc">{o.description}</span>}
              {o.value === value && <IconCheck size={13} className="opt-check" />}
            </div>
          ))}
        </div>, document.body
      )}
    </div>
  );
}
