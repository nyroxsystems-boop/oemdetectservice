/**
 * 🌐 API SERVER — REST interface to the PartsLink24 scraper
 *
 * Endpoints:
 *   POST /api/lookup              — Look up OEM numbers for a VIN + part
 *   GET  /api/health              — Comprehensive health check
 *   GET  /api/cache/stats          — Cache statistics
 *   POST /api/circuit-breaker/reset — Manually reset circuit breaker
 */

import express, { Request, Response } from 'express';
import { lookupOem, LookupResponse, getBrowserStatus } from './scraper';
import { getCached, setCache, getCacheStats, cleanupExpired } from './cache';
import { getQueueStats, resetCircuitBreaker } from './requestQueue';
import { logger } from './logger';
import { config } from './config';

const app = express();
app.use(express.json());

// ── CORS — Allow dashboard to call this service from the browser ─────────────
app.use((_req: Request, res: Response, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (_req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ── Middleware: Request logging ──────────────────────────────────────────────

app.use((req: Request, res: Response, next) => {
  if (req.path !== '/api/health') {
    logger.info(`${req.method} ${req.path}`, { body: req.body });
  }
  next();
});

// ── POST /api/lookup ─────────────────────────────────────────────────────────

interface LookupBody {
  vin: string;
  part: string;
  brand?: string;
}

app.post('/api/lookup', async (req: Request<{}, {}, LookupBody>, res: Response) => {
  const { vin, part, brand } = req.body;

  // Validate input
  if (!vin || !part) {
    return res.status(400).json({ error: 'Missing required fields: vin, part' });
  }

  if (vin.length < 10 || vin.length > 17) {
    return res.status(400).json({ error: 'VIN must be 10-17 characters' });
  }

  // Normalize inputs
  const normalizedVin = vin.toUpperCase().trim();
  const normalizedPart = part.trim();

  // Step 1: Check cache
  const cached = getCached(normalizedVin, normalizedPart);
  if (cached) {
    logger.info('📦 Cache hit!', { vin: normalizedVin, part: normalizedPart, resultCount: cached.results.length });
    return res.json({
      success: true,
      vin: normalizedVin,
      part: normalizedPart,
      brand: brand || null,
      results: cached.results,
      fromCache: true,
      cachedAt: cached.createdAt,
    });
  }

  // Step 2: Scrape PartsLink24
  logger.info('🔍 Cache miss — scraping PartsLink24...', { vin: normalizedVin, part: normalizedPart, brand });

  try {
    const result: LookupResponse = await lookupOem({
      vin: normalizedVin,
      partQuery: normalizedPart,
      brand,
    });

    // Cache only successful results with actual data
    if (result.success && result.results.length > 0) {
      setCache(normalizedVin, normalizedPart, result.results);
    }

    return res.json({
      success: result.success,
      vin: normalizedVin,
      part: normalizedPart,
      brand: brand || null,
      results: result.results,
      fromCache: false,
      elapsedMs: result.elapsedMs,
      error: result.error,
      screenshots: result.screenshots,
    });

  } catch (err: any) {
    logger.error('Lookup failed', { vin: normalizedVin, part: normalizedPart, error: err.message });

    // Check if it's a circuit breaker error
    if (err.message?.includes('Circuit breaker')) {
      return res.status(503).json({
        success: false,
        error: err.message,
        hint: 'POST /api/circuit-breaker/reset to manually reset',
      });
    }

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ── GET /api/health ──────────────────────────────────────────────────────────

app.get('/api/health', (_req: Request, res: Response) => {
  const browser = getBrowserStatus();
  const queue = getQueueStats();
  const cache = getCacheStats();

  // Always return 200 — Railway needs this to keep the container alive.
  // Browser may still be initializing in the background.
  const isReady = browser.running && !queue.circuitBreakerOpen;

  res.status(200).json({
    status: isReady ? 'healthy' : 'starting',
    service: 'catalog-scraper',
    timestamp: new Date().toISOString(),
    browser: {
      running: browser.running,
      loggedIn: browser.loggedIn,
      lastSuccessfulLookup: browser.lastSuccess,
    },
    queue: {
      pending: queue.pending,
      processing: queue.isProcessing,
      circuitBreakerOpen: queue.circuitBreakerOpen,
      consecutiveFailures: queue.consecutiveFailures,
    },
    stats: {
      totalProcessed: queue.totalProcessed,
      totalFailed: queue.totalFailed,
      cacheEntries: cache.totalEntries,
      lastSuccess: queue.lastSuccessAt,
      lastFailure: queue.lastFailureAt,
    },
    config: {
      headless: config.headless,
      requestDelayMs: config.requestDelayMs,
      cacheTtlDays: Math.round(config.cacheTtlSeconds / 86400),
    },
  });
});

// ── POST /api/circuit-breaker/reset ──────────────────────────────────────────

app.post('/api/circuit-breaker/reset', (_req: Request, res: Response) => {
  resetCircuitBreaker();
  res.json({
    success: true,
    message: 'Circuit breaker reset — scraper will retry on next request',
  });
});

// ── GET /api/cache/stats ─────────────────────────────────────────────────────

app.get('/api/cache/stats', (_req: Request, res: Response) => {
  const stats = getCacheStats();
  res.json(stats);
});

// ── POST /api/cache/cleanup ──────────────────────────────────────────────────

app.post('/api/cache/cleanup', (_req: Request, res: Response) => {
  const deletedCount = cleanupExpired();
  res.json({
    success: true,
    deletedEntries: deletedCount,
  });
});

export { app };
