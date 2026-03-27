# ── Build Stage ───────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Skip Playwright browser download (we use system Chromium in runtime)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install ALL deps (including TypeScript + native build tools for better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci

# Compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Prune dev dependencies (keep only production deps with compiled native modules)
RUN npm prune --production

# ── Runtime Stage ─────────────────────────────────────────────────
FROM node:20-slim

# Install Chromium + minimal deps
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

WORKDIR /app

# Tell Playwright to use system Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Copy compiled JS + production node_modules (with pre-built native modules)
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

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "const http=require('http');const r=http.get('http://localhost:4100/api/health',s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1))"

ENV NODE_ENV=production
ENV HEADLESS=true
ENV PORT=4100

CMD ["node", "dist/index.js"]
