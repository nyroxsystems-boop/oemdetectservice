# ── Stage 1: Build ────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# ── Stage 2: Runtime ──────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

# Copy built JS + production deps
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Create data directory for screenshots + session persistence
RUN mkdir -p /app/playwright-data

# Non-root for security
RUN groupadd -r scraper && useradd -r -g scraper scraper && chown -R scraper:scraper /app
USER scraper

# Expose API port
EXPOSE 4100

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "const http=require('http');const r=http.get('http://localhost:4100/api/health',s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1))"

# Set production defaults
ENV NODE_ENV=production
ENV HEADLESS=true
ENV PORT=4100

CMD ["node", "dist/index.js"]
