# ── Build Stage ───────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install ALL deps (including TypeScript for compilation)
COPY package*.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ── Runtime Stage ─────────────────────────────────────────────────
FROM node:20-slim

# Install Chromium + dependencies for Playwright
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Tell Playwright to use system Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=0
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy compiled JS + production deps only
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Create data directory
RUN mkdir -p /app/playwright-data

# Non-root user
RUN groupadd -r scraper && useradd -r -g scraper -G audio,video scraper \
    && chown -R scraper:scraper /app
USER scraper

EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "const http=require('http');const r=http.get('http://localhost:4100/api/health',s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1))"

ENV NODE_ENV=production
ENV HEADLESS=true
ENV PORT=4100

CMD ["node", "dist/index.js"]
