import { useState } from "react";
import type { Host } from "../plugin/types";
import { report } from "./shared";
interface Theme {
  name: string;
  terminal: Record<string, string>;
}
const themes: Theme[] = [
  {
    name: "Ocean",
    terminal: {
      background: "#0b1622",
      foreground: "#d4e6f1",
      cursor: "#56c4ec",
      selectionBackground: "#26475c",
      red: "#f07882",
      green: "#89d49b",
      yellow: "#f5d98c",
      blue: "#79bbee",
      magenta: "#c79deb",
      cyan: "#78d8d0",
    },
  },
  {
    name: "Paper",
    terminal: {
      background: "#faf7ed",
      foreground: "#343126",
      cursor: "#8b5f34",
      selectionBackground: "#dfd4b8",
      red: "#b84035",
      green: "#527834",
      yellow: "#96731e",
      blue: "#356ba0",
      magenta: "#915a9c",
      cyan: "#397d83",
    },
  },
  {
    name: "Rose",
    terminal: {
      background: "#211c27",
      foreground: "#e2d3e8",
      cursor: "#ed9ba6",
      selectionBackground: "#514058",
      red: "#ef8796",
      green: "#accba4",
      yellow: "#ebce9d",
      blue: "#a0bce8",
      magenta: "#d7a6dd",
      cyan: "#92c8cc",
    },
  },
];
function parseThemes(value: unknown): Theme[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 100) throw new Error("主题数量过多");
  return list.map((v) => {
    const t = v as Theme;
    if (
      !t?.name ||
      !t.terminal ||
      !t.terminal.background ||
      !t.terminal.foreground ||
      Object.values(t.terminal).some(
        (v) => typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v),
      )
    )
      throw new Error("主题格式无效：需要 name、terminal 和十六进制颜色");
    return t;
  });
}
export default function ThemeMarket({ host }: { host: Host }) {
  const [items, setItems] = useState(themes);
  const [url, setUrl] = useState("");
  return (
    <div className="plugin-stack">
      <p className="muted">
        精选主题离线可用。可导入 JSON 或加载已授权 HTTPS 域名的自托管主题目录。
      </p>
      <label>
        导入主题 JSON
        <input
          type="file"
          accept=".json,application/json"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file)
              report(host, async () => {
                if (file.size > 100_000) throw new Error("主题文件过大");
                setItems(parseThemes(JSON.parse(await file.text())));
              });
          }}
        />
      </label>
      <div className="plugin-actions">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://themes.example.com/index.json"
        />
        <button
          className="btn"
          disabled={!url}
          onClick={() =>
            report(host, async () => {
              const res = await host.fetch(url);
              if (!res.ok) throw new Error("目录请求失败");
              const text = await res.text();
              if (text.length > 100_000) throw new Error("目录过大");
              setItems(parseThemes(JSON.parse(text)));
            })
          }
        >
          加载主题目录
        </button>
      </div>
      {items.map((t) => (
        <section
          className="plugin-card"
          key={t.name}
          style={{
            background: t.terminal.background,
            color: t.terminal.foreground,
          }}
        >
          <strong>{t.name}</strong>
          <pre>$ echo TermOne</pre>
          <button
            className="btn"
            onClick={() =>
              report(host, async () => {
                await host.invoke("theme_install", { theme: t });
                host.toast("主题已应用");
              })
            }
          >
            应用
          </button>
        </section>
      ))}
    </div>
  );
}
