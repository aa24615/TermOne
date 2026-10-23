# TermOne 服务端 + Web SSH 客户端（多阶段构建）
#
# 构建（在仓库根目录执行）：
#   docker compose up -d --build
#   # 或手动：
#   docker build -t termone-server -f apps/server/Dockerfile .
#
# 说明：本镜像会先在容器内构建 apps/web（vite build -> apps/web/dist），
#       再由服务端在运行时托管 /web/dist，作为同源的 Web SSH 控制台。
#       构建上下文必须是仓库根目录（见 docker-compose.yml），
#       这样 Dockerfile 才能同时访问 apps/server 与 apps/web。
#
# 镜像源 / npm 源可通过 build args 覆盖（默认走官方 node:24-alpine + npmjs；
# 内网 / 大陆环境可在 docker-compose.yml 的 build.args 指定镜像源与镜像站）。

ARG NODE_IMAGE=node:24-alpine
ARG NPM_REGISTRY=https://registry.npmjs.org

# ---------- 阶段 1：构建 Web 前端 ----------
FROM ${NODE_IMAGE} AS web-build
ARG NPM_REGISTRY
WORKDIR /web-src
COPY apps/web/package.json ./
RUN npm install --no-audit --no-fund --registry ${NPM_REGISTRY}
COPY apps/web/ ./
RUN npm run build

# ---------- 阶段 2：安装服务端运行时依赖 ----------
FROM ${NODE_IMAGE} AS server-deps
ARG NPM_REGISTRY
WORKDIR /app
COPY apps/server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund --registry ${NPM_REGISTRY}

# ---------- 阶段 3：运行镜像 ----------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    TERMONE_DATA=/data

# 服务端运行时依赖（含 tsx）
COPY --from=server-deps /app/node_modules ./node_modules
# package.json：tsx 据此判定 ESM（type: module），否则顶层 await 会被当 CJS 编译而崩溃
COPY apps/server/package.json ./package.json
# 服务端源码
COPY apps/server/src ./src
# 构建好的 Web 前端：服务端在 /web/dist 托管它
COPY --from=web-build /web-src/dist /web/dist

RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node_modules/.bin/tsx", "src/index.ts"]
