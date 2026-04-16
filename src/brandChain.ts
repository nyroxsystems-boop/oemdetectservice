/**
 * 🔗 BRAND CHAIN — Sequential multi-brand auto-continue runner
 *
 * When the user clicks "Marke crawlen" on a brand (e.g. VW) with auto-continue
 * enabled, this module takes over: it starts at the chosen brand and iterates
 * through the remaining brands in PL24_SERVICE_MAP, running one at a time.
 *
 * Lives as module-level state (consistent with bulkCrawler.ts and apiCrawler.ts).
 * Does NOT persist across process restarts — recoverRunningJobs() marks any
 * running jobs as paused on startup, so a crashed chain simply stops.
 */
import { logger } from './logger';
import { PL24_SERVICE_MAP } from './scraper';
import { crawlBrandViaApi, getApiState, pauseApi, resumeApi, cancelApi } from './apiCrawler';
import { crawlSingleBrand, getBulkState, pauseBulk, resumeBulk, cancelBulk } from './bulkCrawler';
import { flushExportBuffer } from './bulkStore';

// ── Types ────────────────────────────────────────────────────────────────────

export type ChainMode = 'api' | 'browser';

export interface ChainError {
  brand: string;
  message: string;
  at: string;
}

export interface ChainState {
  active: boolean;
  paused: boolean;
  cancelled: boolean;
  mode: ChainMode;
  brands: string[];            // full ordered queue, starting at user's chosen brand
  currentIndex: number;        // -1 before start, brands.length when done
  currentBrand: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastCompletedBrand: string | null;
  completedBrands: string[];
  errors: ChainError[];
  // Aggregate stats across the entire chain
  totalOemsAllBrands: number;
  totalModelsAllBrands: number;
}

// ── Module State ─────────────────────────────────────────────────────────────

const state: ChainState = {
  active: false,
  paused: false,
  cancelled: false,
  mode: 'api',
  brands: [],
  currentIndex: -1,
  currentBrand: null,
  startedAt: null,
  finishedAt: null,
  lastCompletedBrand: null,
  completedBrands: [],
  errors: [],
  totalOemsAllBrands: 0,
  totalModelsAllBrands: 0,
};

// ── Public API ───────────────────────────────────────────────────────────────

export function getChainState(): ChainState {
  // Shallow clone to avoid outside callers mutating our state
  return {
    ...state,
    brands: [...state.brands],
    completedBrands: [...state.completedBrands],
    errors: [...state.errors],
  };
}

export function isChainActive(): boolean {
  return state.active;
}

export function pauseChain(): void {
  if (!state.active) return;
  state.paused = true;
  // Also pause the underlying crawler so the current brand halts mid-run
  if (state.mode === 'api') {
    pauseApi();
  } else {
    pauseBulk();
  }
  logger.info('⏸ [Chain] Paused');
}

export function resumeChain(): void {
  if (!state.active) return;
  state.paused = false;
  if (state.mode === 'api') {
    resumeApi();
  } else {
    resumeBulk();
  }
  logger.info('▶ [Chain] Resumed');
}

export function cancelChain(): void {
  if (!state.active) return;
  state.cancelled = true;
  state.paused = false;
  // Cancel both underlying crawlers — only the active one will actually do anything
  cancelApi();
  cancelBulk();
  logger.info('🛑 [Chain] Cancelled');
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Start a brand chain beginning at `startBrand` and running through all
 * subsequent brands in PL24_SERVICE_MAP. Fire-and-forget — returns immediately
 * after preparing state; the actual crawling runs async.
 *
 * Throws if a chain or any single-brand crawl is already running.
 */
export async function startBrandChain(startBrand: string, mode: ChainMode = 'api'): Promise<void> {
  if (state.active) {
    throw new Error(`Chain already running (${state.currentBrand || state.brands[state.currentIndex]})`);
  }
  const apiSt = getApiState();
  const bulkSt = getBulkState();
  if (apiSt.running || bulkSt.running) {
    throw new Error('Another crawl is already running — cancel it before starting a chain');
  }

  const allBrands = Object.keys(PL24_SERVICE_MAP);
  const upper = startBrand.toUpperCase();
  const startIdx = allBrands.findIndex(b => b === upper);
  if (startIdx === -1) {
    throw new Error(`Unknown start brand "${startBrand}". Valid: ${allBrands.join(', ')}`);
  }

  const queue = allBrands.slice(startIdx);

  // Initialize state
  state.active = true;
  state.paused = false;
  state.cancelled = false;
  state.mode = mode;
  state.brands = queue;
  state.currentIndex = -1;
  state.currentBrand = null;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.lastCompletedBrand = null;
  state.completedBrands = [];
  state.errors = [];
  state.totalOemsAllBrands = 0;
  state.totalModelsAllBrands = 0;

  logger.info(`\n${'▓'.repeat(60)}`);
  logger.info(`🔗 BRAND CHAIN STARTED — ${queue.length} brands`);
  logger.info(`   Mode: ${mode}`);
  logger.info(`   Queue: ${queue.join(' → ')}`);
  logger.info(`${'▓'.repeat(60)}\n`);

  // Run async — caller returns immediately
  runChain().catch(err => {
    logger.error('🔗 [Chain] Fatal error in runner', { error: err?.message });
    state.active = false;
    state.finishedAt = new Date().toISOString();
  });
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function runChain(): Promise<void> {
  try {
    for (let i = 0; i < state.brands.length; i++) {
      if (state.cancelled) {
        logger.info(`🔗 [Chain] Cancelled — stopping at index ${i} of ${state.brands.length}`);
        break;
      }

      // Wait out any pause between brands (so pause takes effect even if the
      // current brand finished before the user unpaused)
      while (state.paused && !state.cancelled) {
        await sleep(1000);
      }
      if (state.cancelled) break;

      const brand = state.brands[i];
      state.currentIndex = i;
      state.currentBrand = brand;

      logger.info(`\n${'▒'.repeat(60)}`);
      logger.info(`🔗 [Chain] ${i + 1}/${state.brands.length} — starting ${brand}`);
      logger.info(`${'▒'.repeat(60)}`);

      try {
        let result: { brand: string; modelsFound: number; totalOems: number; errors: string[] };
        if (state.mode === 'api') {
          result = await crawlBrandViaApi(brand);
        } else {
          result = await crawlSingleBrand(brand);
        }

        state.totalOemsAllBrands += result.totalOems;
        state.totalModelsAllBrands += result.modelsFound;
        state.lastCompletedBrand = brand;
        state.completedBrands.push(brand);

        // Accumulate per-brand errors into the chain log (first few only)
        for (const e of result.errors.slice(0, 10)) {
          state.errors.push({ brand, message: e, at: new Date().toISOString() });
        }

        // Flush buffered exports before moving to next brand
        flushExportBuffer();

        logger.info(`🔗 [Chain] ✅ ${brand} done — ${result.totalOems} OEMs, ${result.modelsFound} models, ${result.errors.length} errors`);
      } catch (err: unknown) {
        const msg = err?.message || String(err);
        state.errors.push({ brand, message: msg, at: new Date().toISOString() });
        logger.error(`🔗 [Chain] ❌ ${brand} failed: ${msg}`);
        // Do NOT break — continue with the next brand
      }

      // Breather between brands — let rate limits cool down fully
      if (!state.cancelled && i < state.brands.length - 1) {
        await sleep(5000);
      }
    }
  } finally {
    flushExportBuffer();
    state.active = false;
    state.currentIndex = state.brands.length;
    state.currentBrand = null;
    state.finishedAt = new Date().toISOString();
    logger.info(`\n${'▓'.repeat(60)}`);
    logger.info(`🔗 BRAND CHAIN FINISHED`);
    logger.info(`   Completed: ${state.completedBrands.length}/${state.brands.length} brands`);
    logger.info(`   Total OEMs: ${state.totalOemsAllBrands.toLocaleString()}`);
    logger.info(`   Errors: ${state.errors.length}`);
    logger.info(`${'▓'.repeat(60)}\n`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
