import type { ITheme } from "@xterm/xterm";

interface TermPalette {
  fg: string;
  bg: string;
  cursor: string;
  selectionBg: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

const PALETTES: Record<string, TermPalette> = {
  midnight: {
    fg: "#d6dbe4",
    bg: "#0f1216",
    cursor: "#7c6aff",
    selectionBg: "#2b3140",
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#ef7d82",
    brightGreen: "#a9d487",
    brightYellow: "#f0cd8e",
    brightBlue: "#7cc0f5",
    brightMagenta: "#d48fe6",
    brightCyan: "#6cc4d0",
    brightWhite: "#cfd6e4",
  },
  daylight: {
    fg: "#24292e",
    bg: "#f7f8fa",
    cursor: "#5b4df0",
    selectionBg: "#d8e1f0",
    black: "#3c4350",
    red: "#d0342c",
    green: "#1a7f37",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#aab2bf",
    brightBlack: "#6e7781",
    brightRed: "#e25950",
    brightGreen: "#2da44e",
    brightYellow: "#bf8700",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#d0d7de",
  },
  dracula: {
    fg: "#f8f8f2",
    bg: "#282a36",
    cursor: "#ff79c6",
    selectionBg: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  nord: {
    fg: "#d8dee9",
    bg: "#2e3440",
    cursor: "#88c0d0",
    selectionBg: "#434c5e",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  solarized: {
    fg: "#93a1a1",
    bg: "#002b36",
    cursor: "#93a1a1",
    selectionBg: "#274642",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#002b36",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
};

export function getTermTheme(id: string): ITheme {
  const p = PALETTES[id] ?? PALETTES.midnight;
  return {
    foreground: p.fg,
    background: p.bg,
    cursor: p.cursor,
    cursorAccent: p.cursor,
    selectionBackground: p.selectionBg,
    black: p.black,
    red: p.red,
    green: p.green,
    yellow: p.yellow,
    blue: p.blue,
    magenta: p.magenta,
    cyan: p.cyan,
    white: p.white,
    brightBlack: p.brightBlack,
    brightRed: p.brightRed,
    brightGreen: p.brightGreen,
    brightYellow: p.brightYellow,
    brightBlue: p.brightBlue,
    brightMagenta: p.brightMagenta,
    brightCyan: p.brightCyan,
    brightWhite: p.brightWhite,
  };
}
