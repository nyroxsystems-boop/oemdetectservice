# ── Build Stage ───────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Skip browser download during npm ci (we install in runtime stage)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Build tools for better-sqlite3 native module
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

# Compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Strip dev dependencies
RUN npm prune --production

# ── Runtime Stage ─────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Copy compiled JS + production node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Install Playwright's OWN matching Chromium + system deps
# This ensures version compatibility between Playwright and Chromium
RUN npx playwright install chromium --with-deps

# Create data directory
RUN mkdir -p /app/playwright-data

# Non-root user
RUN groupadd -r scraper && useradd -r -g scraper -G audio,video scraper \
    && chown -R scraper:scraper /app /tmp
USER scraper

EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "const http=require('http');const r=http.get('http://localhost:4100/api/health',s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1))"

ENV NODE_ENV=production
ENV HEADLESS=true
ENV PORT=4100

CMD ["node", "dist/index.js"]
