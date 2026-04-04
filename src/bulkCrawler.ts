/**
 * 🕷️ BULK CRAWLER — PartsLink24 Catalog Scraper (v2 — Rewritten)
 *
 * FIXES APPLIED (April 2026):
 * 1. Page-Reuse: Single persistent page per crawl job (no re-navigation per Bildtafel)
 * 2. Breadcrumb navigation: Navigate back to HG level via sidebar, not full restart
 * 3. Robust HG detection: Digit-based pattern /^\d\s+.+/ instead of 10 hardcoded strings
 * 4. Multi-brand OEM regex: Ported all 5 patterns from solo scraper
 * 5. Separate circuit breaker: Bulk errors don't trip the global circuit breaker
 * 6. Exponential backoff: Doubles delay on consecutive errors, resets on success
 * 7. Discover phase: Explicit breadcrumb back-navigation between HGs
 *
 * Verified PL24 flow:
 * 1. Dashboard → Brand SPA via /pl24-app/{brand}_parts/0/0
 * 2. SPA drill-down: Modell → Modelljahr → Einschränkung
 * 3. HG page: Single-digit codes (1-9, 0) in _value_ spans
 * 4. Bildtafel list: UG | Bildtafel (XXX-YYY) | Benennung
 * 5. Parts page: OEM numbers in _value_ spans
 */

import { Page } from 'playwright';
import { logger } from './logger';
import { config } from './config';
import {
  ensureLoggedIn, getContext, PL24_SERVICE_MAP,
  assertNotBlocked, sleep, humanDelay, waitForStable, takeScreenshot,
  resetLoginState,
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

// FIX 6: Exponential backoff state
let currentBackoffMs = config.bulkDelayMs;
const MAX_BACKOFF_MS = 120_000; // max 2 minutes between retries

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
  return page.evaluate(`
    (() => {
      const spans = document.querySelectorAll('[class*="_value_"] span, [class*="_value_"]');
      const values = [];
      for (const s of spans) {
        if (s.children.length === 0) {
          const t = s.textContent?.trim();
          if (t && t.length > 0 && t.length < 80) values.push(t);
        }
      }
      return values;
    })()
  `) as any as string[];
}

/** Click a value span by exact or partial text match */
async function clickValueSpan(page: Page, text: string): Promise<boolean> {
  const clicked: boolean = await page.evaluate(`
    (() => {
      const searchText = ${JSON.stringify(text)};
      const spans = document.querySelectorAll('[class*="_value_"] span, [class*="_value_"]');
      for (const s of spans) {
        if (s.children.length === 0 && s.textContent?.trim() === searchText) {
          s.click();
          return true;
        }
      }
      for (const s of spans) {
        if (s.children.length === 0 && s.textContent?.trim().includes(searchText)) {
          s.click();
          return true;
        }
      }
      return false;
    })()
  `) as any;

  if (clicked) {
    await waitForStable(page);
    await humanDelay(1500, 2500);
  }
  return clicked;
}

/**
 * FIX 7: Navigate back to a parent level using breadcrumb clicks.
 * PL24 SPA has breadcrumb-like elements: Startseite > Brand > Model > ...
 * We try clicking a breadcrumb or the HG-level sidebar to go back.
 */
async function navigateBackToLevel(page: Page, targetText: string): Promise<boolean> {
  // Strategy 1: Click breadcrumb containing target text
  const breadcrumbClicked: boolean = await page.evaluate(`
    (() => {
      const target = ${JSON.stringify(targetText)};
      // Look for breadcrumb-like elements
      const crumbs = document.querySelectorAll(
        '[class*="breadcrumb"] a, [class*="breadcrumb"] span, ' +
        '[class*="_crumb_"] a, [class*="_crumb_"] span, ' +
        '[class*="Breadcrumb"] a, [class*="Breadcrumb"] span'
      );
      for (const c of crumbs) {
        if (c.textContent?.trim().includes(target)) {
          c.click();
          return true;
        }
      }
      return false;
    })()
  `) as any;

  if (breadcrumbClicked) {
    await waitForStable(page);
    await humanDelay(1500, 2500);
    return true;
  }

  // Strategy 2: Use browser back
  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
    await humanDelay(2000, 3000);
    return true;
  } catch {
    logger.warn(`[Nav] Could not navigate back to "${targetText}"`);
    return false;
  }
}

/**
 * FIX 4: Extract OEM numbers using ALL brand-specific patterns
 * (ported from solo scraper's extractByPattern in scraper.ts)
 */
async function extractOemsFromPage(page: Page): Promise<Array<{ oem: string; description: string }>> {
  return page.evaluate(`
    (() => {
      const spans = document.querySelectorAll('[class*="_value_"] span, [class*="_value_"]');
      const values = [];
      for (const s of spans) {
        if (s.children.length === 0) {
          const t = s.textContent?.trim();
          if (t) values.push(t);
        }
      }

      // Multi-brand OEM patterns (ported from solo scraper)
      const oemPatterns = [
        /^[A-Z0-9]{3}\\s\\d{3}\\s\\d{3}(\\s[A-Z0-9]{0,3})?$/,     // VW/Audi: "5Q0 615 301 F"
        /^\\d{2}\\s\\d{2}\\s\\d\\s\\d{3}\\s\\d{3}$/,                   // BMW: "11 42 7 508 966"
        /^[A-Z]\\s?\\d{3}\\s?\\d{3}\\s?\\d{2}\\s?\\d{2}$/,            // Mercedes: "A 205 421 10 12"
        /^9[A-Z]\\d\\s?\\d{3}\\s?\\d{3}\\s?\\d{2}$/,                 // Porsche: "9PA 351 402 00"
        /^[A-Z0-9]{2,4}[\\s.-]\\d{3}[\\s.-]\\d{3}[\\s.-]?[A-Z0-9]{0,3}$/, // Generic European
      ];

      const results = [];
      const seen = new Set();

      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const isOem = oemPatterns.some(p => p.test(v));

        // Also check if it looks like an OEM by structure (7-15 alphanumeric chars with spaces)
        const stripped = v.replace(/[\\s.-]/g, '');
        const structuralOem = !isOem &&
          stripped.length >= 7 && stripped.length <= 15 &&
          /^[A-Z0-9]+$/.test(stripped) &&
          /\\d/.test(stripped) && /[A-Z]/.test(stripped);

        if ((isOem || structuralOem) && !seen.has(stripped)) {
          seen.add(stripped);
          // Next non-OEM value is likely the description
          const desc = (i + 1 < values.length && !oemPatterns.some(p => p.test(values[i + 1])))
            ? values[i + 1] : '';
          results.push({ oem: v, description: desc });
        }
      }
      return results;
    })()
  `) as any as Array<{ oem: string; description: string }>;
}

/**
 * FIX 3: Robust HG detection — check for single-digit codes (1-9, 0)
 * instead of matching 10 hardcoded German category names.
 */
function isHgPage(values: string[]): boolean {
  // HG page has single-digit codes (0-9) followed by a name
  const hgPattern = /^\d\s+.+/;
  const hgMatches = values.filter(v => hgPattern.test(v));

  if (hgMatches.length >= 3) return true; // At least 3 HG entries

  // Fallback: check for ANY known HG names (expanded list)
  const knownHgNames = [
    'Motor', 'Kraftstoff', 'Getriebe', 'Vorderachse', 'Hinterachse',
    'Räder', 'Hebelwerk', 'Karosserie', 'Elektrik', 'Zubehör',
    'Motor-Elektrik', 'Heizung', 'Klima', 'Abgasanlage', 'Kühlung',
    'Lenkung', 'Bremse', 'Kommunikation', 'Beleuchtung',
    'Verglasung', 'Innenausstattung', 'Kraftübertragung',
    'Auspuff', 'Fahrwerk', 'Achse',
  ];
  const nameMatches = values.filter(v =>
    knownHgNames.some(n => v.includes(n))
  );
  return nameMatches.length >= 2;
}

/**
 * Parse HG entries from value spans.
 * FIX 3: Uses digit-based detection as primary, names as secondary.
 */
function parseHgEntries(values: string[]): Array<{ code: string; name: string }> {
  const entries: Array<{ code: string; name: string }> = [];

  // Primary: Match "digit name" pattern (e.g., "1 Motor", "2 Kraftstoffsystem")
  for (const v of values) {
    const match = v.match(/^(\d)\s+(.+)/);
    if (match) entries.push({ code: match[1], name: match[2] });
  }

  if (entries.length > 0) return entries;

  // Secondary fallback: Match known HG names and assign codes
  const knownHgMap: Record<string, string> = {
    'Motor': '1', 'Kraftstoff': '2', 'Getriebe': '3',
    'Vorderachse': '4', 'Hinterachse': '5', 'Räder': '6',
    'Hebelwerk': '7', 'Karosserie': '8', 'Elektrik': '9', 'Zubehör': '0',
    'Motor-Elektrik': '9', 'Heizung': '7', 'Klima': '7',
    'Kühlung': '2', 'Abgasanlage': '2', 'Lenkung': '4',
    'Bremse': '4', 'Beleuchtung': '9', 'Kommunikation': '9',
  };

  let codeIndex = 1;
  for (const v of values) {
    for (const [name, code] of Object.entries(knownHgMap)) {
      if (v.includes(name) && !entries.some(e => e.name === v)) {
        entries.push({ code, name: v });
        codeIndex++;
        break;
      }
    }
  }

  return entries;
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCOVER MODE
// ═══════════════════════════════════════════════════════════════════════════

export interface DiscoveredModel { brand: string; model: string; }

export async function discoverBrandsAndModels(): Promise<{
  brands: string[]; models: DiscoveredModel[]; errors: string[];
}> {
  // FIX 5: Don't use the global enqueue — run directly to avoid tripping circuit breaker
  const ctx = getContext();
  if (!ctx) throw new Error('Browser not initialized');

  const allModels: DiscoveredModel[] = [];
  const discoveredBrands: string[] = [];
  const errors: string[] = [];

  // Login with retry
  let page: Page | null = null;
  let retries = 0;
  const MAX_RETRIES = 2;

  while (retries <= MAX_RETRIES) {
    try {
      page = await ctx.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      const loggedIn = await ensureLoggedIn(page);
      if (!loggedIn) throw new Error('Login failed');

      logger.info('[Discover] Login OK');
      break;

    } catch (err: any) {
      retries++;
      logger.warn(`[Discover] Login attempt ${retries}/${MAX_RETRIES + 1} failed: ${err.message}`);

      if (page) { try { await page.close(); } catch { /* ignore */ } page = null; }

      if (retries > MAX_RETRIES) {
        throw new Error(`Login failed after ${MAX_RETRIES + 1} attempts`);
      }

      resetLoginState();
      await humanDelay(3000, 6000);
    }
  }

  if (!page) throw new Error('No page after login');

  try {
    logger.info('[Discover] Starting brand discovery...');

    const brandsToDiscover = Object.keys(PL24_SERVICE_MAP);

    for (const brandKey of brandsToDiscover) {
      if (bulkPaused) break;

      try {
        const serviceName = PL24_SERVICE_MAP[brandKey];
        if (!serviceName) {
          logger.warn(`[Discover] No service name for "${brandKey}"`);
          continue;
        }

        const spaUrl = `https://www.partslink24.com/pl24-app/${serviceName}/0/0?desktop=true&lang=de`;
        logger.info(`[Discover] Navigating to ${brandKey}: ${spaUrl}`);

        await page.goto(spaUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanDelay(3000, 5000);
        await assertNotBlocked(page, `discover-${brandKey}`);

        const values = await readValueSpans(page);
        logger.info(`[Discover] ${brandKey}: ${values.length} value spans found`);
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
}

// ═══════════════════════════════════════════════════════════════════════════
// CRAWL MODE (v2 — Page-Reuse Architecture)
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
  currentBackoffMs = config.bulkDelayMs; // FIX 6: Reset backoff
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

  // FIX 1: Phase 2 — Open ONE persistent page for all Bildtafeln
  const ctx = getContext();
  if (!ctx) throw new Error('Browser not initialized');

  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  let currentHgCode: string | null = null; // Track which HG we're currently in
  let needsFullNavigation = true; // Only true at start or after session loss

  try {
    while (true) {
      if (bulkPaused) { updateJobStatus(job.id, 'paused'); return; }

      const node = getNextPendingNode(job.id);
      if (!node) {
        updateJobStatus(job.id, 'completed');
        logger.info(`[Crawler] Job ${job.id} done! ${getJob(job.id)?.total_parts_found || 0} OEMs`);
        return;
      }

      try {
        // FIX 1 + 2: Smart navigation — only navigate what's needed
        if (needsFullNavigation) {
          await navigateToHgPage(page, job);
          currentHgCode = null;
          needsFullNavigation = false;
        }

        // Navigate to correct HG (only if different from current)
        if (node.hg_name && node.hg_code !== currentHgCode) {
          // If we're in a different HG, navigate back to HG level first
          if (currentHgCode !== null) {
            // FIX 7: Use breadcrumb to go back to HG level
            const wentBack = await navigateBackToLevel(page, 'Hauptgruppe');
            if (!wentBack) {
              // Fallback: reload the HG page
              await navigateToHgPage(page, job);
            }
          }

          const hgClicked = await clickValueSpan(page, node.hg_name);
          if (!hgClicked) {
            logger.warn(`[Crawler] HG "${node.hg_name}" not clickable — skipping`);
            markNodeComplete(node.id, 0);
            incrementJobCompletedHg(job.id);
            continue;
          }
          currentHgCode = node.hg_code;
          await humanDelay(2000, 3000);
        }

        // Click the Bildtafel
        if (node.bildtafel_id) {
          const btClicked = await page.evaluate(`
            (() => {
              const btId = ${JSON.stringify(node.bildtafel_id)};
              const spans = document.querySelectorAll('[class*="_value_"] span, [class*="_value_"]');
              for (const s of spans) {
                if (s.textContent?.trim() === btId) {
                  const row = s.closest('[class*="_row_"], [class*="_line_"], [class*="Row"]') || s.parentElement?.parentElement;
                  if (row) { row.click(); return true; }
                  s.click();
                  return true;
                }
              }
              return false;
            })()
          `) as any as boolean;

          if (!btClicked) {
            const fallback = await clickValueSpan(page, node.bildtafel_id);
            if (!fallback) {
              markNodeComplete(node.id, 0);
              incrementJobCompletedHg(job.id);
              // FIX 2: We might still be on the Bildtafel list — don't force full re-nav
              continue;
            }
          }

          await humanDelay(3000, 5000);
          await assertNotBlocked(page, `bt-${node.bildtafel_id}`);

          // FIX 4: Extract OEMs using multi-brand patterns
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

          // FIX 2: Navigate back to Bildtafel list (same HG) instead of full re-nav
          const wentBack = await navigateBackToLevel(page, node.hg_name || 'Hauptgruppe');
          if (!wentBack) {
            // Lost our position — need to re-navigate from HG page
            currentHgCode = null;
            await navigateToHgPage(page, job);
            needsFullNavigation = false;
          }
        } else {
          // Node without Bildtafel ID — just mark as complete
          markNodeComplete(node.id, 0);
          incrementJobCompletedHg(job.id);
        }

        updateJobStatus(job.id, 'running', {
          last_hg: node.hg_code,
          last_fg: node.fg_code || undefined,
          last_bildtafel: node.bildtafel_id || undefined,
        });

        // FIX 6: Reset backoff on success
        consecutiveErrors = 0;
        currentBackoffMs = config.bulkDelayMs;

      } catch (err: any) {
        consecutiveErrors++;
        markNodeFailed(node.id, err.message);
        incrementJobErrors(job.id);

        logger.error(`[Crawler] Error on BT ${node.bildtafel_id || node.hg_code}: ${err.message}`);

        // FIX 6: Exponential backoff
        currentBackoffMs = Math.min(currentBackoffMs * 2, MAX_BACKOFF_MS);
        logger.info(`[Crawler] Backoff: waiting ${Math.round(currentBackoffMs / 1000)}s before next attempt`);

        // Check if session was lost
        if (err.message?.includes('Login failed') ||
            err.message?.includes('Bot detection') ||
            err.message?.includes('Session')) {
          needsFullNavigation = true;
          currentHgCode = null;
          resetLoginState();
        }

        if (consecutiveErrors >= config.bulkMaxConsecutiveErrors) {
          updateJobStatus(job.id, 'paused', {
            last_error: `${consecutiveErrors} consecutive errors — auto-paused: ${err.message}`,
          });
          return;
        }
      }

      // FIX 6: Use dynamic backoff delay
      await sleep(currentBackoffMs);
    }
  } finally {
    try { await page.close(); } catch { /* ignore */ }
  }
}

// ── Discover Bildtafeln ──────────────────────────────────────────────────────

async function discoverBildtafeln(job: BulkJob): Promise<Array<{
  hg_code: string; hg_name?: string; fg_code?: string; fg_name?: string; bildtafel_id?: string;
}>> {
  // FIX 5: Don't use global enqueue — avoid tripping global circuit breaker
  const ctx = getContext();
  if (!ctx) throw new Error('Browser not initialized');
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    // Navigate to HG page: Login → Dashboard → Brand → Model → Year
    await navigateToHgPage(page, job);

    // FIX 3: Read all HG entries using robust detection
    const values = await readValueSpans(page);
    const hgEntries = parseHgEntries(values);

    if (hgEntries.length === 0) {
      logger.warn(`[Crawler] No HG entries found for ${job.brand} ${job.model}`);
      await takeScreenshot(page, `no-hg-entries-${job.brand}-${job.model}`);
      // Return a single catch-all node so the job doesn't fail immediately
      return [{ hg_code: '0', hg_name: 'Unknown' }];
    }

    logger.info(`[Crawler] Found ${hgEntries.length} HG entries`);
    const allNodes: Array<{ hg_code: string; hg_name?: string; fg_code?: string; fg_name?: string; bildtafel_id?: string }> = [];

    // FIX 7: Remember the HG page URL for back-navigation
    const hgPageUrl = page.url();

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

        // FIX 7: Navigate back to HG level before clicking next HG
        const wentBack = await navigateBackToLevel(page, 'Hauptgruppe');
        if (!wentBack) {
          // Fallback: navigate directly back to the HG page URL
          try {
            await page.goto(hgPageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await humanDelay(2000, 3000);
          } catch {
            logger.warn(`[Crawler] Could not navigate back to HG page — re-navigating from scratch`);
            await navigateToHgPage(page, job);
          }
        }

      } catch (err: any) {
        logger.warn(`[Crawler] HG ${hg.code}: ${err.message}`);
        allNodes.push({ hg_code: hg.code, hg_name: hg.name });
      }
    }

    return allNodes;
  } finally {
    await page.close();
  }
}

// ── Navigate to HG Page ──────────────────────────────────────────────────────

async function navigateToHgPage(page: Page, job: BulkJob): Promise<void> {
  // Step 1: Login
  const loggedIn = await ensureLoggedIn(page);
  if (!loggedIn) {
    resetLoginState();
    await humanDelay(3000, 6000);
    const retryLogin = await ensureLoggedIn(page);
    if (!retryLogin) throw new Error('Login failed after retry');
  }

  // Step 2: Navigate directly to brand SPA
  const serviceName = PL24_SERVICE_MAP[job.brand.toUpperCase()];
  if (!serviceName) throw new Error(`No PL24 service name for brand "${job.brand}"`);

  const spaUrl = `https://www.partslink24.com/pl24-app/${serviceName}/0/0?desktop=true&lang=de`;
  await page.goto(spaUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await humanDelay(3000, 5000);

  // Step 3: Click model in SPA table
  const modelClicked = await clickValueSpan(page, job.model);
  if (!modelClicked) throw new Error(`Model "${job.model}" not found`);
  await humanDelay(2000, 3000);

  // Step 4: Check if we have years or jumped directly to HG
  const values = await readValueSpans(page);
  const hasYears = values.some(v => /^\d{4}$/.test(v));

  if (hasYears) {
    // Pick most recent year
    const years = values.filter(v => /^\d{4}$/.test(v)).sort((a, b) => parseInt(b) - parseInt(a));
    if (years.length > 0) {
      await clickValueSpan(page, years[0]);
      await humanDelay(2000, 3000);

      // Check for Einschränkungen — use robust HG detection (FIX 3)
      const newValues = await readValueSpans(page);
      const hasHg = isHgPage(newValues);

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

  // Verify we're on HG page using robust detection (FIX 3)
  const finalValues = await readValueSpans(page);
  const onHgPage = isHgPage(finalValues);
  if (!onHgPage) {
    await takeScreenshot(page, `no-hg-${job.brand}-${job.model}`);
    logger.warn(`[Crawler] HG page not detected for ${job.brand} ${job.model} — values: ${finalValues.slice(0, 10).join(', ')}`);
    // Don't silently continue — throw so the caller can handle it
    throw new Error(`HG page not detected for ${job.brand} ${job.model}`);
  }

  logger.info(`[Crawler] ✅ HG page reached for ${job.brand} ${job.model}`);
}
