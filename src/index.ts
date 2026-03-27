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

import { config } from './config';
import { logger } from './logger';
import { initCache, cleanupExpired } from './cache';
import { initBrowser, closeBrowser } from './scraper';
import { app } from './server';
import fs from 'fs';
import path from 'path';

async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info('  🤖 CATALOG SCRAPER — PartsLink24 Automation');
  logger.info('═══════════════════════════════════════════════');

  // Ensure playwright-data directory exists
  const dataDir = path.join(__dirname, '..', 'playwright-data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Step 1: Initialize cache
  logger.info('Step 1/3: Initializing cache...');
  initCache();

  // Step 2: Launch browser
  logger.info('Step 2/3: Launching browser...');
  await initBrowser();

  // Step 3: Start API server
  logger.info('Step 3/3: Starting API server...');
  app.listen(config.port, () => {
    logger.info(`✅ Catalog Scraper running on http://localhost:${config.port}`);
    logger.info(`   POST /api/lookup              — OEM lookup (VIN + part)`);
    logger.info(`   GET  /api/health              — Health check`);
    logger.info(`   GET  /api/cache/stats          — Cache stats`);
    logger.info(`   POST /api/cache/cleanup        — Clean expired cache entries`);
    logger.info(`   POST /api/circuit-breaker/reset — Reset circuit breaker`);
    logger.info('');
    logger.info(`Config: headless=${config.headless}, delay=${config.requestDelayMs}ms, cacheTTL=${config.cacheTtlSeconds}s`);
    if (!config.pl24.username) {
      logger.warn('⚠️  PL24_USERNAME not set! Configure .env before making lookups.');
    }
  });

  // Schedule periodic cache cleanup (every 24h)
  setInterval(() => {
    try {
      const cleaned = cleanupExpired();
      if (cleaned > 0) {
        logger.info(`🧹 Periodic cleanup: removed ${cleaned} expired cache entries`);
      }
    } catch (err: any) {
      logger.error('Cache cleanup failed', { error: err.message });
    }
  }, 24 * 60 * 60 * 1000);
}

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down...`);
  await closeBrowser();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Catch unhandled errors — don't crash
process.on('unhandledRejection', (reason: any) => {
  logger.error('Unhandled rejection', { error: reason?.message || String(reason) });
});

process.on('uncaughtException', (err: Error) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  // Don't exit — try to keep running
});

// Start
main().catch(err => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
