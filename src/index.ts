/**
 * 🚀 CATALOG SCRAPER — Entry Point
 *
 * Starts the PartsLink24 scraper service:
 * 1. Initialize SQLite cache
 * 2. Launch Playwright browser
 * 3. Start Express API server
 * 4. Schedule periodic cache cleanup
 *
 * Usage:
 *   npm run dev     — Development with hot reload
 *   npm start       — Production
 */

import { assertProductionConfig, config } from './config';
import { logger } from './logger';
import { initCache, cleanupExpired } from './cache';
import { flushExportBuffer, initBulkStore, recoverRunningJobs } from './bulkStore';
import { initBrowser, closeBrowser } from './scraper';
import { initOemDb, closeOemDb } from './oemDb';
import { app } from './server';
import fs from 'fs';
import path from 'path';

async function main() {
  assertProductionConfig();

  logger.info('═══════════════════════════════════════════════');
  logger.info('  🤖 CATALOG SCRAPER — PartsLink24 Automation');
  logger.info('═══════════════════════════════════════════════');

  // Ensure playwright-data directory exists
  const dataDir = path.join(__dirname, '..', 'playwright-data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Step 1: Initialize databases
  logger.info('Step 1/4: Initializing databases...');
  initCache();
  initBulkStore();
  recoverRunningJobs();

  // Step 1b: Connect OEM PostgreSQL (separate DB for persistent OEM data)
  const oemDbOk = await initOemDb();
  if (oemDbOk) {
    logger.info('✅ OEM PostgreSQL connected — scraped data will be persisted');
  } else {
    logger.warn('⚠️  OEM PostgreSQL not available — using SQLite only');
  }

  // Step 2: Start API server FIRST (so health check works)
  logger.info('Step 2/3: Starting API server...');
  app.listen(config.port, () => {
    logger.info(`✅ Catalog Scraper running on http://localhost:${config.port}`);
    logger.info(`   POST /api/lookup              — OEM lookup (VIN + part)`);
    logger.info(`   GET  /api/health              — Health check`);
    logger.info(`   GET  /api/cache/stats          — Cache stats`);
    logger.info(`   POST /api/cache/cleanup        — Clean expired cache entries`);
    logger.info(`   POST /api/circuit-breaker/reset — Reset circuit breaker`);
    logger.info(`   GET  /api/bulk/status            — Bulk scraper status`);
    logger.info(`   GET  /api/bulk/vehicles           — List vehicles`);
    logger.info(`   POST /api/bulk/jobs/start         — Start bulk job`);
    logger.info('');
    logger.info(`Config: headless=${config.headless}, delay=${config.requestDelayMs}ms, cacheTTL=${config.cacheTtlSeconds}s`);
    if (!config.pl24.username) {
      logger.warn('⚠️  PL24_USERNAME not set! Configure .env before making lookups.');
    }
  });

  // Step 3: Launch browser in background (doesn't block health check)
  logger.info('Step 3/3: Launching browser (background)...');
  initBrowser().then(() => {
    logger.info('✅ Browser ready — accepting lookups');
  }).catch((err: unknown) => {
    logger.error('Browser init failed — lookups will return 503 until browser is ready', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Schedule periodic cache cleanup (every 24h)
  setInterval(() => {
    try {
      const cleaned = cleanupExpired();
      if (cleaned > 0) {
        logger.info(`🧹 Periodic cleanup: removed ${cleaned} expired cache entries`);
      }
    } catch (err: unknown) {
      logger.error('Cache cleanup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, 24 * 60 * 60 * 1000);
}

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down...`);
  await flushExportBuffer().catch((error: unknown) => {
    logger.error('Final export flush failed; durable outbox retained for next start', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  await closeBrowser();
  await closeOemDb();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Catch unhandled errors — don't crash
process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) });
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

// Start
main().catch((err: unknown) => {
  logger.error('Fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
