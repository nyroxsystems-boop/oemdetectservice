/**
 * 🕷️ BULK CRAWLER — PartsLink24 Catalog Tree Traversal Engine
 *
 * Crawls the full PL24 catalog tree for a vehicle:
 *   Hauptgruppen (HG) → Fachgruppen (FG) → Bildtafeln → Teile (OEM numbers)
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
  ensureLoggedIn, navigateToVehicle, getContext,
  assertNotBlocked, extractFromText, sleep, humanDelay, waitForStable,
} from './scraper';
import {
  BulkJob, BulkProgressEntry,
  getJob, updateJobStatus, getNextPendingNode, seedProgress,
  markNodeComplete, markNodeFailed, insertResults,
  incrementJobParts, incrementJobErrors, incrementJobCompletedHg,
  getNextQueuedJob, getJobProgress,
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

// ── Main Entry Point ─────────────────────────────────────────────────────────

export async function startCrawl(jobId: number): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  if (bulkRunning) {
    // Queue this job instead
    updateJobStatus(jobId, 'queued');
    logger.info(`[BulkCrawler] Job ${jobId} queued — another job is running`);
    return;
  }

  bulkRunning = true;
  bulkPaused = false;
  currentJobId = jobId;
  consecutiveErrors = 0;

  logger.info(`[BulkCrawler] Starting crawl for ${job.brand} ${job.model} (VIN: ${job.vin})`);
  updateJobStatus(jobId, 'running');

  try {
    await crawlVehicle(job);
  } catch (err: any) {
    logger.error(`[BulkCrawler] Fatal error in job ${jobId}`, { error: err.message });
    updateJobStatus(jobId, 'failed', { last_error: err.message });
  } finally {
    bulkRunning = false;
    currentJobId = null;

    // Start next queued job if any
    const next = getNextQueuedJob();
    if (next) {
      logger.info(`[BulkCrawler] Auto-starting next queued job: ${next.id}`);
      startCrawl(next.id).catch(err => {
        logger.error(`[BulkCrawler] Failed to start next job`, { error: err.message });
      });
    }
  }
}

// ── Crawl Logic ──────────────────────────────────────────────────────────────

async function crawlVehicle(job: BulkJob): Promise<void> {
  // Phase 1: Check if we already have progress entries (resume case)
  const existingProgress = getJobProgress(job.id);

  if (existingProgress.total === 0) {
    // Fresh job — discover Hauptgruppen first
    logger.info(`[BulkCrawler] Phase 1: Discovering Hauptgruppen for ${job.vin}...`);

    const hauptgruppen = await discoverHauptgruppen(job);
    if (hauptgruppen.length === 0) {
      updateJobStatus(job.id, 'failed', { last_error: 'No Hauptgruppen found — VIN may be invalid' });
      return;
    }

    // Seed progress entries for each HG
    seedProgress(job.id, hauptgruppen.map(hg => ({
      hg_code: hg.code,
      hg_name: hg.name,
    })));

    updateJobStatus(job.id, 'running', { total_hg: hauptgruppen.length });
    logger.info(`[BulkCrawler] Found ${hauptgruppen.length} Hauptgruppen`);
  } else {
    logger.info(`[BulkCrawler] Resuming job ${job.id} — ${existingProgress.pending} nodes pending`);
  }

  // Phase 2: Process tree nodes one by one
  while (true) {
    // Check pause/cancel
    if (bulkPaused) {
      updateJobStatus(job.id, 'paused');
      logger.info(`[BulkCrawler] Job ${job.id} paused`);
      return;
    }

    const node = getNextPendingNode(job.id);
    if (!node) {
      // All nodes processed
      const progress = getJobProgress(job.id);
      updateJobStatus(job.id, 'completed', {
        total_parts_found: (getJob(job.id)?.total_parts_found || 0),
      });
      logger.info(`[BulkCrawler] Job ${job.id} completed! ${progress.completed} nodes, ${getJob(job.id)?.total_parts_found || 0} parts found`);
      return;
    }

    try {
      await processNode(job, node);
      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      logger.error(`[BulkCrawler] Node error (${consecutiveErrors}/${config.bulkMaxConsecutiveErrors})`, {
        hg: node.hg_code, fg: node.fg_code, bildtafel: node.bildtafel_id,
        error: err.message,
      });

      markNodeFailed(node.id, err.message);
      incrementJobErrors(job.id);

      if (consecutiveErrors >= config.bulkMaxConsecutiveErrors) {
        updateJobStatus(job.id, 'paused', {
          last_error: `${consecutiveErrors} consecutive errors — auto-paused. Last: ${err.message}`,
        });
        logger.warn(`[BulkCrawler] Auto-paused after ${consecutiveErrors} consecutive errors`);
        return;
      }
    }

    // Rate limit between nodes
    await sleep(config.bulkDelayMs);
  }
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

      const vehicleFound = await navigateToVehicle(page, job.vin, job.brand);
      if (!vehicleFound) throw new Error('Vehicle identification failed');

      await assertNotBlocked(page, 'bulk-discover-hg');

      // Extract Hauptgruppen from the catalog page
      const hgs = await scrapeHauptgruppen(page);
      return hgs;
    } finally {
      await page.close();
    }
  }, `bulk-discover-hg-${job.id}`, 'low');
}

async function scrapeHauptgruppen(page: Page): Promise<Array<{ code: string; name: string }>> {
  const entries: Array<{ code: string; name: string }> = [];

  // Wait for catalog content to load
  await humanDelay(2000, 3000);

  try {
    const bodyText = await page.locator('body').innerText({ timeout: 10000 });
    const lines = bodyText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // PL24 Hauptgruppe format: "11  Motor" or "34  Bremsen" etc.
      const match = trimmed.match(/^(\d{2})\s{2,}(.+)/);
      if (match) {
        entries.push({ code: match[1], name: match[2].trim() });
      }
    }

    // Fallback: try table rows
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

    // Fallback: look for links/elements containing 2-digit codes
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
      // Step 1: Login + Navigate to vehicle
      const loggedIn = await ensureLoggedIn(page);
      if (!loggedIn) throw new Error('Login failed');

      const vehicleFound = await navigateToVehicle(page, job.vin, job.brand);
      if (!vehicleFound) throw new Error('Vehicle not found');

      await assertNotBlocked(page, `bulk-${nodeLabel}`);

      // Step 2: Navigate to the tree position
      if (node.hg_code && !node.fg_code && !node.bildtafel_id) {
        // HG level: click into HG, discover children (FGs or Bildtafeln)
        await processHgNode(page, job, node);
      } else if (node.fg_code && !node.bildtafel_id) {
        // FG level: click into HG then FG, discover Bildtafeln
        await processFgNode(page, job, node);
      } else if (node.bildtafel_id) {
        // Bildtafel level: navigate to it, extract all parts
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
    // Try using the search as fallback to at least get some results
    logger.warn(`[BulkCrawler] Could not click HG ${node.hg_code} — marking completed`);
    markNodeComplete(node.id, 0);
    incrementJobCompletedHg(job.id);
    return;
  }

  await humanDelay(2000, 4000);
  await assertNotBlocked(page, `bulk-hg-${node.hg_code}`);

  // Try to find child items (FGs or Bildtafeln)
  const children = await scrapeTreeChildren(page);

  if (children.length > 0) {
    // Check if children look like FGs (2-digit codes) or Bildtafeln (longer IDs)
    const areFgs = children.some(c => /^\d{2}$/.test(c.code));

    if (areFgs) {
      seedProgress(job.id, children.map(c => ({
        hg_code: node.hg_code,
        hg_name: node.hg_name || undefined,
        fg_code: c.code,
        fg_name: c.name,
      })));
      logger.info(`[BulkCrawler] HG ${node.hg_code}: ${children.length} Fachgruppen found`);
    } else {
      // These are Bildtafeln directly under the HG
      seedProgress(job.id, children.map(c => ({
        hg_code: node.hg_code,
        hg_name: node.hg_name || undefined,
        bildtafel_id: c.code,
      })));
      logger.info(`[BulkCrawler] HG ${node.hg_code}: ${children.length} Bildtafeln found (no FG level)`);
    }
  } else {
    // No children — try to extract parts directly from this page
    const parts = await extractPartsFromPage(page, job, node);
    if (parts.length > 0) {
      const inserted = insertResults(job.id, parts);
      incrementJobParts(job.id, inserted);
      logger.info(`[BulkCrawler] HG ${node.hg_code}: ${inserted} parts extracted directly`);
    }
  }

  markNodeComplete(node.id, children.length);
  incrementJobCompletedHg(job.id);
}

// ── FG Node: Discover Bildtafeln ─────────────────────────────────────────────

async function processFgNode(page: Page, job: BulkJob, node: BulkProgressEntry): Promise<void> {
  // Navigate: HG → FG
  const hgClicked = await clickTreeItem(page, node.hg_code, node.hg_name);
  if (!hgClicked) {
    markNodeComplete(node.id, 0);
    return;
  }
  await humanDelay(1500, 3000);

  const fgClicked = await clickTreeItem(page, node.fg_code!, node.fg_name);
  if (!fgClicked) {
    markNodeComplete(node.id, 0);
    return;
  }
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
    logger.info(`[BulkCrawler] FG ${node.hg_code}/${node.fg_code}: ${children.length} Bildtafeln`);
  } else {
    // Extract parts directly
    const parts = await extractPartsFromPage(page, job, node);
    if (parts.length > 0) {
      const inserted = insertResults(job.id, parts);
      incrementJobParts(job.id, inserted);
    }
  }

  markNodeComplete(node.id, children.length);
}

// ── Bildtafel Node: Extract Parts ────────────────────────────────────────────

async function processBildtafelNode(page: Page, job: BulkJob, node: BulkProgressEntry): Promise<void> {
  // Navigate: HG → FG (if exists) → Bildtafel
  const hgClicked = await clickTreeItem(page, node.hg_code, node.hg_name);
  if (!hgClicked) {
    markNodeComplete(node.id, 0);
    return;
  }
  await humanDelay(1500, 2500);

  if (node.fg_code) {
    const fgClicked = await clickTreeItem(page, node.fg_code, node.fg_name);
    if (!fgClicked) {
      markNodeComplete(node.id, 0);
      return;
    }
    await humanDelay(1500, 2500);
  }

  // Click the Bildtafel
  const btClicked = await clickTreeItem(page, node.bildtafel_id!, null);
  if (!btClicked) {
    markNodeComplete(node.id, 0);
    return;
  }
  await humanDelay(2000, 4000);
  await assertNotBlocked(page, `bulk-bt-${node.bildtafel_id}`);

  // Extract all parts from the Bildtafel page
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
  // Strategy 1: Click element containing the code text
  const selectors = [
    `text="${code}"`,
    `a:has-text("${code}")`,
    `td:has-text("${code}")`,
    `div:has-text("${code}")`,
    `tr:has-text("${code}")`,
    `[role="row"]:has-text("${code}")`,
    `li:has-text("${code}")`,
  ];

  // Also try with name if available
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

  logger.warn(`[BulkCrawler] Could not click tree item: code="${code}" name="${name}"`);
  return false;
}

async function scrapeTreeChildren(page: Page): Promise<Array<{ code: string; name: string }>> {
  const entries: Array<{ code: string; name: string }> = [];

  try {
    await humanDelay(1000, 2000);
    const bodyText = await page.locator('body').innerText({ timeout: 8000 });

    // Look for patterns like "01  Motorgehäuse" or "11_0978  Ölversorgung"
    const lines = bodyText.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();

      // Match: 2-digit code + whitespace + name
      let match = trimmed.match(/^(\d{2})\s{2,}(.{3,})/);
      if (match) {
        entries.push({ code: match[1], name: match[2].trim() });
        continue;
      }

      // Match: Bildtafel-style codes like "11_0978" or "02_0057"
      match = trimmed.match(/^(\d{2}_\d{4})\s+(.+)/);
      if (match) {
        entries.push({ code: match[1], name: match[2].trim() });
      }
    }
  } catch (err: any) {
    logger.warn('[BulkCrawler] Failed to extract tree children', { error: err.message });
  }

  // Deduplicate
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
