import { useEffect, useRef, useState } from "react";

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
}

/** 主题化下拉选择框：替代原生 <select>，支持键盘导航与点击外部关闭。 */
export function Dropdown({ value, options, onChange, placeholder, disabled, className }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setActive(idx >= 0 ? idx : 0);
    }
  }, [open, options, value]);

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div className={`dropdown${className ? ` ${className}` : ""}`} ref={rootRef}>
      <button
        type="button"
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
            setOpen(false);
          }
        }}
      >
        <span className={`dropdown-value${selected ? "" : " placeholder"}`}>
          {selected ? selected.label : (placeholder ?? "请选择…")}
        </span>
        <IconCaretDown size={13} className={`dropdown-caret${open ? " open" : ""}`} />
      </button>

      {open && options.length > 0 && (
        <div className="dropdown-list" role="listbox">
          {options.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
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
        </div>
      )}
    </div>
  );
}
