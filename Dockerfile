# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS model
# BRIA RMBG-2.0 (CC BY-NC 4.0) for background removal, pinned by checksum
ADD --chmod=644 --checksum=sha256:5b486f08200f513f460da46dd701db5fbb47d79b4be4b708a19444bcd4e79958 \
  https://github.com/danielgatis/rembg/releases/download/v0.0.0/bria-rmbg-2.0.onnx /models/bria-rmbg-2.0.onnx

FROM node:22-bookworm-slim
WORKDIR /app
# System Chromium for headless scraping; dumb-init reaps Chrome child processes
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation dumb-init ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/fragscrape.db \
    BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PARFUMO_AUTH_ENABLED=false \
    TRUST_PROXY=1 \
    REQUIRE_API_KEY=true \
    LOG_CONSOLE_LEVEL=info \
    BG_MODEL_DIR=/app/models
COPY --from=model /models /app/models
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /app/data /app/logs && chown -R node:node /app/data /app/logs
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
