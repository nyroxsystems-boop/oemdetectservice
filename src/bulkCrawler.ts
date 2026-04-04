/**
 * 🕷️ BULK CRAWLER — PartsLink24 Catalog Tree Traversal Engine
 *
 * TWO MODES:
 * 1. DISCOVER MODE: Click through all brands → discover models → create vehicles
 * 2. CRAWL MODE: For each vehicle, navigate catalog tree → extract all OEM numbers
 *
 * Navigation: Brand logo → Model selection → Catalog tree (HG → FG → Bildtafel → Teile)
 * No VINs needed — navigates entirely by clicking through the PL24 UI.
 *
 * Features:
 * - Resume after crash (per-node progress tracking)
 * - Low-priority queue (real-time lookups always preempt)
 * - Auto-pause on 3 consecutive errors or bot detection
 * - Per-node fresh page (resilient, no stale sessions)
 */

import { Page } from 'playwright';
import { logger } from './logger';
import { config } from './config';
import { enqueue } from './requestQueue';
import {
  ensureLoggedIn, navigateToVehicle, selectBrand, getContext, BRAND_MAP,
  assertNotBlocked, extractFromText, sleep, humanDelay, waitForStable, takeScreenshot,
} from './scraper';
import {
  BulkJob, BulkProgressEntry,
  getJob, updateJobStatus, getNextPendingNode, seedProgress,
  markNodeComplete, markNodeFailed, insertResults,
  incrementJobParts, incrementJobErrors, incrementJobCompletedHg,
  getNextQueuedJob, getJobProgress, upsertVehicle, listVehicles,
} from './bulkStore';
import { OemResult } from './cache';

// ── State ────────────────────────────────────────────────────────────────────

let bulkRunning = false;
let bulkPaused = false;
let currentJobId: number | null = null;
let consecutiveErrors = 0;

// ── Control Functions ────────────────────────────────────────────────────────

export function pauseBulk(): void {
  bulkPaused = true;
  logger.info('[BulkCrawler] Pause requested');
}

export function resumeBulk(): void {
  bulkPaused = false;
  logger.info('[BulkCrawler] Resume requested');
}

export function cancelBulk(): void {
  bulkPaused = true;
  bulkRunning = false;
  if (currentJobId) {
    updateJobStatus(currentJobId, 'paused', { last_error: 'Cancelled by admin' });
  }
  currentJobId = null;
  logger.info('[BulkCrawler] Cancel requested');
}

export function getBulkState(): {
  running: boolean; paused: boolean; currentJobId: number | null;
} {
  return { running: bulkRunning, paused: bulkPaused, currentJobId };
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCOVER MODE — Click through PL24 to find all brands & models
// ═══════════════════════════════════════════════════════════════════════════

export interface DiscoveredModel {
  brand: string;
  model: string;
  url?: string;
}

/**
 * Discovers all available brands and models from PartsLink24.
 * Clicks through each brand logo on the dashboard and extracts model lists.
 */
export async function discoverBrandsAndModels(): Promise<{
  brands: string[];
  models: DiscoveredModel[];
  errors: string[];
}> {
  const allModels: DiscoveredModel[] = [];
  const discoveredBrands: string[] = [];
  const errors: string[] = [];

  const brandsToDiscover = Object.keys(BRAND_MAP);
  logger.info(`[Discover] Starting discovery for ${brandsToDiscover.length} brands...`);

  for (const brandKey of brandsToDiscover) {
    if (bulkPaused) break;

    try {
      const models = await discoverModelsForBrand(brandKey);
      if (models.length > 0) {
        discoveredBrands.push(brandKey);
        allModels.push(...models);

        // Auto-create vehicle entries (without VINs — we don't need them)
        for (const m of models) {
          try {
            upsertVehicle({
              vin: `DISCOVER-${brandKey}-${m.model.replace(/\s+/g, '-').substring(0, 20)}`,
              brand: brandKey,
              model: m.model,
            });
          } catch { /* duplicate — fine */ }
        }

        logger.info(`[Discover] ${brandKey}: ${models.length} models found`);
      } else {
        logger.warn(`[Discover] ${brandKey}: no models found`);
      }
    } catch (err: any) {
      logger.error(`[Discover] ${brandKey} failed: ${err.message}`);
      errors.push(`${brandKey}: ${err.message}`);
    }

    await sleep(config.bulkDelayMs);
  }

  logger.info(`[Discover] Complete: ${discoveredBrands.length} brands, ${allModels.length} models`);
  return { brands: discoveredBrands, models: allModels, errors };
}

async function discoverModelsForBrand(brandKey: string): Promise<DiscoveredModel[]> {
  return enqueue(async () => {
    const ctx = getContext();
    if (!ctx) throw new Error('Browser not initialized');

    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    try {
      const loggedIn = await ensureLoggedIn(page);
      if (!loggedIn) throw new Error('Login failed');

      // Navigate to dashboard (ensure we're on the brand grid)
      await page.goto('https://www.partslink24.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForStable(page);
      await humanDelay(2000, 3000);

      // Click the brand logo
      const brandClicked = await selectBrand(page, brandKey);
      if (!brandClicked) {
        logger.warn(`[Discover] Brand "${brandKey}" not found on dashboard`);
        return [];
      }

      await humanDelay(3000, 5000);
      await assertNotBlocked(page, `discover-${brandKey}`);
      await takeScreenshot(page, `discover-${brandKey}`);

      // After clicking a brand, PL24 might show:
      // 1. A model selection list/grid
      // 2. A VIN input filtered to that brand
      // 3. A category/model browser
      // Extract whatever model/vehicle options are visible

      const models = await extractModelsFromPage(page, brandKey);
      return models;

    } finally {
      await page.close();
    }
  }, `discover-${brandKey}`, 'low');
}

async function extractModelsFromPage(page: Page, brand: string): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();

  try {
    const bodyText = await page.locator('body').innerText({ timeout: 10000 });
    const lines = bodyText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 3 || trimmed.length > 60) continue;

      // Skip navigation/UI text
      const skipPatterns = [
        /^(Login|Abmelden|Passwort|Benutzername|Firmenkennung)/i,
        /^(Herzlich|willkommen|Verwaltung|FAHRGESTELL)/i,
        /^(Startseite|Suche|Teile suchen|Händler)/i,
        /^\d{1,2}$/, // Single/double digit numbers
        /^(GO|OK|Ja|Nein)$/i,
      ];
      if (skipPatterns.some(p => p.test(trimmed))) continue;

      // Look for model-like entries
      // Models typically look like: "Golf", "3er", "A-Klasse", "Corolla", etc.
      // Or with details: "Golf VII (5G)", "3er (F30)", "C-Klasse (W205)"
      const modelMatch = trimmed.match(/^([A-Za-zÀ-ÿ0-9][\w\s\-/.()]{2,50})$/);
      if (modelMatch) {
        const model = modelMatch[1].trim();
        if (!seen.has(model.toLowerCase())) {
          seen.add(model.toLowerCase());
          models.push({ brand, model });
        }
      }
    }

    // Also try to find clickable model links
    const links = await page.locator('a, button, [role="button"], [role="link"], li, tr').all();
    for (const link of links.slice(0, 100)) {
      try {
        const text = await link.innerText({ timeout: 1000 });
        const trimmed = text.trim();
        if (trimmed.length >= 3 && trimmed.length <= 50 && !seen.has(trimmed.toLowerCase())) {
          // Check if it looks like a car model name
          if (/[A-Za-z]/.test(trimmed) && !/^(Login|Abmelden|Passwort|GO|Suche)/i.test(trimmed)) {
            const href = await link.getAttribute('href').catch(() => null);
            if (href && (href.includes('model') || href.includes('vehicle') || href.includes('pl24'))) {
              seen.add(trimmed.toLowerCase());
              models.push({ brand, model: trimmed, url: href });
            }
          }
        }
      } catch { /* skip */ }
    }
  } catch (err: any) {
    logger.warn(`[Discover] extractModelsFromPage failed for ${brand}`, { error: err.message });
  }

  return models;
}

// ═══════════════════════════════════════════════════════════════════════════
// CRAWL MODE — Navigate catalog tree for a vehicle/model
// ═══════════════════════════════════════════════════════════════════════════

export async function startCrawl(jobId: number): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  if (bulkRunning) {
    updateJobStatus(jobId, 'queued');
    logger.info(`[BulkCrawler] Job ${jobId} queued — another job is running`);
    return;
  }

  bulkRunning = true;
  bulkPaused = false;
  currentJobId = jobId;
  consecutiveErrors = 0;

  logger.info(`[BulkCrawler] Starting crawl for ${job.brand} ${job.model}`);
  updateJobStatus(jobId, 'running');

  try {
    await crawlVehicle(job);
  } catch (err: any) {
    logger.error(`[BulkCrawler] Fatal error in job ${jobId}`, { error: err.message });
    updateJobStatus(jobId, 'failed', { last_error: err.message });
  } finally {
    bulkRunning = false;
    currentJobId = null;

    const next = getNextQueuedJob();
    if (next) {
      logger.info(`[BulkCrawler] Auto-starting next queued job: ${next.id}`);
      startCrawl(next.id).catch(err => {
        logger.error(`[BulkCrawler] Failed to start next job`, { error: err.message });
      });
    }
  }
}

async function crawlVehicle(job: BulkJob): Promise<void> {
  const existingProgress = getJobProgress(job.id);

  if (existingProgress.total === 0) {
    // Fresh job — discover Hauptgruppen first
    logger.info(`[BulkCrawler] Discovering Hauptgruppen for ${job.brand} ${job.model}...`);

    const hauptgruppen = await discoverHauptgruppen(job);
    if (hauptgruppen.length === 0) {
      updateJobStatus(job.id, 'failed', { last_error: 'No Hauptgruppen found' });
      return;
    }

    seedProgress(job.id, hauptgruppen.map(hg => ({
      hg_code: hg.code,
      hg_name: hg.name,
    })));

    updateJobStatus(job.id, 'running', { total_hg: hauptgruppen.length });
    logger.info(`[BulkCrawler] Found ${hauptgruppen.length} Hauptgruppen`);
  } else {
    logger.info(`[BulkCrawler] Resuming job ${job.id} — ${existingProgress.pending} nodes pending`);
  }

  // Process tree nodes
  while (true) {
    if (bulkPaused) {
      updateJobStatus(job.id, 'paused');
      logger.info(`[BulkCrawler] Job ${job.id} paused`);
      return;
    }

    const node = getNextPendingNode(job.id);
    if (!node) {
      updateJobStatus(job.id, 'completed', {
        total_parts_found: (getJob(job.id)?.total_parts_found || 0),
      });
      logger.info(`[BulkCrawler] Job ${job.id} completed!`);
      return;
    }

    try {
      await processNode(job, node);
      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      logger.error(`[BulkCrawler] Node error (${consecutiveErrors}/${config.bulkMaxConsecutiveErrors})`, {
        hg: node.hg_code, fg: node.fg_code, error: err.message,
      });

      markNodeFailed(node.id, err.message);
      incrementJobErrors(job.id);

      if (consecutiveErrors >= config.bulkMaxConsecutiveErrors) {
        updateJobStatus(job.id, 'paused', {
          last_error: `${consecutiveErrors} consecutive errors — auto-paused. Last: ${err.message}`,
        });
        return;
      }
    }

    await sleep(config.bulkDelayMs);
  }
}

// ── Navigate to Vehicle (Brand click → Model select OR VIN) ──────────────

async function navigateToVehicleCatalog(page: Page, job: BulkJob): Promise<boolean> {
  // If we have a real VIN (not a discovery placeholder), use VIN navigation
  if (job.vin && !job.vin.startsWith('DISCOVER-')) {
    return navigateToVehicle(page, job.vin, job.brand);
  }

  // Otherwise: click brand → select model from PL24 UI
  logger.info(`[BulkCrawler] Navigating via brand click: ${job.brand} → ${job.model}`);

  // Go to dashboard
  await page.goto('https://www.partslink24.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForStable(page);
  await humanDelay(1500, 2500);

  // Click brand logo
  const brandClicked = await selectBrand(page, job.brand);
  if (!brandClicked) {
    throw new Error(`Brand "${job.brand}" not found on dashboard`);
  }
  await humanDelay(2000, 4000);

  // Try to find and click the model
  const modelClicked = await clickModelInList(page, job.model);
  if (!modelClicked) {
    // Fallback: try entering VIN if we have one
    logger.warn(`[BulkCrawler] Model "${job.model}" not found — trying alternative navigation`);

    // Try looking for any navigation that matches
    const fallbackClicked = await tryFallbackNavigation(page, job);
    if (!fallbackClicked) {
      throw new Error(`Could not navigate to ${job.brand} ${job.model}`);
    }
  }

  await humanDelay(2000, 4000);
  await assertNotBlocked(page, `navigate-${job.brand}-${job.model}`);

  // Wait for catalog to load
  try {
    await page.waitForURL(/\/pl24-app\//, { timeout: 30000 });
    logger.info(`[BulkCrawler] Catalog loaded: ${page.url()}`);
  } catch {
    // Maybe we're already in the catalog or the URL pattern is different
    logger.info(`[BulkCrawler] Current URL after navigation: ${page.url()}`);
  }

  // Wait for catalog content
  const catalogSignals = [
    'input[placeholder="Teile suchen"]',
    'text=Hauptgruppe',
    'text=Fahrzeugidentifikation',
  ];

  for (const sig of catalogSignals) {
    try {
      await page.locator(sig).first().waitFor({ state: 'visible', timeout: 10000 });
      logger.info(`[BulkCrawler] Catalog ready — signal: "${sig}"`);
      return true;
    } catch { /* try next */ }
  }

  // Take screenshot for debugging
  await takeScreenshot(page, `catalog-${job.brand}-${job.model}`);
  return true;
}

async function clickModelInList(page: Page, modelName: string): Promise<boolean> {
  // Try various selectors to find and click the model
  const searchTerms = [modelName];

  // Also try shorter versions: "Golf VII (5G)" → "Golf", "Golf VII"
  const parts = modelName.split(/[\s(]/);
  if (parts.length > 1) {
    searchTerms.push(parts[0]);
    searchTerms.push(`${parts[0]} ${parts[1]}`);
  }

  for (const term of searchTerms) {
    const selectors = [
      `a:has-text("${term}")`,
      `button:has-text("${term}")`,
      `[role="button"]:has-text("${term}")`,
      `li:has-text("${term}")`,
      `tr:has-text("${term}")`,
      `div:has-text("${term}")`,
      `text="${term}"`,
    ];

    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await el.click();
          await waitForStable(page);
          await humanDelay(1500, 3000);
          logger.info(`[BulkCrawler] Clicked model "${term}" via ${sel}`);
          return true;
        }
      } catch { /* try next */ }
    }
  }

  return false;
}

async function tryFallbackNavigation(page: Page, job: BulkJob): Promise<boolean> {
  // Fallback 1: Try clicking any visible model/vehicle link
  try {
    const allLinks = await page.locator('a').all();
    for (const link of allLinks.slice(0, 50)) {
      try {
        const text = await link.innerText({ timeout: 1000 });
        const href = await link.getAttribute('href');
        if (href && (href.includes('vehicle') || href.includes('model') || href.includes('pl24-app'))) {
          await link.click();
          await waitForStable(page);
          logger.info(`[BulkCrawler] Fallback: clicked link "${text.trim().substring(0, 30)}"`);
          return true;
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  // Fallback 2: If we have a VIN-like value, try VIN input
  if (job.vin && job.vin.length === 17 && !job.vin.startsWith('DISCOVER-')) {
    try {
      return await navigateToVehicle(page, job.vin, job.brand);
    } catch {
      return false;
    }
  }

  return false;
}

// ── Discover Hauptgruppen ────────────────────────────────────────────────────

async function discoverHauptgruppen(job: BulkJob): Promise<Array<{ code: string; name: string }>> {
  return enqueue(async () => {
    const ctx = getContext();
    if (!ctx) throw new Error('Browser not initialized');

    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    try {
      const loggedIn = await ensureLoggedIn(page);
      if (!loggedIn) throw new Error('Login failed');

      const navOk = await navigateToVehicleCatalog(page, job);
      if (!navOk) throw new Error('Failed to navigate to catalog');

      await assertNotBlocked(page, 'bulk-discover-hg');

      const hgs = await scrapeHauptgruppen(page);
      return hgs;
    } finally {
      await page.close();
    }
  }, `bulk-discover-hg-${job.id}`, 'low');
}

async function scrapeHauptgruppen(page: Page): Promise<Array<{ code: string; name: string }>> {
  const entries: Array<{ code: string; name: string }> = [];

  await humanDelay(2000, 3000);

  try {
    const bodyText = await page.locator('body').innerText({ timeout: 10000 });
    const lines = bodyText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // PL24 Hauptgruppe format: "11  Motor" or "34  Bremsen"
      const match = trimmed.match(/^(\d{2})\s{2,}(.+)/);
      if (match) {
        entries.push({ code: match[1], name: match[2].trim() });
      }
    }

    // Fallback: table rows
    if (entries.length === 0) {
      const rows = await page.locator('tr, [role="row"]').all();
      for (const row of rows) {
        try {
          const text = await row.innerText({ timeout: 2000 });
          const match = text.trim().match(/^(\d{2})\s+(.+)/);
          if (match && match[2].length > 2) {
            entries.push({ code: match[1], name: match[2].trim() });
          }
        } catch { /* skip */ }
      }
    }

    // Fallback: links
    if (entries.length === 0) {
      const links = await page.locator('a, div[class*="group"], div[class*="category"]').all();
      for (const link of links) {
        try {
          const text = await link.innerText({ timeout: 1000 });
          const match = text.trim().match(/^(\d{2})\s+(.{3,})/);
          if (match) {
            entries.push({ code: match[1], name: match[2].trim() });
          }
        } catch { /* skip */ }
      }
    }
  } catch (err: any) {
    logger.error('[BulkCrawler] Failed to extract Hauptgruppen', { error: err.message });
  }

  // Deduplicate
  const seen = new Set<string>();
  return entries.filter(e => {
    if (seen.has(e.code)) return false;
    seen.add(e.code);
    return true;
  });
}

// ── Process Single Node ──────────────────────────────────────────────────────

async function processNode(job: BulkJob, node: BulkProgressEntry): Promise<void> {
  const nodeLabel = `HG:${node.hg_code}${node.fg_code ? `/FG:${node.fg_code}` : ''}${node.bildtafel_id ? `/BT:${node.bildtafel_id}` : ''}`;

  logger.info(`[BulkCrawler] Processing ${nodeLabel}`);

  await enqueue(async () => {
    const ctx = getContext();
    if (!ctx) throw new Error('Browser not initialized');

    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    try {
      const loggedIn = await ensureLoggedIn(page);
      if (!loggedIn) throw new Error('Login failed');

      const navOk = await navigateToVehicleCatalog(page, job);
      if (!navOk) throw new Error('Failed to navigate to catalog');

      await assertNotBlocked(page, `bulk-${nodeLabel}`);

      if (node.hg_code && !node.fg_code && !node.bildtafel_id) {
        await processHgNode(page, job, node);
      } else if (node.fg_code && !node.bildtafel_id) {
        await processFgNode(page, job, node);
      } else if (node.bildtafel_id) {
        await processBildtafelNode(page, job, node);
      }

      updateJobStatus(job.id, 'running', {
        last_hg: node.hg_code,
        last_fg: node.fg_code || undefined,
        last_bildtafel: node.bildtafel_id || undefined,
      });

    } finally {
      await page.close();
    }
  }, `bulk-node-${nodeLabel}`, 'low');
}

// ── HG Node: Discover Fachgruppen ────────────────────────────────────────────

async function processHgNode(page: Page, job: BulkJob, node: BulkProgressEntry): Promise<void> {
  const clicked = await clickTreeItem(page, node.hg_code, node.hg_name);
  if (!clicked) {
    logger.warn(`[BulkCrawler] Could not click HG ${node.hg_code} — skipping`);
    markNodeComplete(node.id, 0);
    incrementJobCompletedHg(job.id);
    return;
  }

  await humanDelay(2000, 4000);
  await assertNotBlocked(page, `bulk-hg-${node.hg_code}`);

  const children = await scrapeTreeChildren(page);

  if (children.length > 0) {
    const areFgs = children.some(c => /^\d{2}$/.test(c.code));

    if (areFgs) {
      seedProgress(job.id, children.map(c => ({
        hg_code: node.hg_code,
        hg_name: node.hg_name || undefined,
        fg_code: c.code,
        fg_name: c.name,
      })));
    } else {
      seedProgress(job.id, children.map(c => ({
        hg_code: node.hg_code,
        hg_name: node.hg_name || undefined,
        bildtafel_id: c.code,
      })));
    }
  } else {
    // Extract parts directly from this page
    const parts = await extractPartsFromPage(page, job, node);
    if (parts.length > 0) {
      const inserted = insertResults(job.id, parts);
      incrementJobParts(job.id, inserted);
    }
  }

  markNodeComplete(node.id, children.length);
  incrementJobCompletedHg(job.id);
}

async function processFgNode(page: Page, job: BulkJob, node: BulkProgressEntry): Promise<void> {
  const hgClicked = await clickTreeItem(page, node.hg_code, node.hg_name);
  if (!hgClicked) { markNodeComplete(node.id, 0); return; }
  await humanDelay(1500, 3000);

  const fgClicked = await clickTreeItem(page, node.fg_code!, node.fg_name);
  if (!fgClicked) { markNodeComplete(node.id, 0); return; }
  await humanDelay(2000, 4000);
  await assertNotBlocked(page, `bulk-fg-${node.hg_code}-${node.fg_code}`);

  const children = await scrapeTreeChildren(page);

  if (children.length > 0) {
    seedProgress(job.id, children.map(c => ({
      hg_code: node.hg_code,
      hg_name: node.hg_name || undefined,
      fg_code: node.fg_code || undefined,
      fg_name: node.fg_name || undefined,
      bildtafel_id: c.code,
    })));
  } else {
    const parts = await extractPartsFromPage(page, job, node);
    if (parts.length > 0) {
      const inserted = insertResults(job.id, parts);
      incrementJobParts(job.id, inserted);
    }
  }

  markNodeComplete(node.id, children.length);
}

async function processBildtafelNode(page: Page, job: BulkJob, node: BulkProgressEntry): Promise<void> {
  const hgClicked = await clickTreeItem(page, node.hg_code, node.hg_name);
  if (!hgClicked) { markNodeComplete(node.id, 0); return; }
  await humanDelay(1500, 2500);

  if (node.fg_code) {
    const fgClicked = await clickTreeItem(page, node.fg_code, node.fg_name);
    if (!fgClicked) { markNodeComplete(node.id, 0); return; }
    await humanDelay(1500, 2500);
  }

  const btClicked = await clickTreeItem(page, node.bildtafel_id!, null);
  if (!btClicked) { markNodeComplete(node.id, 0); return; }
  await humanDelay(2000, 4000);
  await assertNotBlocked(page, `bulk-bt-${node.bildtafel_id}`);

  const parts = await extractPartsFromPage(page, job, node);
  const inserted = parts.length > 0 ? insertResults(job.id, parts) : 0;

  if (inserted > 0) {
    incrementJobParts(job.id, inserted);
  }

  markNodeComplete(node.id, inserted);
  logger.info(`[BulkCrawler] Bildtafel ${node.bildtafel_id}: ${inserted} parts`);
}

// ── Tree Navigation Helpers ──────────────────────────────────────────────────

async function clickTreeItem(page: Page, code: string, name: string | null): Promise<boolean> {
  const selectors = [
    `text="${code}"`,
    `a:has-text("${code}")`,
    `td:has-text("${code}")`,
    `div:has-text("${code}")`,
    `tr:has-text("${code}")`,
    `[role="row"]:has-text("${code}")`,
    `li:has-text("${code}")`,
  ];

  if (name) {
    selectors.push(`text="${name}"`);
    selectors.push(`a:has-text("${name}")`);
  }

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        await el.click();
        await waitForStable(page);
        return true;
      }
    } catch { /* try next */ }
  }

  logger.warn(`[BulkCrawler] Could not click: code="${code}" name="${name}"`);
  return false;
}

async function scrapeTreeChildren(page: Page): Promise<Array<{ code: string; name: string }>> {
  const entries: Array<{ code: string; name: string }> = [];

  try {
    await humanDelay(1000, 2000);
    const bodyText = await page.locator('body').innerText({ timeout: 8000 });

    const lines = bodyText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();

      let match = trimmed.match(/^(\d{2})\s{2,}(.{3,})/);
      if (match) {
        entries.push({ code: match[1], name: match[2].trim() });
        continue;
      }

      match = trimmed.match(/^(\d{2}_\d{4})\s+(.+)/);
      if (match) {
        entries.push({ code: match[1], name: match[2].trim() });
      }
    }
  } catch (err: any) {
    logger.warn('[BulkCrawler] Failed to extract tree children', { error: err.message });
  }

  const seen = new Set<string>();
  return entries.filter(e => {
    if (seen.has(e.code)) return false;
    seen.add(e.code);
    return true;
  });
}

// ── Parts Extraction ─────────────────────────────────────────────────────────

async function extractPartsFromPage(
  page: Page, job: BulkJob, node: BulkProgressEntry
): Promise<Array<{
  vin: string; brand: string; model: string;
  oem: string; description?: string; bildtafel?: string;
  hg_code?: string; hg_name?: string; fg_code?: string; fg_name?: string;
}>> {
  try {
    const bodyText = await page.locator('body').innerText({ timeout: 8000 });
    const rawResults: OemResult[] = extractFromText(bodyText);

    return rawResults.map(r => ({
      vin: job.vin,
      brand: job.brand,
      model: job.model,
      oem: r.oem,
      description: r.description,
      bildtafel: r.bildtafel || node.bildtafel_id || undefined,
      hg_code: r.hg || node.hg_code,
      hg_name: node.hg_name || undefined,
      fg_code: r.fg || node.fg_code || undefined,
      fg_name: node.fg_name || undefined,
    }));
  } catch (err: any) {
    logger.warn('[BulkCrawler] Parts extraction failed', { error: err.message });
    return [];
  }
}
