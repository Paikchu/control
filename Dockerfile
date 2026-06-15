# ---- 构建阶段：编译前端 ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html ./
COPY src ./src
RUN npm run build

# ---- 运行阶段：Hono 同时服务 API 和静态文件 ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs ./
COPY server ./server
COPY src/*.mjs ./src/
COPY --from=build /app/dist ./dist

ENV PORT=8787 \
    HOST=0.0.0.0 \
    SERVE_STATIC=1

EXPOSE 8787
CMD ["node", "server.mjs"]
