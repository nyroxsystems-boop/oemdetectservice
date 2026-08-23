# ── Build Stage ───────────────────────────────────────────────────
FROM node:22.23.2-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS builder

WORKDIR /app

# Skip browser download during npm ci (we install in runtime stage)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Build tools for better-sqlite3 native module
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

# Compile TypeScript
COPY tsconfig.json ./
COPY tsconfig.build.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN npm run build

# Strip dev dependencies
RUN npm prune --omit=dev

# ── Runtime Stage ─────────────────────────────────────────────────
FROM node:22.23.2-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

WORKDIR /app

ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG APP_RELEASE=catalog-scraper@unversioned
ARG VCS_REPOSITORY=https://github.com/nyroxsystems-boop/oemdetectservice
LABEL org.opencontainers.image.source="$VCS_REPOSITORY" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.created="$BUILD_DATE" \
      org.opencontainers.image.version="$APP_RELEASE"

# Store Playwright browsers in a shared, predictable location
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

# Copy compiled JS + production node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

# Install Playwright's matching Chromium + system deps into shared path
RUN npx playwright install chromium --with-deps

# Build tooling is not needed by the running service. Apply current security
# updates to the final OS layer, then remove npm/npx and their transitive CVEs.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

# Create data directory + non-root user
RUN mkdir -p /app/playwright-data \
    && groupadd -r scraper && useradd -r -g scraper -G audio,video scraper \
    && chown -R scraper:scraper /app /tmp

USER scraper

EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "const http=require('http');const r=http.get('http://localhost:4100/api/health',s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1))"

ENV NODE_ENV=production \
    HEADLESS=true \
    PORT=4100 \
    APP_RELEASE="$APP_RELEASE" \
    SENTRY_RELEASE="$APP_RELEASE" \
    GIT_COMMIT_SHA="$VCS_REF" \
    BUILD_DATE="$BUILD_DATE"

CMD ["node", "dist/index.js"]
