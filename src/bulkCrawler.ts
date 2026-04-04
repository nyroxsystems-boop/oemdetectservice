/**
 * 🕷️ BULK CRAWLER — PartsLink24 Catalog Scraper
 *
 * Verified PL24 flow (tested in live browser April 2026):
 *
 * 1. Dashboard (brandMenu.do): Brand links = <a href="/partslink24/launchCatalog.do?service={brand}_parts">
 * 2. SPA (/pl24-app/{brand}_parts/0/0): Multi-column drill-down table
 *    - All data in <span> inside <div class="_value_*"> (React CSS modules)
 *    - Column 1: Modell → click to drill down
 *    - Column 2: Modelljahr → click to drill down
 *    - Column 3+: Einschränkung (optional)
 * 3. HG page: Single-digit codes (1-9, 0) in same _value_ spans
 * 4. Bildtafel list: UG | Bildtafel (XXX-YYY) | Benennung — click row to open
 * 5. Parts page: OEM numbers in _value_ spans matching /^[A-Z0-9]{3}\s\d{3}\s\d{3}/
 */

import { Page } from 'playwright';
import { logger } from './logger';
import { config } from './config';
import { enqueue } from './requestQueue';
import {
  ensureLoggedIn, selectBrand, getContext, PL24_SERVICE_MAP,
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

// ── Control ──────────────────────────────────────────────────────────────────

export function pauseBulk(): void { bulkPaused = true; }
export function resumeBulk(): void { bulkPaused = false; }
export function cancelBulk(): void {
  bulkPaused = true; bulkRunning = false;
  if (currentJobId) updateJobStatus(currentJobId, 'paused', { last_error: 'Cancelled by admin' });
  currentJobId = null;
}
export function getBulkState() {
  return { running: bulkRunning, paused: bulkPaused, currentJobId };
}

// ── SPA Helpers (verified from live browser) ─────────────────────────────────

/** Read all values from PL24 SPA _value_ spans */
async function readValueSpans(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const spans = document.querySelectorAll('[class*="_value_"] span, [class*="_value_"]');
    const values: string[] = [];
    for (const s of spans) {
      if (s.children.length === 0) {
        const t = s.textContent?.trim();
        if (t && t.length > 0 && t.length < 80) values.push(t);
      }
    }
    return values;
  });
}

/** Click a value span by exact or partial text match */
async function clickValueSpan(page: Page, text: string): Promise<boolean> {
  const clicked = await page.evaluate((searchText) => {
    const spans = document.querySelectorAll('[class*="_value_"] span, [class*="_value_"]');
    for (const s of spans) {
      if (s.children.length === 0 && s.textContent?.trim() === searchText) {
        (s as HTMLElement).click();
        return true;
      }
    }
    // Partial match fallback
    for (const s of spans) {
      if (s.children.length === 0 && s.textContent?.trim().includes(searchText)) {
        (s as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, text);

  if (clicked) {
    await waitForStable(page);
    await humanDelay(1500, 2500);
  }
  return clicked;
}

/** Extract OEM numbers from the current Bildtafel page */
async function extractOemsFromPage(page: Page): Promise<Array<{ oem: string; description: string }>> {
  return page.evaluate(() => {
    const spans = document.querySelectorAll('[class*="_value_"] span, [class*="_value_"]');
    const values: string[] = [];
    for (const s of spans) {
      if (s.children.length === 0) {
        const t = s.textContent?.trim();
        if (t) values.push(t);
      }
    }

    // OEM pattern: 3 alphanumeric + space + 3 digits + space + 3 digits + optional suffix
    const oemPattern = /^[A-Z0-9]{3}\s\d{3}\s\d{3}(\s[A-Z0-9]{0,3})?$/;
    const results: Array<{ oem: string; description: string }> = [];
    const seen = new Set<string>();

    for (let i = 0; i < values.length; i++) {
      if (oemPattern.test(values[i]) && !seen.has(values[i])) {
        seen.add(values[i]);
        // Description is typically the next value after the OEM
        const desc = (i + 1 < values.length && !oemPattern.test(values[i + 1]))
          ? values[i + 1] : '';
        results.push({ oem: values[i], description: desc });
      }
    }
    return results;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCOVER MODE
// ═══════════════════════════════════════════════════════════════════════════

export interface DiscoveredModel { brand: string; model: string; }

export async function discoverBrandsAndModels(): Promise<{
  brands: string[]; models: DiscoveredModel[]; errors: string[];
}> {
  return enqueue(async () => {
    const ctx = getContext();
    if (!ctx) throw new Error('Browser not initialized');

    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const allModels: DiscoveredModel[] = [];
    const discoveredBrands: string[] = [];
    const errors: string[] = [];

    try {
      // Login once
      const loggedIn = await ensureLoggedIn(page);
      if (!loggedIn) throw new Error('Login failed');

      logger.info('[Discover] Login OK, discovering brands...');

      const brandsToDiscover = Object.keys(PL24_SERVICE_MAP);

      for (const brandKey of brandsToDiscover) {
        if (bulkPaused) break;

        try {
          // Go back to dashboard
          await page.goto('https://www.partslink24.com/partslink24/user/brandMenu.do', {
            waitUntil: 'domcontentloaded', timeout: 30000
          });
          await waitForStable(page);
          await humanDelay(1500, 2500);

          // Click brand via launchCatalog link
          const brandClicked = await selectBrand(page, brandKey);
          if (!brandClicked) {
            logger.warn(`[Discover] Brand "${brandKey}" not found`);
            continue;
          }

          // Wait for SPA to load
          await humanDelay(3000, 5000);
          await assertNotBlocked(page, `discover-${brandKey}`);

          // Read model names from _value_ spans
          const values = await readValueSpans(page);
          const models = values.filter(v =>
            v.length > 3 && v.length < 50 &&
            !/^(Modell|Modelljahr|Einschränkung|Hauptgruppe|Startseite|Direkteinstieg)/.test(v) &&
            !/^\d{4}$/.test(v) && // Not a year
            !/^\d{1,2}$/.test(v) // Not a HG code
          );

          if (models.length > 0) {
            discoveredBrands.push(brandKey);
            for (const model of models) {
              allModels.push({ brand: brandKey, model });
              try {
                upsertVehicle({
                  vin: `PL24-${brandKey}-${model.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30)}`,
                  brand: brandKey, model,
                });
              } catch { /* dup */ }
            }
            logger.info(`[Discover] ${brandKey}: ${models.length} models`);
          }

        } catch (err: any) {
          logger.error(`[Discover] ${brandKey}: ${err.message}`);
          errors.push(`${brandKey}: ${err.message}`);
        }

        await sleep(config.bulkDelayMs);
      }

      return { brands: discoveredBrands, models: allModels, errors };
    } finally {
      await page.close();
    }
  }, 'discover-all-brands', 'low');
}

// ═══════════════════════════════════════════════════════════════════════════
// CRAWL MODE
// ═══════════════════════════════════════════════════════════════════════════

export async function startCrawl(jobId: number): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  if (bulkRunning) {
    updateJobStatus(jobId, 'queued');
    return;
  }

  bulkRunning = true;
  bulkPaused = false;
  currentJobId = jobId;
  consecutiveErrors = 0;
  updateJobStatus(jobId, 'running');

  try {
    await crawlVehicle(job);
  } catch (err: any) {
    logger.error(`[Crawler] Fatal: ${err.message}`);
    updateJobStatus(jobId, 'failed', { last_error: err.message });
  } finally {
    bulkRunning = false;
    currentJobId = null;
    const next = getNextQueuedJob();
    if (next) startCrawl(next.id).catch(() => {});
  }
}

async function crawlVehicle(job: BulkJob): Promise<void> {
  const progress = getJobProgress(job.id);

  if (progress.total === 0) {
    // Phase 1: Discover all Bildtafeln for this model
    logger.info(`[Crawler] Discovering Bildtafeln for ${job.brand} ${job.model}...`);
    const nodes = await discoverBildtafeln(job);
    if (nodes.length === 0) {
      updateJobStatus(job.id, 'failed', { last_error: 'No Bildtafeln found' });
      return;
    }
    seedProgress(job.id, nodes);
    updateJobStatus(job.id, 'running', { total_hg: nodes.length });
    logger.info(`[Crawler] ${nodes.length} Bildtafeln to scrape`);
  }

  // Phase 2: Process each Bildtafel
  while (true) {
    if (bulkPaused) { updateJobStatus(job.id, 'paused'); return; }

    const node = getNextPendingNode(job.id);
    if (!node) {
      updateJobStatus(job.id, 'completed');
      logger.info(`[Crawler] Job ${job.id} done! ${getJob(job.id)?.total_parts_found || 0} OEMs`);
      return;
    }

    try {
      await scrapeBildtafel(job, node);
      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      markNodeFailed(node.id, err.message);
      incrementJobErrors(job.id);
      if (consecutiveErrors >= config.bulkMaxConsecutiveErrors) {
        updateJobStatus(job.id, 'paused', {
          last_error: `${consecutiveErrors} errors — auto-paused: ${err.message}`,
        });
        return;
      }
    }

    await sleep(config.bulkDelayMs);
  }
}

// ── Discover Bildtafeln ──────────────────────────────────────────────────────

async function discoverBildtafeln(job: BulkJob): Promise<Array<{
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
      // Navigate to HG page: Login → Dashboard → Brand → Model → Year
      await navigateToHgPage(page, job);

      // Read all HG entries
      const values = await readValueSpans(page);
      const hgEntries: Array<{ code: string; name: string }> = [];
      for (const v of values) {
        const match = v.match(/^(\d)\s+(.+)/);
        if (match) hgEntries.push({ code: match[1], name: match[2] });
      }
      // Fallback: match known HG names
      if (hgEntries.length === 0) {
        const knownNames = ['Motor', 'Kraftstoff', 'Getriebe', 'Vorderachse', 'Hinterachse',
          'Räder', 'Hebelwerk', 'Karosserie', 'Elektrik', 'Zubehör'];
        let code = 1;
        for (const v of values) {
          if (knownNames.some(n => v.includes(n))) {
            hgEntries.push({ code: String(code % 10), name: v });
            code++;
          }
        }
      }

      logger.info(`[Crawler] Found ${hgEntries.length} HG entries`);
      const allNodes: Array<{ hg_code: string; hg_name?: string; fg_code?: string; fg_name?: string; bildtafel_id?: string }> = [];

      // For each HG, click it and read Bildtafeln
      for (const hg of hgEntries) {
        try {
          const clicked = await clickValueSpan(page, hg.name);
          if (!clicked) {
            allNodes.push({ hg_code: hg.code, hg_name: hg.name });
            continue;
          }
          await humanDelay(2000, 3000);

          // Read Bildtafel entries (format XXX-YYY)
          const btValues = await readValueSpans(page);
          const bildtafeln: Array<{ bt: string; ug: string; name: string }> = [];
          for (let i = 0; i < btValues.length; i++) {
            if (/^\d{3}-\d{3}$/.test(btValues[i])) {
              const ug = (i > 0 && /^\d{2}$/.test(btValues[i - 1])) ? btValues[i - 1] : '00';
              const name = (i + 1 < btValues.length) ? btValues[i + 1] : '';
              bildtafeln.push({ bt: btValues[i], ug, name });
            }
          }

          if (bildtafeln.length > 0) {
            for (const bt of bildtafeln) {
              allNodes.push({
                hg_code: hg.code, hg_name: hg.name,
                fg_code: bt.ug, fg_name: bt.name,
                bildtafel_id: bt.bt,
              });
            }
            logger.info(`[Crawler] HG ${hg.code} ${hg.name}: ${bildtafeln.length} Bildtafeln`);
          } else {
            allNodes.push({ hg_code: hg.code, hg_name: hg.name });
          }

          // Click back to HG level (click HG name in sidebar or use breadcrumb)
          // The HG sidebar stays visible — we just need to click another HG
        } catch (err: any) {
          logger.warn(`[Crawler] HG ${hg.code}: ${err.message}`);
          allNodes.push({ hg_code: hg.code, hg_name: hg.name });
        }
      }

      return allNodes;
    } finally {
      await page.close();
    }
  }, `discover-bt-${job.id}`, 'low');
}

// ── Navigate to HG Page ──────────────────────────────────────────────────────

async function navigateToHgPage(page: Page, job: BulkJob): Promise<void> {
  // Step 1: Login
  const loggedIn = await ensureLoggedIn(page);
  if (!loggedIn) throw new Error('Login failed');

  // Step 2: Go to dashboard
  await page.goto('https://www.partslink24.com/partslink24/user/brandMenu.do', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await waitForStable(page);
  await humanDelay(2000, 3000);

  // Step 3: Click brand
  const brandClicked = await selectBrand(page, job.brand);
  if (!brandClicked) throw new Error(`Brand "${job.brand}" not found`);
  await humanDelay(3000, 5000);

  // Step 4: Click model in SPA table
  const modelClicked = await clickValueSpan(page, job.model);
  if (!modelClicked) throw new Error(`Model "${job.model}" not found`);
  await humanDelay(2000, 3000);

  // Step 5: Check if we have years or jumped directly to HG
  const values = await readValueSpans(page);
  const hasYears = values.some(v => /^\d{4}$/.test(v));

  if (hasYears) {
    // Pick most recent year
    const years = values.filter(v => /^\d{4}$/.test(v)).sort((a, b) => parseInt(b) - parseInt(a));
    if (years.length > 0) {
      await clickValueSpan(page, years[0]);
      await humanDelay(2000, 3000);

      // Check for Einschränkungen
      const newValues = await readValueSpans(page);
      const hasHg = newValues.some(v => /^(Motor|Kraftstoff|Getriebe|Vorderachse|Hinterachse|Räder|Hebelwerk|Karosserie|Elektrik|Zubehör)/.test(v));

      if (!hasHg) {
        // Still in drill-down — click first available option
        const options = newValues.filter(v =>
          v.length > 3 && !/^\d{4}$/.test(v) &&
          !/^(Modell|Hauptgruppe|Einschränkung)/.test(v)
        );
        if (options.length > 0) {
          await clickValueSpan(page, options[0]);
          await humanDelay(2000, 3000);
        }
      }
    }
  }

  // Verify we're on HG page
  const finalValues = await readValueSpans(page);
  const hasHg = finalValues.some(v => /^(Motor|Kraftstoff|Getriebe|Vorderachse|Hinterachse|Räder|Hebelwerk|Karosserie|Elektrik|Zubehör)/.test(v));
  if (!hasHg) {
    await takeScreenshot(page, `no-hg-${job.brand}-${job.model}`);
    logger.warn(`[Crawler] HG page not detected for ${job.brand} ${job.model}`);
  }
}

// ── Scrape Single Bildtafel ──────────────────────────────────────────────────

async function scrapeBildtafel(job: BulkJob, node: BulkProgressEntry): Promise<void> {
  await enqueue(async () => {
    const ctx = getContext();
    if (!ctx) throw new Error('Browser not initialized');
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    try {
      // Navigate to the HG page
      await navigateToHgPage(page, job);

      // Click into the correct HG
      if (node.hg_name) {
        const hgClicked = await clickValueSpan(page, node.hg_name);
        if (!hgClicked) { markNodeComplete(node.id, 0); return; }
        await humanDelay(2000, 3000);
      }

      // Click the Bildtafel
      if (node.bildtafel_id) {
        // Click the Bildtafel row — need to find the XXX-YYY span and click its parent row
        const btClicked = await page.evaluate((btId) => {
          const spans = document.querySelectorAll('[class*="_value_"] span, [class*="_value_"]');
          for (const s of spans) {
            if (s.textContent?.trim() === btId) {
              // Click the parent row element
              const row = s.closest('[class*="_row_"], [class*="_line_"], [class*="Row"]') || s.parentElement?.parentElement;
              if (row) { (row as HTMLElement).click(); return true; }
              (s as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, node.bildtafel_id);

        if (!btClicked) {
          // Fallback: try clicking by text
          const fallback = await clickValueSpan(page, node.bildtafel_id);
          if (!fallback) { markNodeComplete(node.id, 0); return; }
        }

        await humanDelay(3000, 5000);
        await assertNotBlocked(page, `bt-${node.bildtafel_id}`);

        // Extract OEMs
        const oems = await extractOemsFromPage(page);

        if (oems.length > 0) {
          const rows = oems.map(o => ({
            vin: job.vin, brand: job.brand, model: job.model,
            oem: o.oem, description: o.description,
            bildtafel: node.bildtafel_id || undefined,
            hg_code: node.hg_code, hg_name: node.hg_name || undefined,
            fg_code: node.fg_code || undefined, fg_name: node.fg_name || undefined,
          }));
          const inserted = insertResults(job.id, rows);
          incrementJobParts(job.id, inserted);
          logger.info(`[Crawler] BT ${node.bildtafel_id}: ${inserted} OEMs`);
        }

        markNodeComplete(node.id, oems.length);
        incrementJobCompletedHg(job.id);
      } else {
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
  }, `scrape-bt-${node.bildtafel_id || node.hg_code}`, 'low');
}
