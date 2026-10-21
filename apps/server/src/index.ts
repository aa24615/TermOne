import cors from "@fastify/cors";
import Fastify from "fastify";

import { registerAuthRoutes } from "./auth";
import { registerSyncRoutes } from "./sync";

const app = Fastify({
  logger: true,
  bodyLimit: 8 * 1024 * 1024,
});

await app.register(cors, { origin: true });

registerAuthRoutes(app);
registerSyncRoutes(app);

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
