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
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { lookupOem, LookupResponse, getBrowserStatus, partslinkSearchQuery } from './scraper';
import { getCached, setCache, getCacheStats, cleanupExpired } from './cache';
import { getQueueStats, resetCircuitBreaker } from './requestQueue';
import { logger } from './logger';
import { config } from './config';
import {
  listVehicles, getVehicle, upsertVehicle, updateVehicle, deleteVehicle,
  createJob, getJob, getActiveJob, listJobs, updateJobStatus,
  getResults, getAllResultsForExport, getBulkStats, getJobProgress,
} from './bulkStore';
import { startCrawl, pauseBulk, resumeBulk, cancelBulk, getBulkState, discoverBrandsAndModels, crawlSingleBrand } from './bulkCrawler';
import { crawlBrandViaApi, getApiState, cancelApi, pauseApi, resumeApi } from './apiCrawler';
import { startBrandChain, getChainState, isChainActive, pauseChain, resumeChain, cancelChain } from './brandChain';
import { PL24_SERVICE_MAP } from './scraper';
import { seedAllVins, getVinCount } from './vinSeeder';
import { requireApiKey } from './httpSecurity';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '64kb' }));

// ── CORS — explicit browser origins only; service-to-service has no Origin ───
const allowedOrigins = new Set(config.corsAllowedOrigins);
app.use((req: Request, res: Response, next) => {
  const origin = req.get('origin');
  if (origin && !allowedOrigins.has(origin)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Public liveness intentionally exposes no browser, queue, or credential state.
app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: 'catalog-scraper' });
});

app.use(rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
}));
app.use(requireApiKey);

app.use((req: Request, res: Response, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Authenticated readiness includes operational detail for automation/admins.
app.get('/api/ready', (_req: Request, res: Response) => {
  const browser = getBrowserStatus();
  const queue = getQueueStats();
  const cache = getCacheStats();
  const isReady = browser.running && !queue.circuitBreakerOpen;

  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'not_ready',
    service: 'catalog-scraper',
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
  });
});

// ── POST /api/lookup ─────────────────────────────────────────────────────────

interface LookupBody {
  vin: string;
  part: string;
  brand?: string;
}

app.post('/api/lookup', async (req: Request<{}, {}, LookupBody>, res: Response) => {
  const { vin, part, brand } = req.body || {};

  // Validate input
  if (typeof vin !== 'string' || typeof part !== 'string') {
    return res.status(400).json({ error: 'Missing required fields: vin, part' });
  }

  const normalizedVin = vin.toUpperCase().trim();
  const normalizedPart = part.trim();
  if (normalizedVin.length < 10 || normalizedVin.length > 17 || !/^[A-HJ-NPR-Z0-9]+$/.test(normalizedVin)) {
    return res.status(400).json({ error: 'VIN must be 10-17 characters' });
  }
  if (!normalizedPart || normalizedPart.length > 200 || (brand !== undefined && (typeof brand !== 'string' || brand.length > 50))) {
    return res.status(400).json({ error: 'Invalid part or brand' });
  }

  // Step 1: Check cache
  // v2 bypasses legacy cache entries created from position-heavy Partslink
  // searches. Equivalent mechanic terms share the component-only cache key.
  const cachePart = `qa-v2:${partslinkSearchQuery(normalizedPart).toLocaleLowerCase('de-DE')}`;
  const cached = getCached(normalizedVin, cachePart);
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
      setCache(normalizedVin, cachePart, result.results);
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

  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('Lookup failed', { vin: normalizedVin, part: normalizedPart, error: errMsg });

    // Check if it's a circuit breaker error
    if (errMsg.includes('Circuit breaker')) {
      return res.status(503).json({
        success: false,
        error: errMsg,
        hint: 'POST /api/circuit-breaker/reset to manually reset',
      });
    }

    return res.status(500).json({
      success: false,
      error: errMsg,
    });
  }
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

// ═══════════════════════════════════════════════════════════════════════════
// BULK SCRAPER API
// ═══════════════════════════════════════════════════════════════════════════

// ── GET /api/bulk/status ────────────────────────────────────────────────────

app.get('/api/bulk/status', (_req: Request, res: Response) => {
  const browserState = getBulkState();
  const apiState = getApiState();
  const stats = getBulkStats();
  const active = getActiveJob();

  // Merge browser + API state
  const running = browserState.running || apiState.running;
  const currentBrand = apiState.currentBrand || browserState.currentBrand || null;

  res.json({
    running,
    paused: browserState.paused,
    currentJob: active || null,
    currentBrand,
    mode: apiState.running ? 'api' : browserState.running ? 'browser' : 'idle',
    ...stats,
  });
});

// ── Vehicle CRUD ────────────────────────────────────────────────────────────

app.get('/api/bulk/vehicles', (req: Request, res: Response) => {
  const brand = req.query.brand as string | undefined;
  const active = req.query.active !== undefined ? req.query.active === 'true' : undefined;
  const vehicles = listVehicles({ brand, active });
  res.json({ vehicles });
});

app.post('/api/bulk/vehicles', (req: Request, res: Response) => {
  const { vin, brand, model, model_code, year_from, year_to, notes } = req.body;
  if (!vin || !brand || !model) {
    return res.status(400).json({ error: 'Missing required: vin, brand, model' });
  }
  try {
    const id = upsertVehicle({ vin, brand, model, model_code, year_from, year_to, notes });
    res.json({ success: true, id });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put('/api/bulk/vehicles/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id));
  const updated = updateVehicle(id, req.body);
  if (!updated) return res.status(404).json({ error: 'Vehicle not found' });
  res.json({ success: true });
});

// Discover all brands & models directly from PartsLink24
app.post('/api/bulk/discover', async (_req: Request, res: Response) => {
  try {
    logger.info('Starting PL24 brand/model discovery...');
    const result = await discoverBrandsAndModels();
    res.json({
      success: true,
      ...result,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── GET /api/bulk/brands — List all available brands ──────────────────────────

app.get('/api/bulk/brands', (_req: Request, res: Response) => {
  const brands = Object.keys(PL24_SERVICE_MAP).sort();
  res.json({ brands });
});

// ── POST /api/bulk/crawl-brand — Crawl a single brand completely ─────────────

app.post('/api/bulk/crawl-brand', async (req: Request, res: Response) => {
  const { brand, mode } = req.body;
  if (!brand) return res.status(400).json({ error: 'brand required (e.g., "VW", "AUDI", "BMW")' });

  const useApi = mode !== 'browser'; // Default: Hybrid API mode (API nav + browser click for BOM)
  logger.info(`🏭 Starting brand crawl: ${brand} (mode: ${useApi ? 'API ⚡' : 'Browser 🌐'})`);

  try {
    res.json({ success: true, mode: useApi ? 'api' : 'browser', message: `Crawl started for ${brand} in ${useApi ? 'API' : 'Browser'} mode.` });

    if (useApi) {
      // ⚡ API mode — 10-20x faster, direct REST API calls
      crawlBrandViaApi(brand).then(result => {
        logger.info(`🏁 API crawl complete: ${brand}`, result);
      }).catch((err: unknown) => {
        logger.error(`❌ API crawl failed: ${brand}`, { error: err instanceof Error ? err.message : String(err) });
      });
    } else {
      // 🌐 Browser mode — original Playwright UI scraping
      crawlSingleBrand(brand).then(result => {
        logger.info(`🏁 Browser crawl complete: ${brand}`, result);
      }).catch((err: unknown) => {
        logger.error(`❌ Browser crawl failed: ${brand}`, { error: err instanceof Error ? err.message : String(err) });
      });
    }
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Brand Chain (auto-continue) ─────────────────────────────────────────────
// POST /api/bulk/chain/start  { startBrand, mode }
// Starts a sequential crawl beginning at `startBrand` and running through all
// subsequent brands in PL24_SERVICE_MAP. Fire-and-forget — chain state is
// queryable via /api/bulk/chain/state.
app.post('/api/bulk/chain/start', async (req: Request, res: Response) => {
  const { startBrand, mode } = req.body || {};
  if (!startBrand) return res.status(400).json({ error: 'startBrand required' });

  if (isChainActive()) {
    return res.status(409).json({ error: 'Chain already running', state: getChainState() });
  }
  // Guard against overlap with single-brand runs
  const apiSt = getApiState();
  const bulkSt = getBulkState();
  if (apiSt.running || bulkSt.running) {
    return res.status(409).json({
      error: 'Another crawl is already running — cancel it before starting a chain',
      apiRunning: apiSt.running,
      bulkRunning: bulkSt.running,
    });
  }

  try {
    await startBrandChain(startBrand, mode === 'browser' ? 'browser' : 'api');
    const st = getChainState();
    logger.info(`🔗 Chain started via API: ${startBrand} (mode: ${st.mode}, queue: ${st.brands.length})`);
    return res.json({ success: true, state: st });
  } catch (err: unknown) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/bulk/chain/pause', (_req: Request, res: Response) => {
  pauseChain();
  return res.json({ success: true, state: getChainState() });
});

app.post('/api/bulk/chain/resume', (_req: Request, res: Response) => {
  resumeChain();
  return res.json({ success: true, state: getChainState() });
});

app.post('/api/bulk/chain/cancel', (_req: Request, res: Response) => {
  cancelChain();
  return res.json({ success: true, state: getChainState() });
});

app.get('/api/bulk/chain/state', (_req: Request, res: Response) => {
  return res.json(getChainState());
});

app.post('/api/bulk/vehicles/seed', (_req: Request, res: Response) => {
  try {
    const result = seedAllVins();
    res.json({
      success: true,
      ...result,
      availableVins: getVinCount(),
    });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/bulk/vehicles/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id));
  const deleted = deleteVehicle(id);
  if (!deleted) return res.status(404).json({ error: 'Vehicle not found' });
  res.json({ success: true });
});

// ── Job Control ─────────────────────────────────────────────────────────────

app.post('/api/bulk/jobs/start', async (req: Request, res: Response) => {
  const { vehicleId } = req.body;
  if (!vehicleId) return res.status(400).json({ error: 'vehicleId required' });

  const vehicle = getVehicle(vehicleId);
  if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

  try {
    const job = createJob(vehicleId);
    startCrawl(job.id).catch((err: unknown) => {
      logger.error('Crawl failed', { jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    });
    res.json({ success: true, jobId: job.id });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/bulk/jobs/start-all', async (_req: Request, res: Response) => {
  // NEW: Sequential brand-by-brand approach
  const vehicles = listVehicles({ active: true });
  if (vehicles.length === 0) {
    return res.status(400).json({ error: 'No active vehicles. Run discovery first.' });
  }

  // Get unique brands
  const brands = [...new Set(vehicles.map(v => v.brand.toUpperCase()))];
  logger.info(`🏭 Start-all: ${brands.length} brands to process sequentially: ${brands.join(', ')}`);

  res.json({ success: true, message: `Processing ${brands.length} brands sequentially`, brands });

  // Process brands one by one in background
  (async () => {
    for (const brand of brands) {
      try {
        logger.info(`\n🏭 ═══ STARTING BRAND: ${brand} ═══`);
        const result = await crawlSingleBrand(brand);
        logger.info(`✅ Brand ${brand} done: ${result.totalOems} OEMs, ${result.errors.length} errors`);
      } catch (err: unknown) {
        logger.error(`❌ Brand ${brand} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    logger.info('🏁 All brands complete!');
  })().catch((err: unknown) => logger.error('Start-all failed', { error: err instanceof Error ? err.message : String(err) }));
});

app.post('/api/bulk/jobs/:id/pause', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id));
  const job = getJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  pauseBulk();
  res.json({ success: true });
});

app.post('/api/bulk/jobs/:id/resume', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id));
  const job = getJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'paused') return res.status(400).json({ error: 'Job is not paused' });

  resumeBulk();
  startCrawl(id).catch((err: unknown) => {
    logger.error('Resume crawl failed', { jobId: id, error: err instanceof Error ? err.message : String(err) });
  });
  res.json({ success: true });
});

app.post('/api/bulk/jobs/:id/cancel', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id));
  const job = getJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  cancelBulk();
  cancelApi();
  updateJobStatus(id, 'failed', { last_error: 'Cancelled by admin' });
  res.json({ success: true });
});

// Cancel ALL crawling — both browser and API mode
app.post('/api/bulk/cancel-all', (_req: Request, res: Response) => {
  cancelBulk();
  cancelApi();

  // Cancel all running/queued jobs in DB
  const { jobs } = listJobs({ limit: 100 });
  let cancelled = 0;
  for (const job of jobs) {
    if (job.status === 'running' || job.status === 'queued' || job.status === 'paused') {
      updateJobStatus(job.id, 'failed', { last_error: 'Cancelled by admin (cancel-all)' });
      cancelled++;
    }
  }

  logger.info(`Cancel-all: ${cancelled} jobs cancelled`);
  res.json({ success: true, cancelled });
});

// ── Job Details ──────────────────────────────────────────────────────────────

app.get('/api/bulk/jobs', (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  const limit = parseInt(req.query.limit as string || '50');
  const offset = parseInt(req.query.offset as string || '0');
  const result = listJobs({ status, limit, offset });
  res.json(result);
});

app.get('/api/bulk/jobs/:id', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id));
  const job = getJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const progress = getJobProgress(id);
  res.json({ job, progress });
});

app.get('/api/bulk/jobs/:id/results', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id));
  const limit = parseInt(req.query.limit as string || '50');
  const offset = parseInt(req.query.offset as string || '0');
  const search = req.query.search as string | undefined;
  const brand = req.query.brand as string | undefined;

  const result = getResults(id, { limit, offset, search, brand });
  res.json(result);
});

// ── Export ───────────────────────────────────────────────────────────────────

app.post('/api/bulk/export', async (req: Request, res: Response) => {
  const { jobIds } = req.body;

  try {
    const results = getAllResultsForExport(jobIds);
    if (results.length === 0) {
      return res.status(400).json({ error: 'No results to export. Make sure the scraper has found OEMs first.' });
    }

    logger.info(`Export: ${results.length} OEMs to export`, {
      wwsBotUrl: config.wwsBotUrl,
      hasToken: !!config.adminToken,
    });

    // Map PL24 HG codes to part categories
    const records = results.map(r => ({
      oem: r.oem,
      brand: r.brand,
      model: r.model,
      description: r.description,
      hg_code: r.hg_code,
      hg_name: r.hg_name,
      fg_code: r.fg_code,
      fg_name: r.fg_name,
      part_category: mapHgToCategory(r.hg_code || '', r.hg_name || ''),
    }));

    // Push to WhatsApp-Bot in batches
    const batchSize = 500;
    let exported = 0;
    let errors = 0;

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (config.adminToken) {
          headers['Authorization'] = `Token ${config.adminToken}`;
        }
        const resp = await fetch(`${config.wwsBotUrl}/api/service/oem-bulk-import`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ records: batch, source: 'partslink24-bulk' }),
        });

        if (resp.ok) {
          const data = await resp.json() as { imported?: number };
          exported += data.imported || batch.length;
        } else {
          errors += batch.length;
          logger.error(`Export batch failed: ${resp.status}`, { batch: i / batchSize });
        }
      } catch (err: unknown) {
        errors += batch.length;
        logger.error('Export batch error', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    res.json({
      success: true,
      total: records.length,
      exported,
      errors,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── HG Code → Category Mapping ──────────────────────────────────────────────

function mapHgToCategory(hgCode: string, hgName: string): string {
  const map: Record<string, string> = {
    '01': 'maintenance', '02': 'maintenance',
    '03': 'body', '04': 'body',
    '11': 'engine', '12': 'electrical', '13': 'fuel',
    '16': 'fuel', '17': 'cooling', '18': 'exhaust',
    '21': 'clutch', '22': 'transmission', '23': 'transmission',
    '25': 'drivetrain', '26': 'drivetrain',
    '31': 'suspension', '32': 'steering', '33': 'suspension',
    '34': 'brake', '35': 'wheels', '36': 'wheels',
    '41': 'body', '51': 'body', '52': 'interior',
    '54': 'glass', '61': 'electrical', '62': 'electrical',
    '63': 'lighting', '64': 'hvac', '65': 'electronics',
    '66': 'electronics', '71': 'interior', '72': 'interior',
    '84': 'communication', '88': 'accessories',
  };
  return map[hgCode] || hgName?.toLowerCase() || 'other';
}

// ── OEM PostgreSQL Search Endpoints ──────────────────────────────────────────
// These query the separate OEM database (if connected via OEM_DATABASE_URL).
// The Bot-Service and Admin-Dashboard can call these for fuzzy OEM lookups.

import { searchOem, getOemDbStats } from './oemDb';

app.get('/api/oem/search', async (req: Request, res: Response) => {
  const q = (req.query.q as string || '').trim();
  if (q.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }
  const limit = Math.min(100, parseInt(req.query.limit as string || '25', 10));
  const results = await searchOem(q, limit);
  res.json({ query: q, results, count: results.length });
});

app.get('/api/oem/stats', async (_req: Request, res: Response) => {
  const stats = await getOemDbStats();
  if (!stats) {
    return res.json({ status: 'disconnected', message: 'OEM PostgreSQL not connected' });
  }
  res.json({ status: 'connected', ...stats });
});

export { app };
