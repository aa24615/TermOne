# TermOne 同步服务端
#
# 构建（任选其一，均在仓库根目录执行）:
#   docker build -t termone-server apps/server
#   docker compose build
#
# 运行:
#   docker run -p 8787:8787 -v termone-data:/data termone-server

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    TERMONE_DATA=/data
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["npx", "tsx", "src/index.ts"]
