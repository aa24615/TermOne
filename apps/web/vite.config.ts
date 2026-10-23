import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 开发时把 /api 与 WebSocket 代理到 apps/server（默认 8787），避免跨域与混合协议问题。
const SERVER = process.env.TERMONE_SERVER || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      "/api": {
        target: SERVER,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
