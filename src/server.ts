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
import {
  listVehicles, getVehicle, upsertVehicle, updateVehicle, deleteVehicle,
  createJob, getJob, getActiveJob, listJobs, updateJobStatus,
  getResults, getAllResultsForExport, getBulkStats, getJobProgress,
} from './bulkStore';
import { startCrawl, pauseBulk, resumeBulk, cancelBulk, getBulkState, discoverBrandsAndModels, crawlSingleBrand } from './bulkCrawler';
import { crawlBrandViaApi, getApiState, cancelApi } from './apiCrawler';
import { PL24_SERVICE_MAP } from './scraper';
import { seedAllVins, getVinCount } from './vinSeeder';

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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
      }).catch(err => {
        logger.error(`❌ API crawl failed: ${brand}`, { error: err.message });
      });
    } else {
      // 🌐 Browser mode — original Playwright UI scraping
      crawlSingleBrand(brand).then(result => {
        logger.info(`🏁 Browser crawl complete: ${brand}`, result);
      }).catch(err => {
        logger.error(`❌ Browser crawl failed: ${brand}`, { error: err.message });
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bulk/vehicles/seed', (_req: Request, res: Response) => {
  try {
    const result = seedAllVins();
    res.json({
      success: true,
      ...result,
      availableVins: getVinCount(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    startCrawl(job.id).catch(err => {
      logger.error('Crawl failed', { jobId: job.id, error: err.message });
    });
    res.json({ success: true, jobId: job.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
      } catch (err: any) {
        logger.error(`❌ Brand ${brand} failed: ${err.message}`);
      }
    }
    logger.info('🏁 All brands complete!');
  })().catch(err => logger.error('Start-all failed', { error: err.message }));
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
  startCrawl(id).catch(err => {
    logger.error('Resume crawl failed', { jobId: id, error: err.message });
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
        const resp = await fetch(`${config.wwsBotUrl}/api/admin/oem-database/bulk-import`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Token ${config.adminToken}`,
          },
          body: JSON.stringify({ records: batch, source: 'partslink24-bulk' }),
        });

        if (resp.ok) {
          const data = await resp.json() as any;
          exported += data.imported || batch.length;
        } else {
          errors += batch.length;
          logger.error(`Export batch failed: ${resp.status}`, { batch: i / batchSize });
        }
      } catch (err: any) {
        errors += batch.length;
        logger.error('Export batch error', { error: err.message });
      }
    }

    res.json({
      success: true,
      total: records.length,
      exported,
      errors,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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

export { app };
