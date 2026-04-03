# 与 package-lock.json 中 playwright 主版本对齐，镜像内已含 Chromium 及系统依赖
FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
# 官方镜像无 Google Chrome，持久目录下使用 Playwright Chromium
ENV PLAYWRIGHT_CHANNEL=chromium

EXPOSE 8000

# 覆盖：docker compose 里 command / 本地 docker run ... node index.js run ...
CMD ["node", "index.js", "web", "--port", "8000"]
