import cors from "@fastify/cors";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerAuthRoutes } from "./auth";
import { registerSshHostRoutes } from "./sshHosts";
import { registerSshWsRoutes } from "./sshWs";
import { registerSyncRoutes } from "./sync";

const app = Fastify({
  logger: true,
  bodyLimit: 8 * 1024 * 1024,
});

await app.register(cors, { origin: true });
await app.register(import("@fastify/websocket"));

registerAuthRoutes(app);
registerSyncRoutes(app);
registerSshHostRoutes(app);
registerSshWsRoutes(app);

// 生产环境：托管 apps/web 的构建产物（同源，无需跨域）
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = [path.resolve(here, "../../web/dist"), path.resolve(process.cwd(), "../web/dist")].find(
  (p) => existsSync(path.join(p, "index.html")),
);

if (webDist) {
  const { default: fastifyStatic } = await import("@fastify/static");
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  // SPA 回退：非 /api 的未知路径一律返回 index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "接口不存在" });
    }
    return reply.sendFile("index.html");
  });
  app.log.info(`已托管 Web SSH 客户端：${webDist}`);
} else {
  app.log.warn("未找到 apps/web/dist，Web 客户端未托管（开发模式请用 npm run dev:web）");
}

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
