/**
 * 🕷️ BULK CRAWLER — PartsLink24 Catalog Tree Traversal Engine
 *
 * Exact PL24 SPA navigation flow (verified from screenshots April 2026):
 *
 * 1. Dashboard → Click brand logo (Audi, BMW, VW...)
 * 2. SPA Table with multi-column drill-down:
 *    Modell → Modelljahr → Einschränkung I → II → III
 * 3. Hauptgruppe page (SINGLE digit: 1-9, 0):
 *    1 Motor | 2 Kraftstoff,Abgas,Kühlung | 3 Getriebe | ...
 * 4. Bildtafel list (format XXX-YYY):
 *    Untergruppe | Bildtafel | Benennung | Bemerkung | Modellangabe
 * 5. Parts page with OEM numbers:
 *    Pos. | Teilenummer | Benennung | Bemerkung | Stk. | Modellangabe
 *
 * No VINs needed — navigates entirely by clicking through PL24 UI.
 */

import { Page } from 'playwright';
import { logger } from './logger';
import { config } from './config';
import { enqueue } from './requestQueue';
import {
  ensureLoggedIn, selectBrand, getContext, BRAND_MAP,
  assertNotBlocked, sleep, humanDelay, waitForStable, takeScreenshot,
} from './scraper';
import {
  BulkJob, BulkProgressEntry,
  getJob, updateJobStatus, getNextPendingNode, seedProgress,
  markNodeComplete, markNodeFailed, insertResults,
  incrementJobParts, incrementJobErrors, incrementJobCompletedHg,
  getNextQueuedJob, getJobProgress, upsertVehicle,
} from './bulkStore';

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
// DISCOVER MODE — Click through brands → discover models from PL24 table
// ═══════════════════════════════════════════════════════════════════════════

export interface DiscoveredModel {
  brand: string;
  model: string;
}

/**
 * Discover all brands & models from PL24.
 * Clicks each brand logo → reads the "Modell" column from the SPA table.
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

        for (const m of models) {
          try {
            upsertVehicle({
              vin: `PL24-${brandKey}-${m.model.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30)}`,
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

      // Go to dashboard
      await page.goto('https://www.partslink24.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForStable(page);
      await humanDelay(2000, 3000);

      // Click brand logo
      const brandClicked = await selectBrand(page, brandKey);
      if (!brandClicked) return [];

      // Wait for SPA table to load with "Modell" column
      await humanDelay(3000, 5000);
      await assertNotBlocked(page, `discover-${brandKey}`);

      // Wait for the model table
      try {
        await page.locator('text=Modell').first().waitFor({ state: 'visible', timeout: 15000 });
      } catch {
        logger.warn(`[Discover] ${brandKey}: "Modell" column not found`);
        await takeScreenshot(page, `discover-${brandKey}-no-table`);
        return [];
      }

      // Extract model names from the first column of the SPA table
      // PL24 SPA: Table with "Modell" header, rows are clickable text entries
      const models = await extractColumnEntries(page, 0);

      return models.map(name => ({ brand: brandKey, model: name }));

    } finally {
      await page.close();
    }
  }, `discover-${brandKey}`, 'low');
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
    // Fresh job — need to discover all Modelljahr × Einschränkung × HG × Bildtafel combinations
    // Step 1: Navigate to model, get all years
    logger.info(`[BulkCrawler] Phase 1: Discovering catalog structure for ${job.brand} ${job.model}...`);

    const structure = await discoverCatalogStructure(job);
    if (structure.length === 0) {
      updateJobStatus(job.id, 'failed', { last_error: 'No catalog entries found' });
      return;
    }

    // Seed all Bildtafel entries as progress nodes
    seedProgress(job.id, structure);
    updateJobStatus(job.id, 'running', { total_hg: structure.length });
    logger.info(`[BulkCrawler] Seeded ${structure.length} Bildtafel nodes to process`);
  } else {
    logger.info(`[BulkCrawler] Resuming job ${job.id} — ${existingProgress.pending} nodes pending`);
  }

  // Phase 2: Process each Bildtafel node
  while (true) {
    if (bulkPaused) {
      updateJobStatus(job.id, 'paused');
      logger.info(`[BulkCrawler] Job ${job.id} paused`);
      return;
    }

    const node = getNextPendingNode(job.id);
    if (!node) {
      updateJobStatus(job.id, 'completed');
      logger.info(`[BulkCrawler] Job ${job.id} completed! Parts: ${getJob(job.id)?.total_parts_found || 0}`);
      return;
    }

    try {
      await processNode(job, node);
      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      logger.error(`[BulkCrawler] Node error (${consecutiveErrors}/${config.bulkMaxConsecutiveErrors})`, {
        node: `${node.hg_code}/${node.fg_code}/${node.bildtafel_id}`, error: err.message,
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

// ── Discover Catalog Structure ───────────────────────────────────────────────
// Navigate: Brand → Model → get all Years → for each Year, get Einschränkungen →
// for each path, get HG list → for each HG, get Bildtafel list

async function discoverCatalogStructure(job: BulkJob): Promise<Array<{
  hg_code: string; hg_name?: string; fg_code?: string; fg_name?: string; bildtafel_id?: string;
}>> {
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

      // Navigate to brand
      await page.goto('https://www.partslink24.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await waitForStable(page);
      await humanDelay(2000, 3000);

      const brandClicked = await selectBrand(page, job.brand);
      if (!brandClicked) throw new Error(`Brand ${job.brand} not found`);
      await humanDelay(3000, 5000);

      // Wait for model table
      await page.locator('text=Modell').first().waitFor({ state: 'visible', timeout: 15000 });

      // Click model in the table
      const modelClicked = await clickTableEntry(page, job.model);
      if (!modelClicked) throw new Error(`Model "${job.model}" not found in table`);
      await humanDelay(2000, 3000);

      // Get all years from the Modelljahr column
      const years = await extractColumnEntries(page, 1);
      logger.info(`[BulkCrawler] ${job.model}: ${years.length} years found`);

      if (years.length === 0) {
        // Maybe we jumped directly to HG (no year selection needed)
        return await extractHgAndBildtafeln(page, job);
      }

      // For now, pick the most recent year to start (we can expand later)
      // Sort years descending, take the first one
      const sortedYears = years.sort((a, b) => parseInt(b) - parseInt(a));
      const targetYear = sortedYears[0];

      logger.info(`[BulkCrawler] Using year ${targetYear} for ${job.model}`);

      // Click the year
      const yearClicked = await clickTableEntry(page, targetYear);
      if (!yearClicked) throw new Error(`Year "${targetYear}" not found`);
      await humanDelay(2000, 3000);

      // Check for Einschränkung columns
      const einschraenkungen = await extractColumnEntries(page, 2);
      if (einschraenkungen.length > 0) {
        logger.info(`[BulkCrawler] Einschränkungen: ${einschraenkungen.join(', ')}`);
        // Click first Einschränkung (e.g. "Frontantrieb")
        await clickTableEntry(page, einschraenkungen[0]);
        await humanDelay(2000, 3000);

        // Check for further Einschränkung II
        const einschr2 = await extractColumnEntries(page, 3);
        if (einschr2.length > 0) {
          await clickTableEntry(page, einschr2[0]);
          await humanDelay(2000, 3000);
        }
      }

      // Now we should be at the Hauptgruppe page
      return await extractHgAndBildtafeln(page, job);

    } finally {
      await page.close();
    }
  }, `discover-structure-${job.id}`, 'low');
}

/**
 * Extract HG list from the Hauptgruppe page, then for each HG click into it
 * and extract all Bildtafel entries. Returns flat list of all Bildtafel nodes.
 */
async function extractHgAndBildtafeln(page: Page, job: BulkJob): Promise<Array<{
  hg_code: string; hg_name?: string; fg_code?: string; fg_name?: string; bildtafel_id?: string;
}>> {
  const allNodes: Array<{
    hg_code: string; hg_name?: string; fg_code?: string; fg_name?: string; bildtafel_id?: string;
  }> = [];

  // Wait for Hauptgruppe table
  try {
    await page.locator('text=Hauptgruppe').first().waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    logger.warn('[BulkCrawler] Hauptgruppe header not visible');
    await takeScreenshot(page, `no-hg-${job.brand}-${job.model}`);
    return [];
  }

  // Extract HG entries from the left sidebar
  // PL24 format: "1  Motor", "2  Kraftstoff,Abgas,Kühlung", etc.
  // SINGLE digit HG codes (0-9)
  const hgEntries = await scrapeHauptgruppen(page);
  logger.info(`[BulkCrawler] Found ${hgEntries.length} Hauptgruppen`);

  for (const hg of hgEntries) {
    // Click into each HG to get its Bildtafel list
    try {
      const clicked = await clickSidebarHg(page, hg.code, hg.name);
      if (!clicked) {
        // Add HG as a single node to process later
        allNodes.push({ hg_code: hg.code, hg_name: hg.name });
        continue;
      }

      await humanDelay(2000, 3000);

      // Extract Bildtafel entries from the table
      // Format: Untergruppe | Bildtafel | Benennung | Bemerkung | Modellangabe
      const bildtafeln = await scrapeBildtafelList(page);

      if (bildtafeln.length > 0) {
        for (const bt of bildtafeln) {
          allNodes.push({
            hg_code: hg.code,
            hg_name: hg.name,
            fg_code: bt.untergruppe,
            fg_name: bt.benennung,
            bildtafel_id: bt.bildtafel,
          });
        }
        logger.info(`[BulkCrawler] HG ${hg.code} ${hg.name}: ${bildtafeln.length} Bildtafeln`);
      } else {
        // No Bildtafeln found — add HG as a node
        allNodes.push({ hg_code: hg.code, hg_name: hg.name });
      }

    } catch (err: any) {
      logger.warn(`[BulkCrawler] Error processing HG ${hg.code}: ${err.message}`);
      allNodes.push({ hg_code: hg.code, hg_name: hg.name });
    }
  }

  return allNodes;
}

// ── Scrape Hauptgruppen (Single digit 0-9) ───────────────────────────────────

async function scrapeHauptgruppen(page: Page): Promise<Array<{ code: string; name: string }>> {
  const entries: Array<{ code: string; name: string }> = [];

  try {
    // PL24 HG sidebar: clickable items like "1  Motor", "2  Kraftstoff,Abgas,Kühlung"
    // The HG code is a SINGLE digit (0-9)
    const bodyText = await page.locator('body').innerText({ timeout: 10000 });
    const lines = bodyText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // Match: single digit + space(s) + name
      // "1  Motor" or "0  Zubehör,Infotainment,Sonstiges"
      const match = trimmed.match(/^(\d)\s{1,}([A-Za-zÀ-ÿ].{2,})$/);
      if (match) {
        entries.push({ code: match[1], name: match[2].trim() });
      }
    }

    // Fallback: look for specific known HG names
    if (entries.length === 0) {
      const knownHgs = [
        { code: '1', name: 'Motor' },
        { code: '2', name: 'Kraftstoff,Abgas,Kühlung' },
        { code: '3', name: 'Getriebe' },
        { code: '4', name: 'Vorderachse,Lenkung' },
        { code: '5', name: 'Hinterachse' },
        { code: '6', name: 'Räder,Bremsen' },
        { code: '7', name: 'Hebelwerk' },
        { code: '8', name: 'Karosserie' },
        { code: '9', name: 'Elektrik' },
        { code: '0', name: 'Zubehör,Infotainment,Sonstiges' },
      ];

      for (const hg of knownHgs) {
        try {
          const el = page.locator(`text="${hg.name}"`).first();
          if (await el.isVisible({ timeout: 1000 })) {
            entries.push(hg);
          }
        } catch { /* skip */ }
      }
    }
  } catch (err: any) {
    logger.error('[BulkCrawler] Failed to scrape HG', { error: err.message });
  }

  // Deduplicate
  const seen = new Set<string>();
  return entries.filter(e => {
    if (seen.has(e.code)) return false;
    seen.add(e.code);
    return true;
  });
}

// ── Scrape Bildtafel List ────────────────────────────────────────────────────
// After clicking a HG, the main area shows:
// Untergruppe | Bildtafel | Benennung | Bemerkung | Modellangabe
// 00          | 100-005   | Rumpfmotor | 2,0Ltr.  | 4-Zylinder
// 00          | 500-000   | Hinterachsgetriebe | Ölbefüllt |

async function scrapeBildtafelList(page: Page): Promise<Array<{
  untergruppe: string; bildtafel: string; benennung: string;
}>> {
  const entries: Array<{ untergruppe: string; bildtafel: string; benennung: string }> = [];

  try {
    const bodyText = await page.locator('body').innerText({ timeout: 8000 });
    const lines = bodyText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // Match: UG (2 digits) + Bildtafel (XXX-YYY) + Benennung
      // "00	100-005	Rumpfmotor	2,0Ltr.	4-Zylinder"
      const match = trimmed.match(/^(\d{2})\s+(\d{3}-\d{3})\s+(.+)/);
      if (match) {
        const benennung = match[3].split(/\t/)[0].trim(); // First part before tab
        entries.push({
          untergruppe: match[1],
          bildtafel: match[2],
          benennung,
        });
      }
    }

    // Fallback: try extracting from table rows
    if (entries.length === 0) {
      const rows = await page.locator('tr, [role="row"]').all();
      for (const row of rows) {
        try {
          const cells = await row.locator('td, [role="cell"]').all();
          if (cells.length >= 3) {
            const ug = (await cells[0].innerText({ timeout: 500 })).trim();
            const bt = (await cells[1].innerText({ timeout: 500 })).trim();
            const name = (await cells[2].innerText({ timeout: 500 })).trim();

            if (/^\d{2}$/.test(ug) && /^\d{3}-\d{3}$/.test(bt)) {
              entries.push({ untergruppe: ug, bildtafel: bt, benennung: name });
            }
          }
        } catch { /* skip */ }
      }
    }
  } catch (err: any) {
    logger.warn('[BulkCrawler] Failed to scrape Bildtafel list', { error: err.message });
  }

  return entries;
}

// ── Process Single Bildtafel Node ────────────────────────────────────────────

async function processNode(job: BulkJob, node: BulkProgressEntry): Promise<void> {
  const nodeLabel = `HG:${node.hg_code}|UG:${node.fg_code || '-'}|BT:${node.bildtafel_id || '-'}`;
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

      // Navigate to the correct position: Brand → Model → Year → HG → Bildtafel
      await navigateToCatalog(page, job);

      // Click the HG in sidebar
      const hgClicked = await clickSidebarHg(page, node.hg_code, node.hg_name);
      if (!hgClicked) {
        markNodeComplete(node.id, 0);
        return;
      }
      await humanDelay(2000, 3000);

      if (node.bildtafel_id) {
        // Click into the specific Bildtafel
        const btClicked = await clickBildtafel(page, node.bildtafel_id);
        if (!btClicked) {
          markNodeComplete(node.id, 0);
          return;
        }
        await humanDelay(2000, 4000);
        await assertNotBlocked(page, `bulk-${nodeLabel}`);

        // Extract OEM numbers from the Bildtafel page
        const parts = await extractOemFromBildtafel(page, job, node);
        const inserted = parts.length > 0 ? insertResults(job.id, parts) : 0;

        if (inserted > 0) incrementJobParts(job.id, inserted);
        markNodeComplete(node.id, inserted);
        incrementJobCompletedHg(job.id);
        logger.info(`[BulkCrawler] ${nodeLabel}: ${inserted} OEMs extracted`);
      } else {
        // No Bildtafel — this is an HG-only node, try to extract what's there
        markNodeComplete(node.id, 0);
        incrementJobCompletedHg(job.id);
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

// ── Navigate to Catalog (Brand → Model → Year → Einschränkung) ──────────────

async function navigateToCatalog(page: Page, job: BulkJob): Promise<void> {
  // Go to dashboard
  await page.goto('https://www.partslink24.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForStable(page);
  await humanDelay(2000, 3000);

  // Click brand
  const brandClicked = await selectBrand(page, job.brand);
  if (!brandClicked) throw new Error(`Brand "${job.brand}" not found`);
  await humanDelay(3000, 5000);

  // Wait for model table
  try {
    await page.locator('text=Modell').first().waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    throw new Error('Model table did not appear after brand click');
  }

  // Click model
  const modelClicked = await clickTableEntry(page, job.model);
  if (!modelClicked) throw new Error(`Model "${job.model}" not found`);
  await humanDelay(2000, 3000);

  // Check if we have years → click first available
  const years = await extractColumnEntries(page, 1);
  if (years.length > 0) {
    // Pick most recent year
    const sortedYears = years.sort((a, b) => parseInt(b) - parseInt(a));
    await clickTableEntry(page, sortedYears[0]);
    await humanDelay(2000, 3000);

    // Handle Einschränkungen
    const einschr1 = await extractColumnEntries(page, 2);
    if (einschr1.length > 0) {
      await clickTableEntry(page, einschr1[0]);
      await humanDelay(1500, 2500);

      const einschr2 = await extractColumnEntries(page, 3);
      if (einschr2.length > 0) {
        await clickTableEntry(page, einschr2[0]);
        await humanDelay(1500, 2500);
      }
    }
  }

  // Wait for Hauptgruppe page to load
  try {
    await page.locator('text=Hauptgruppe').first().waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    // Might already be on a different view
    logger.warn('[BulkCrawler] Hauptgruppe header not visible after navigation');
  }
}

// ── Extract OEM Numbers from Bildtafel Page ──────────────────────────────────
// Table format: Pos. | Teilenummer | Benennung | Bemerkung | Stk. | Modellangabe
// "1 | 0B0 500 043 R | Hinterachsgetriebe | 44:10 | 1"

async function extractOemFromBildtafel(page: Page, job: BulkJob, node: BulkProgressEntry): Promise<Array<{
  vin: string; brand: string; model: string;
  oem: string; description?: string; bildtafel?: string;
  hg_code?: string; hg_name?: string; fg_code?: string; fg_name?: string;
}>> {
  const parts: Array<{
    vin: string; brand: string; model: string;
    oem: string; description?: string; bildtafel?: string;
    hg_code?: string; hg_name?: string; fg_code?: string; fg_name?: string;
  }> = [];

  try {
    // Wait for parts table to load
    try {
      await page.locator('text=Teilenummer').first().waitFor({ state: 'visible', timeout: 10000 });
    } catch {
      logger.warn(`[BulkCrawler] "Teilenummer" not visible for BT ${node.bildtafel_id}`);
      return [];
    }

    const bodyText = await page.locator('body').innerText({ timeout: 10000 });
    const lines = bodyText.split('\n');
    const seenOems = new Set<string>();

    for (const line of lines) {
      const trimmed = line.trim();

      // Look for OEM patterns in the text
      // VAG format: "0B0 500 043 R", "09R 500 043 E", "4K0 501 529 F"
      // BMW format: "11 42 7 508 966"
      // Mercedes: "A 205 421 10 12"
      const oemPatterns = [
        /\b([A-Z0-9]{3}\s\d{3}\s\d{3}\s?[A-Z]?)\b/g,           // VAG: 0B0 500 043 R
        /\b(\d{2}\s\d{2}\s\d\s\d{3}\s\d{3})\b/g,                 // BMW: 11 42 7 508 966
        /\b([A-Z]\s?\d{3}\s?\d{3}\s?\d{2}\s?\d{2})\b/g,          // Mercedes
        /\b([A-Z0-9]{2,4}[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?[A-Z0-9]{0,3})\b/g, // Generic
      ];

      for (const pattern of oemPatterns) {
        let match;
        while ((match = pattern.exec(trimmed)) !== null) {
          const oem = match[1].trim();
          const normalized = oem.replace(/[\s\-.]/g, '');

          // Validate: must have digits, must be 7-15 chars
          if (normalized.length >= 7 && normalized.length <= 15 && /\d/.test(normalized) && !seenOems.has(normalized)) {
            seenOems.add(normalized);

            // Try to find description near the OEM number
            const oemIdx = trimmed.indexOf(oem);
            const afterOem = trimmed.substring(oemIdx + oem.length).trim();
            const description = afterOem.split(/\t|\s{3,}/)[0]?.trim() || '';

            parts.push({
              vin: job.vin,
              brand: job.brand,
              model: job.model,
              oem,
              description: description || node.fg_name || undefined,
              bildtafel: node.bildtafel_id || undefined,
              hg_code: node.hg_code,
              hg_name: node.hg_name || undefined,
              fg_code: node.fg_code || undefined,
              fg_name: node.fg_name || undefined,
            });
          }
        }
      }
    }

    // Also try structured table extraction
    if (parts.length === 0) {
      const rows = await page.locator('tr, [role="row"]').all();
      for (const row of rows) {
        try {
          const cells = await row.locator('td, [role="cell"]').all();
          if (cells.length >= 3) {
            // Look for "Teilenummer" column (usually index 1 or 2)
            for (let i = 0; i < Math.min(cells.length, 4); i++) {
              const cellText = (await cells[i].innerText({ timeout: 500 })).trim();
              const normalized = cellText.replace(/[\s\-.]/g, '');

              if (normalized.length >= 7 && normalized.length <= 15 && /\d/.test(normalized) && /[A-Z]/.test(cellText)) {
                if (!seenOems.has(normalized)) {
                  seenOems.add(normalized);

                  // Get description from next cell
                  let desc = '';
                  if (i + 1 < cells.length) {
                    desc = (await cells[i + 1].innerText({ timeout: 500 })).trim();
                  }

                  parts.push({
                    vin: job.vin,
                    brand: job.brand,
                    model: job.model,
                    oem: cellText,
                    description: desc || node.fg_name || undefined,
                    bildtafel: node.bildtafel_id || undefined,
                    hg_code: node.hg_code,
                    hg_name: node.hg_name || undefined,
                    fg_code: node.fg_code || undefined,
                    fg_name: node.fg_name || undefined,
                  });
                }
              }
            }
          }
        } catch { /* skip */ }
      }
    }
  } catch (err: any) {
    logger.warn(`[BulkCrawler] OEM extraction failed for BT ${node.bildtafel_id}`, { error: err.message });
  }

  return parts;
}

// ── Table Navigation Helpers ─────────────────────────────────────────────────

/**
 * Extract text entries from a specific column index in the PL24 multi-column table.
 * Column 0 = Modell, 1 = Modelljahr, 2 = Einschränkung I, etc.
 */
async function extractColumnEntries(page: Page, columnIndex: number): Promise<string[]> {
  const entries: string[] = [];
  const seen = new Set<string>();

  try {
    // PL24 SPA uses a table/grid layout
    // Try to find column headers first to identify the right column
    const headers = await page.locator('th, [role="columnheader"]').all();
    let targetHeader: string | null = null;

    if (headers.length > columnIndex) {
      try {
        targetHeader = (await headers[columnIndex].innerText({ timeout: 2000 })).trim();
      } catch { /* ignore */ }
    }

    // Extract entries from table rows
    const rows = await page.locator('tr, [role="row"]').all();
    for (const row of rows) {
      try {
        const cells = await row.locator('td, [role="cell"]').all();
        if (cells.length > columnIndex) {
          const text = (await cells[columnIndex].innerText({ timeout: 500 })).trim();
          if (text && text.length > 0 && text.length < 100 && !seen.has(text)) {
            seen.add(text);
            entries.push(text);
          }
        }
      } catch { /* skip */ }
    }

    // Fallback: parse body text and look for the column entries
    if (entries.length === 0) {
      const bodyText = await page.locator('body').innerText({ timeout: 8000 });
      const lines = bodyText.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length >= 2 && trimmed.length <= 60 && !seen.has(trimmed)) {
          // For Modelljahr column, look for 4-digit years
          if (columnIndex === 1 && /^\d{4}$/.test(trimmed)) {
            seen.add(trimmed);
            entries.push(trimmed);
          }
          // For Modell column, look for model names
          else if (columnIndex === 0 && /^[A-Za-zÀ-ÿ0-9]/.test(trimmed) && !/^(Modell|Modelljahr|Einschränkung|Hauptgruppe|Startseite)/.test(trimmed)) {
            seen.add(trimmed);
            entries.push(trimmed);
          }
          // For Einschränkung columns
          else if (columnIndex >= 2 && /^[A-Za-zÀ-ÿ]/.test(trimmed) && trimmed.length >= 3) {
            seen.add(trimmed);
            entries.push(trimmed);
          }
        }
      }
    }
  } catch (err: any) {
    logger.warn(`[BulkCrawler] Failed to extract column ${columnIndex}`, { error: err.message });
  }

  return entries;
}

/**
 * Click an entry in the PL24 drill-down table by its text.
 */
async function clickTableEntry(page: Page, text: string): Promise<boolean> {
  const selectors = [
    `td:has-text("${text}")`,
    `[role="cell"]:has-text("${text}")`,
    `a:has-text("${text}")`,
    `text="${text}"`,
    `div:has-text("${text}")`,
  ];

  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        await el.click();
        await waitForStable(page);
        await humanDelay(500, 1000);
        return true;
      }
    } catch { /* try next */ }
  }

  logger.warn(`[BulkCrawler] Could not click table entry: "${text}"`);
  return false;
}

/**
 * Click a Hauptgruppe in the sidebar.
 * PL24 sidebar has entries like "1  Motor", "2  Kraftstoff,Abgas,Kühlung"
 */
async function clickSidebarHg(page: Page, hgCode: string, hgName: string | null): Promise<boolean> {
  // Try clicking by name first (more reliable)
  if (hgName) {
    const nameSelectors = [
      `text="${hgCode} ${hgName}"`,
      `text="${hgName}"`,
      `a:has-text("${hgName}")`,
      `div:has-text("${hgName}")`,
      `li:has-text("${hgName}")`,
    ];

    for (const sel of nameSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await el.click();
          await waitForStable(page);
          return true;
        }
      } catch { /* try next */ }
    }
  }

  // Fallback: click by code
  try {
    const el = page.locator(`text="${hgCode}"`).first();
    if (await el.isVisible({ timeout: 2000 })) {
      await el.click();
      await waitForStable(page);
      return true;
    }
  } catch { /* skip */ }

  return false;
}

/**
 * Click a Bildtafel entry by its ID (format: XXX-YYY, e.g., "100-005", "500-000")
 */
async function clickBildtafel(page: Page, bildtafelId: string): Promise<boolean> {
  const selectors = [
    `td:has-text("${bildtafelId}")`,
    `[role="cell"]:has-text("${bildtafelId}")`,
    `a:has-text("${bildtafelId}")`,
    `text="${bildtafelId}"`,
  ];

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

  logger.warn(`[BulkCrawler] Could not click Bildtafel: "${bildtafelId}"`);
  return false;
}
