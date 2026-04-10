/**
 * 🕷️ BULK CRAWLER v3 — Brand-Sequential PartsLink24 Catalog Scraper
 *
 * ARCHITECTURE: One brand at a time, fully sequential.
 * 1. Pick brand from dashboard → navigate to brand SPA
 * 2. Read all models → for each model drill down (year → restriction → HG)
 * 3. For each HG → read Bildtafeln → for each Bildtafel → extract OEMs
 * 4. When brand is 100% done → move to next brand
 *
 * VERBOSE LOGGING: Every navigation step, every click, every page state.
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
  getNextQueuedJob, getJobProgress, upsertVehicle, createJob,
} from './bulkStore';
import { bulkInsertResults } from './oemDb';

// ── State ────────────────────────────────────────────────────────────────────

let bulkRunning = false;
let bulkPaused = false;
let currentJobId: number | null = null;
let currentBrand: string | null = null;
let consecutiveErrors = 0;
let currentBackoffMs = config.bulkDelayMs;
const MAX_BACKOFF_MS = 120_000;

// ── Control ──────────────────────────────────────────────────────────────────

export function pauseBulk(): void { bulkPaused = true; }
export function resumeBulk(): void { bulkPaused = false; }
export function cancelBulk(): void {
  bulkPaused = true; bulkRunning = false;
  if (currentJobId) updateJobStatus(currentJobId, 'paused', { last_error: 'Cancelled by admin' });
  currentJobId = null;
  currentBrand = null;
}
export function getBulkState() {
  return { running: bulkRunning, paused: bulkPaused, currentJobId, currentBrand };
}

// ═══════════════════════════════════════════════════════════════════════════
// SPA HELPERS — Read and interact with PL24 React SPA
// ═══════════════════════════════════════════════════════════════════════════

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

/** Click a _value_ span AND its parent row. Returns if click succeeded. */
async function clickValueRow(page: Page, text: string): Promise<boolean> {
  const clicked: boolean = await page.evaluate(`
    (() => {
      const searchText = ${JSON.stringify(text)};
      const spans = document.querySelectorAll('[class*="_value_"] span, [class*="_value_"]');

      // Strategy 1: Exact match → click the ROW (not just the span)
      for (const s of spans) {
        if (s.children.length === 0 && s.textContent?.trim() === searchText) {
          const row = s.closest('[class*="_row_"], [class*="_line_"], [class*="Row"], tr') || s.parentElement?.parentElement;
          if (row) { row.click(); return true; }
          s.click();
          return true;
        }
      }

      // Strategy 2: Partial match → click the ROW
      for (const s of spans) {
        if (s.children.length === 0 && s.textContent?.trim().includes(searchText)) {
          const row = s.closest('[class*="_row_"], [class*="_line_"], [class*="Row"], tr') || s.parentElement?.parentElement;
          if (row) { row.click(); return true; }
          s.click();
          return true;
        }
      }
      return false;
    })()
  `) as any;

  if (clicked) {
    await waitForStable(page);
    await humanDelay(1000, 2000);
  }
  return clicked;
}

/** Log all current page values for debugging */
async function logPageState(page: Page, context: string): Promise<string[]> {
  const values = await readValueSpans(page);
  const url = page.url();
  const preview = values.slice(0, 15).join(' | ');
  logger.info(`📋 [${context}] URL: ${url}`);
  logger.info(`📋 [${context}] ${values.length} values: ${preview}${values.length > 15 ? ' ...' : ''}`);
  return values;
}

/**
 * Extract the widget ID from a PL24 SPA URL.
 * PL24 URLs encode state as base64 JSON in the path:
 *   /pl24-app/audi_parts/0/{base64_json}/
 * The JSON contains {"path":"...","wid":"mainGroupsTable"}
 */
function extractWidgetId(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const segments = urlObj.pathname.split('/').filter(Boolean);
    // Find the last segment that looks like base64 (starts with 'ey' = '{"')
    for (let i = segments.length - 1; i >= 0; i--) {
      let seg = segments[i];
      if (!seg.startsWith('ey')) continue;
      // Double URL-decode (PL24 double-encodes)
      try { seg = decodeURIComponent(seg); } catch {}
      try { seg = decodeURIComponent(seg); } catch {}
      // Pad base64 if needed
      while (seg.length % 4 !== 0) seg += '=';
      const json = Buffer.from(seg, 'base64').toString('utf-8');
      const data = JSON.parse(json);
      return data.wid || null;
    }
  } catch { /* URL parsing or base64 decode failed */ }
  return null;
}

/**
 * Detect what "level" the page is at in the PL24 SPA hierarchy.
 * PRIMARY: Decode base64 URL payload to get widget ID (100% reliable)
 * FALLBACK: Content analysis (for URLs without base64 payload)
 */
function detectPageLevel(values: string[], url?: string): string {
  // ── PRIMARY: Decode widget ID from base64 URL ──
  if (url) {
    const wid = extractWidgetId(url);
    if (wid) {
      const w = wid.toLowerCase();
      if (w.includes('subgroupsillus') || w.includes('subgroup')) return 'bildtafeln';
      if (w.includes('maingroups')) return 'hg';
      if (w.includes('restriction')) return 'restrictions';
      if (w.includes('modelyear')) return 'years';
      if (w.includes('engine')) return 'restrictions';
      if (w.includes('categorytypes')) return 'models';
      if (w.includes('partdetail') || w.includes('partinfo')) return 'parts';
      logger.info(`  ℹ️ Unknown widget ID: "${wid}" — falling back to content analysis`);
    }
  }

  // ── FALLBACK: Content-based detection ──
  // Check for Bildtafeln: XXX-YYY format
  const btMatches = values.filter(v => /^\d{3}-\d{3}$/.test(v));
  if (btMatches.length >= 2) return 'bildtafeln';

  // Check for HG page: single-digit codes followed by name ("1  Motor")
  const hgPattern = /^\d\s+.+/;
  const hgMatches = values.filter(v => hgPattern.test(v));
  if (hgMatches.length >= 3) return 'hg';

  // Check for years: 4-digit numbers
  const yearMatches = values.filter(v => /^\d{4}$/.test(v));
  if (yearMatches.length >= 3) return 'years';

  // Check for OEM numbers
  const oemMatches = values.filter(v => /^[A-Z0-9]{2,4}[\s.-]\d{3}[\s.-]\d{3}/.test(v));
  if (oemMatches.length >= 2) return 'parts';

  // If values are mostly multi-word strings > 5 chars, likely models
  const modelLike = values.filter(v => v.length > 4 && !/^\d+$/.test(v));
  if (modelLike.length >= 5) return 'models';

  return 'unknown';
}

/**
 * Extract OEM numbers from the current page using multi-brand patterns.
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

      const oemPatterns = [
        /^[A-Z0-9]{3}\\s\\d{3}\\s\\d{3}(\\s[A-Z0-9]{0,3})?$/,
        /^\\d{2}\\s\\d{2}\\s\\d\\s\\d{3}\\s\\d{3}$/,
        /^[A-Z]\\s?\\d{3}\\s?\\d{3}\\s?\\d{2}\\s?\\d{2}$/,
        /^9[A-Z]\\d\\s?\\d{3}\\s?\\d{3}\\s?\\d{2}$/,
        /^[A-Z0-9]{2,4}[\\s.-]\\d{3}[\\s.-]\\d{3}[\\s.-]?[A-Z0-9]{0,3}$/,
      ];

      const results = [];
      const seen = new Set();

      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const isOem = oemPatterns.some(p => p.test(v));
        const stripped = v.replace(/[\\s.-]/g, '');
        const structuralOem = !isOem &&
          stripped.length >= 7 && stripped.length <= 15 &&
          /^[A-Z0-9]+$/.test(stripped) &&
          /\\d/.test(stripped) && /[A-Z]/.test(stripped);

        if ((isOem || structuralOem) && !seen.has(stripped)) {
          seen.add(stripped);
          const desc = (i + 1 < values.length && !oemPatterns.some(p => p.test(values[i + 1])))
            ? values[i + 1] : '';
          results.push({ oem: v, description: desc });
        }
      }
      return results;
    })()
  `) as any as Array<{ oem: string; description: string }>;
}

/** Navigate back using breadcrumb or browser back */
async function goBack(page: Page, label: string): Promise<boolean> {
  // Try breadcrumb first
  const crumbClicked: boolean = await page.evaluate(`
    (() => {
      const crumbs = document.querySelectorAll(
        '[class*="breadcrumb"] a, [class*="breadcrumb"] span, ' +
        '[class*="_crumb_"] a, [class*="_crumb_"] span'
      );
      if (crumbs.length > 1) {
        crumbs[crumbs.length - 2].click();
        return true;
      }
      return false;
    })()
  `) as any;

  if (crumbClicked) {
    logger.info(`  ← Breadcrumb back (${label})`);
    await waitForStable(page);
    await humanDelay(1000, 2000);
    return true;
  }

  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
    logger.info(`  ← Browser back (${label})`);
    await humanDelay(1000, 2000);
    return true;
  } catch {
    logger.warn(`  ⚠ Could not go back (${label})`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCOVER MODE — List all brands and models from PL24
// ═══════════════════════════════════════════════════════════════════════════

export interface DiscoveredModel { brand: string; model: string; }

export async function discoverBrandsAndModels(): Promise<{
  brands: string[]; models: DiscoveredModel[]; errors: string[];
}> {
  const ctx = getContext();
  if (!ctx) throw new Error('Browser not initialized');

  const allModels: DiscoveredModel[] = [];
  const discoveredBrands: string[] = [];
  const errors: string[] = [];

  let page: Page | null = null;
  let retries = 0;

  while (retries <= 2) {
    try {
      page = await ctx.newPage();
      await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
      const loggedIn = await ensureLoggedIn(page);
      if (!loggedIn) throw new Error('Login failed');
      logger.info('🔑 [Discover] Login OK');
      break;
    } catch (err: any) {
      retries++;
      if (page) { try { await page.close(); } catch {} page = null; }
      if (retries > 2) throw new Error(`Login failed after 3 attempts`);
      resetLoginState();
      await humanDelay(1500, 3000);
    }
  }
  if (!page) throw new Error('No page after login');

  try {
    const brandsToDiscover = Object.keys(PL24_SERVICE_MAP);
    logger.info(`🏭 [Discover] Starting discovery for ${brandsToDiscover.length} brands...`);

    for (let i = 0; i < brandsToDiscover.length; i++) {
      const brandKey = brandsToDiscover[i];
      if (bulkPaused) { logger.info('⏸ Discovery paused by admin'); break; }

      const serviceName = PL24_SERVICE_MAP[brandKey];
      if (!serviceName) continue;

      logger.info(`\n${'═'.repeat(60)}`);
      logger.info(`🏷️ [Discover] Brand ${i + 1}/${brandsToDiscover.length}: ${brandKey}`);
      logger.info(`${'═'.repeat(60)}`);

      try {
        const spaUrl = `https://www.partslink24.com/pl24-app/${serviceName}/0/0?desktop=true&lang=de`;
        await page.goto(spaUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanDelay(800, 1500);
        await assertNotBlocked(page, `discover-${brandKey}`);

        const values = await logPageState(page, `Discover ${brandKey}`);

        const models = values.filter(v =>
          v.length > 3 && v.length < 50 &&
          !/^(Modell|Modelljahr|Einschränkung|Hauptgruppe|Startseite|Direkteinstieg)/.test(v) &&
          !/^\d{4}$/.test(v) && !/^\d{1,2}$/.test(v)
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
          logger.info(`  ✅ ${brandKey}: ${models.length} models found`);
        } else {
          logger.info(`  ⚠ ${brandKey}: No models found (0 value spans or all filtered out)`);
        }

      } catch (err: any) {
        logger.error(`  ❌ ${brandKey}: ${err.message}`);
        errors.push(`${brandKey}: ${err.message}`);
      }

      await sleep(config.bulkDelayMs);
    }

    logger.info(`\n${'═'.repeat(60)}`);
    logger.info(`🏁 [Discover] Complete! ${discoveredBrands.length} brands, ${allModels.length} models total`);
    logger.info(`${'═'.repeat(60)}`);

    return { brands: discoveredBrands, models: allModels, errors };
  } finally {
    await page.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CRAWL MODE — Brand-Sequential Full Catalog Crawl
// ═══════════════════════════════════════════════════════════════════════════

/** Crawl a SINGLE brand completely: all models → all HGs → all Bildtafeln → all OEMs */
export async function crawlSingleBrand(brand: string): Promise<{
  brand: string; modelsFound: number; totalOems: number; errors: string[];
}> {
  if (bulkRunning) throw new Error(`Crawler already running on ${currentBrand || 'unknown'}`);

  const serviceName = PL24_SERVICE_MAP[brand.toUpperCase()];
  if (!serviceName) throw new Error(`No PL24 service for brand "${brand}"`);

  bulkRunning = true;
  bulkPaused = false;
  currentBrand = brand.toUpperCase();
  consecutiveErrors = 0;
  currentBackoffMs = config.bulkDelayMs;

  const errors: string[] = [];
  let totalOems = 0;
  let modelsFound = 0;

  const ctx = getContext();
  if (!ctx) throw new Error('Browser not initialized');

  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });

  try {
    // ── Step 1: Login ──
    logger.info(`\n${'█'.repeat(60)}`);
    logger.info(`🏭 CRAWLING BRAND: ${brand.toUpperCase()}`);
    logger.info(`${'█'.repeat(60)}\n`);

    const loggedIn = await ensureLoggedIn(page);
    if (!loggedIn) {
      resetLoginState();
      const retry = await ensureLoggedIn(page);
      if (!retry) throw new Error('Login failed');
    }
    logger.info('🔑 Login OK');

    // ── Create vehicle + job for tracking ──
    const vehicleVin = `PL24-${brand.toUpperCase()}-BRAND`;
    const vehicleId = upsertVehicle({ vin: vehicleVin, brand: brand.toUpperCase(), model: `ALL (${brand})` });
    const job = createJob(vehicleId);
    const jobId = job.id;
    currentJobId = jobId;
    updateJobStatus(jobId, 'running');
    logger.info(`📝 Created job #${jobId} for brand ${brand}`);

    // ── Step 2: Navigate to brand SPA ──
    const spaUrl = `https://www.partslink24.com/pl24-app/${serviceName}/0/0?desktop=true&lang=de`;
    logger.info(`🌐 Navigating to: ${spaUrl}`);
    await page.goto(spaUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(800, 1500);
    await assertNotBlocked(page, `brand-${brand}`);

    // ── Step 3: Read model list ──
    const modelValues = await logPageState(page, 'Model List');
    const models = modelValues.filter(v =>
      v.length > 3 && v.length < 50 &&
      !/^(Modell|Modelljahr|Einschränkung|Hauptgruppe|Startseite|Direkteinstieg)/.test(v) &&
      !/^\d{4}$/.test(v) && !/^\d{1,2}$/.test(v)
    );

    modelsFound = models.length;
    logger.info(`\n📋 Found ${models.length} models for ${brand}:`);
    models.forEach((m, i) => logger.info(`  ${i + 1}. ${m}`));

    if (models.length === 0) {
      logger.warn(`⚠ No models found for ${brand} — skipping`);
      return { brand, modelsFound: 0, totalOems: 0, errors: ['No models found'] };
    }

    // ── Step 4: Process EACH model ──
    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      if (bulkPaused) { logger.info('⏸ Paused by admin'); break; }

      // Extract internal model code from caption: "A3 (8P)" → "8P"
      const modelCodeMatch = model.match(/\(([A-Z0-9]{1,5})\)\s*$/);
      const modelCode = modelCodeMatch?.[1] || null;

      // These will be populated during year/restriction drill-down below
      let yearFrom: number | null = null;
      let yearTo: number | null = null;
      let engineLabel: string | null = null;

      logger.info(`\n${'─'.repeat(50)}`);
      logger.info(`📦 Model ${mi + 1}/${models.length}: ${brand} ${model}${modelCode ? ` [code: ${modelCode}]` : ''}`);
      logger.info(`${'─'.repeat(50)}`);

      try {
        // Navigate back to model list for this brand
        if (mi > 0) {
          logger.info('  ↩ Navigating back to model list...');
          await page.goto(spaUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await humanDelay(800, 1500);
        }

        // Click model
        logger.info(`  🖱 Clicking model: "${model}"`);
        const modelClicked = await clickValueRow(page, model);
        if (!modelClicked) {
          logger.error(`  ❌ Could not click model "${model}" — skipping`);
          errors.push(`${model}: Click failed`);
          continue;
        }

        // Check what page we landed on
        let values = await logPageState(page, `After click "${model}"`);
        let level = detectPageLevel(values, page.url());
        logger.info(`  📍 Page level: ${level} (URL-based)`);

        // ── Drill down through levels until we reach HG ──
        let maxDrillDown = 5;
        while (level !== 'hg' && maxDrillDown > 0) {
          maxDrillDown--;

          if (level === 'years') {
            // Capture full year range (for AI part matching), then pick most recent for drill-down
            const yearStrs = values.filter(v => /^\d{4}$/.test(v));
            const yearNums = yearStrs.map(s => parseInt(s)).filter(n => n > 1900 && n < 2100);
            if (yearNums.length > 0) {
              yearFrom = Math.min(...yearNums);
              yearTo = Math.max(...yearNums);
            }
            const years = yearStrs.sort((a, b) => parseInt(b) - parseInt(a));
            if (years.length > 0) {
              logger.info(`  📅 Year range: ${yearFrom}-${yearTo}, drilling into ${years[0]} (from ${years.length} available)`);
              await clickValueRow(page, years[0]);
              values = await logPageState(page, `After year ${years[0]}`);
              level = detectPageLevel(values, page.url());
              logger.info(`  📍 Page level: ${level} (URL-based)`);
            } else {
              break;
            }
          } else if (level === 'models' || level === 'restrictions' || level === 'unknown') {
            // Restriction or sub-model list — filter out sidebar model names
            // Sidebar always shows all models (e.g., "Audi A3", "Audi A4")
            // so we skip values that look like model entries from the sidebar
            const brandPrefix = brand.charAt(0) + brand.slice(1).toLowerCase(); // "AUDI" → "Audi"
            const options = values.filter(v =>
              v.length > 2 &&
              !/^\d{4}$/.test(v) &&                 // not years
              !/^\d{1,2}$/.test(v) &&                // not single/double digits
              !/^\d\s+.+/.test(v) &&                 // not HG entries like "1  Motor"
              !/^(Modell|Hauptgruppe|Einschränkung|Modelljahr|Startseite|Kataloginformationen)/.test(v) &&
              !v.startsWith(brandPrefix) &&          // not sidebar model names ("Audi A3")
              !v.startsWith(brand) &&                // not sidebar model names ("AUDI A3")
              !/^(Sonderkataloge|Elektrische|Chemische|MSP|Seiten)/.test(v) // not footer items
            );

            logger.info(`  🔍 Restriction/drill-down candidates: ${options.length} (filtered from ${values.length} total)`);
            if (options.length > 0) {
              // Capture the first restriction label as engine context
              // (it's the one we're actually drilling into)
              if (level === 'restrictions' && !engineLabel) {
                engineLabel = options[0];
                logger.info(`  🔧 Engine/restriction: "${engineLabel}"`);
              }
              logger.info(`  🔽 Drill-down: clicking "${options[0]}" (from: ${options.slice(0, 5).join(', ')})`);
              await clickValueRow(page, options[0]);
              values = await logPageState(page, `After drill-down "${options[0]}"`);
              level = detectPageLevel(values, page.url());
              logger.info(`  📍 Page level: ${level}`);
            } else {
              logger.warn(`  ⚠ No drill-down options found — giving up on ${model}`);
              break;
            }
          } else {
            break;
          }
        }

        if (level !== 'hg') {
          logger.warn(`  ⚠ Could not reach HG page for ${model} (stuck at level: ${level})`);
          errors.push(`${model}: Stuck at ${level}`);
          await takeScreenshot(page, `stuck-${brand}-${model.replace(/[^a-zA-Z0-9]/g, '-')}`);
          continue;
        }

        // ── We're on the HG page! Parse HG entries ──
        const hgEntries = parseHgEntries(values);
        logger.info(`  ✅ HG page reached — ${hgEntries.length} Hauptgruppen found:`);
        hgEntries.forEach(h => logger.info(`     HG ${h.code}: ${h.name}`));

        // Save the HG page URL for back-navigation
        const hgPageUrl = page.url();

        // ── Process each HG ──
        for (let hi = 0; hi < hgEntries.length; hi++) {
          const hg = hgEntries[hi];
          if (bulkPaused) break;

          logger.info(`\n    ┌── HG ${hi + 1}/${hgEntries.length}: ${hg.code} ${hg.name}`);

          try {
            // Navigate to this HG
            if (hi > 0) {
              // Go back to HG page
              await page.goto(hgPageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
              await humanDelay(1000, 2000);
            }

            // Click using FULL text (e.g., "1  Motor") — not just the name ("Motor")
            // because PL24 spans contain the full HG text, not just the name
            const fullHgText = values.find(v => new RegExp(`^${hg.code}\\s+`).test(v));
            const clickTarget = fullHgText || hg.name;
            logger.info(`    │ 🖱 Clicking HG: "${clickTarget}"`);
            const hgClicked = await clickValueRow(page, clickTarget);
            if (!hgClicked) {
              // Fallback: try name only, then code
              logger.info(`    │ 🔄 Retry with name: "${hg.name}"`);
              const nameClicked = await clickValueRow(page, hg.name);
              if (!nameClicked) {
                logger.info(`    │ 🔄 Retry with code: "${hg.code}"`);
                const codeClicked = await clickValueRow(page, hg.code);
                if (!codeClicked) {
                  logger.warn(`    │ ⚠ Could not click HG ${hg.code} — skipping`);
                  continue;
                }
              }
            }

            // Verify URL actually changed after HG click
            const postHgUrl = page.url();
            if (postHgUrl === hgPageUrl) {
              logger.warn(`    │ ⚠ URL did not change after HG click — click may not have navigated`);
              await humanDelay(1000, 2000);
            }

            const btValues = await logPageState(page, `HG ${hg.code} ${hg.name}`);
            const btLevel = detectPageLevel(btValues, page.url());
            logger.info(`    │ 📍 Post-HG level: ${btLevel} (URL-based)`);

            if (btLevel === 'bildtafeln') {
              // ── Parse subgroup entries from the page ──
              // PL24 subGroupsIllusTable shows Untergruppen (UG) with 2-digit codes
              // AND/OR Bildtafeln (BT) with XXX-YYY format
              
              // Debug: Log non-sidebar values to understand format
              const contentValues = btValues.filter(v =>
                !/^\d\s+.+/.test(v) &&  // not HG entries
                !/^(Kataloginformationen|V|Seiten|MSP|Alle Gruppen)/.test(v) &&
                v.length > 0
              );
              logger.info(`    │ 🔍 Content values (first 30): ${contentValues.slice(0, 30).join(' | ')}`);

              // Try BT pattern: In PL24, Bildtafeln appear as THREE consecutive spans:
              //   UG (2-digit) | Nummer1 (3-digit) | Nummer2 (3-digit) | Benennung (text)
              // Example: "21" | "121" | "000" | "Kühlmittelkühlung"
              // We combine Nummer1+Nummer2 into "121-000" as the Bildtafel ID
              const bildtafeln: Array<{ bt: string; ug: string; name: string }> = [];
              const seenBt = new Set<string>();

              for (let i = 0; i < btValues.length - 2; i++) {
                // Pattern: 2-digit UG + 3-digit + 3-digit
                if (/^\d{2}$/.test(btValues[i]) && /^\d{3}$/.test(btValues[i + 1]) && /^\d{3}$/.test(btValues[i + 2])) {
                  const ug = btValues[i];
                  const bt = `${btValues[i + 1]}-${btValues[i + 2]}`;
                  if (!seenBt.has(bt)) {
                    seenBt.add(bt);
                    // Name is the next value after the 3 numbers (if it's text, not another number)
                    const name = (i + 3 < btValues.length && !/^\d{2,3}$/.test(btValues[i + 3]))
                      ? btValues[i + 3] : '';
                    bildtafeln.push({ bt, ug, name });
                  }
                }
              }

              // Also try original XXX-YYY pattern (some brands may use it)
              for (let i = 0; i < btValues.length; i++) {
                if (/^\d{3}-\d{3}$/.test(btValues[i]) && !seenBt.has(btValues[i])) {
                  seenBt.add(btValues[i]);
                  const ug = (i > 0 && /^\d{2}$/.test(btValues[i - 1])) ? btValues[i - 1] : '00';
                  const name = (i + 1 < btValues.length && !/^\d{2,3}/.test(btValues[i + 1])) ? btValues[i + 1] : '';
                  bildtafeln.push({ bt: btValues[i], ug, name });
                }
              }

              if (bildtafeln.length > 0) {
                // ── Original BT scraping ──
                logger.info(`    │ 📄 ${bildtafeln.length} Bildtafeln found (XXX-YYY format)`);
                const btPageUrl = page.url();

                for (let bi = 0; bi < bildtafeln.length; bi++) {
                  const bt = bildtafeln[bi];
                  if (bulkPaused) break;

                  try {
                    if (bi > 0) {
                      await page.goto(btPageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                      await humanDelay(1000, 1500);
                    }

                    logger.info(`    │ 🖱 BT ${bi + 1}/${bildtafeln.length}: ${bt.bt} (${bt.name})`);
                    // Bildtafel ID is split across spans (e.g., "121" + "000"), so click by:
                    // 1. Description text (most unique)
                    // 2. Second part of BT number
                    // 3. First part of BT number
                    const btParts = bt.bt.split('-');
                    let btClicked = false;
                    if (bt.name) btClicked = await clickValueRow(page, bt.name);
                    if (!btClicked && btParts.length === 2) btClicked = await clickValueRow(page, btParts[1]);
                    if (!btClicked && btParts.length === 2) btClicked = await clickValueRow(page, btParts[0]);
                    if (!btClicked) btClicked = await clickValueRow(page, bt.bt);
                    if (!btClicked) {
                      logger.warn(`    │ ⚠ Could not click BT ${bt.bt}`);
                      continue;
                    }

                    await assertNotBlocked(page, `bt-${bt.bt}`);
                    const oems = await extractOemsFromPage(page);

                    if (oems.length > 0) {
                      const rows = oems.map(o => ({
                        vin: `PL24-${brand}-${model.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30)}`,
                        brand: brand.toUpperCase(), model,
                        oem: o.oem, description: o.description,
                        bildtafel: bt.bt,
                        hg_code: hg.code, hg_name: hg.name,
                        fg_code: bt.ug, fg_name: bt.name,
                        year_from: yearFrom, year_to: yearTo,
                        model_code: modelCode, engine: engineLabel,
                      }));
                      const inserted = insertResults(jobId, rows);
                      incrementJobParts(jobId, inserted);
                      totalOems += inserted;
                      // Push to OEM PostgreSQL for long-term storage (fire-and-forget)
                      bulkInsertResults(rows).catch(() => {});
                      logger.info(`    │ ✅ BT ${bt.bt}: ${inserted} OEMs stored (total: ${totalOems})`);
                      oems.slice(0, 3).forEach(o => logger.info(`    │    ${o.oem} — ${o.description}`));
                    } else {
                      logger.info(`    │ ○ BT ${bt.bt}: 0 OEMs`);
                    }

                    consecutiveErrors = 0;
                    currentBackoffMs = config.bulkDelayMs;
                  } catch (err: any) {
                    consecutiveErrors++;
                    logger.error(`    │ ❌ BT ${bt.bt}: ${err.message}`);
                    errors.push(`${model}/HG${hg.code}/BT${bt.bt}: ${err.message}`);
                    currentBackoffMs = Math.min(currentBackoffMs * 2, MAX_BACKOFF_MS);
                    if (consecutiveErrors >= config.bulkMaxConsecutiveErrors) {
                      logger.error(`    │ 🛑 ${consecutiveErrors} consecutive errors — pausing`);
                      bulkPaused = true;
                      break;
                    }
                  }
                  await sleep(currentBackoffMs);
                }
              } else {
                // ── No BTs found → Look for UG entries (2-digit codes) ──
                // PL24 subGroupsIllusTable often shows UG entries directly
                const ugEntries: Array<{ code: string; name: string; fullText: string }> = [];
                const seen = new Set<string>();
                for (let i = 0; i < btValues.length; i++) {
                  const v = btValues[i];
                  if (/^\d{2}$/.test(v) && !seen.has(v) && parseInt(v) >= 10) {
                    seen.add(v);
                    const name = (i + 1 < btValues.length && !/^\d{1,3}(-\d{3})?$/.test(btValues[i + 1]))
                      ? btValues[i + 1] : '';
                    ugEntries.push({ code: v, name, fullText: name ? `${v}  ${name}` : v });
                  }
                }

                logger.info(`    │ 📂 ${ugEntries.length} Untergruppen (UG) found — clicking each to find OEMs`);
                if (ugEntries.length > 0) {
                  ugEntries.slice(0, 5).forEach(u => logger.info(`    │    UG ${u.code}: ${u.name}`));
                  if (ugEntries.length > 5) logger.info(`    │    ... and ${ugEntries.length - 5} more`);
                }

                const subGroupUrl = page.url();

                for (let ui = 0; ui < ugEntries.length; ui++) {
                  const ug = ugEntries[ui];
                  if (bulkPaused) break;

                  try {
                    if (ui > 0) {
                      await page.goto(subGroupUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                      await humanDelay(800, 1500);
                    }

                    logger.info(`    │ 🖱 UG ${ui + 1}/${ugEntries.length}: ${ug.code} ${ug.name}`);
                    // Try clicking by code first, then full text
                    let ugClicked = await clickValueRow(page, ug.code);
                    if (!ugClicked && ug.name) {
                      ugClicked = await clickValueRow(page, ug.name);
                    }
                    if (!ugClicked) {
                      logger.warn(`    │ ⚠ Could not click UG ${ug.code} — skipping`);
                      continue;
                    }

                    await humanDelay(1000, 2000);

                    // Check what page we're on after clicking UG
                    const ugLevel = detectPageLevel([], page.url());
                    logger.info(`    │ 📍 Post-UG level: ${ugLevel}`);

                    // Try to extract OEMs from whatever page we landed on
                    const oems = await extractOemsFromPage(page);

                    if (oems.length > 0) {
                      const rows = oems.map(o => ({
                        vin: `PL24-${brand}-${model.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30)}`,
                        brand: brand.toUpperCase(), model,
                        oem: o.oem, description: o.description,
                        bildtafel: ug.code,
                        hg_code: hg.code, hg_name: hg.name,
                        fg_code: ug.code, fg_name: ug.name,
                        year_from: yearFrom, year_to: yearTo,
                        model_code: modelCode, engine: engineLabel,
                      }));
                      const inserted = insertResults(jobId, rows);
                      incrementJobParts(jobId, inserted);
                      totalOems += inserted;
                      bulkInsertResults(rows).catch(() => {});
                      logger.info(`    │ ✅ UG ${ug.code}: ${inserted} OEMs stored (total: ${totalOems})`);
                      oems.slice(0, 3).forEach(o => logger.info(`    │    ${o.oem} — ${o.description}`));
                      if (oems.length > 3) logger.info(`    │    ... and ${oems.length - 3} more`);
                    } else {
                      logger.info(`    │ ○ UG ${ug.code}: 0 OEMs (may need deeper drill-down)`);
                    }

                    consecutiveErrors = 0;
                    currentBackoffMs = config.bulkDelayMs;
                  } catch (err: any) {
                    consecutiveErrors++;
                    logger.error(`    │ ❌ UG ${ug.code}: ${err.message}`);
                    errors.push(`${model}/HG${hg.code}/UG${ug.code}: ${err.message}`);
                    currentBackoffMs = Math.min(currentBackoffMs * 2, MAX_BACKOFF_MS);
                    if (consecutiveErrors >= config.bulkMaxConsecutiveErrors) {
                      bulkPaused = true;
                      break;
                    }
                  }
                  await sleep(currentBackoffMs);
                }
              }

            } else if (btLevel === 'parts') {
              // HG directly shows parts (no Bildtafeln)
              const oems = await extractOemsFromPage(page);
              if (oems.length > 0) {
                const rows = oems.map(o => ({
                  vin: vehicleVin,
                  brand: brand.toUpperCase(), model,
                  oem: o.oem, description: o.description,
                  bildtafel: undefined,
                  hg_code: hg.code, hg_name: hg.name,
                  fg_code: undefined, fg_name: undefined,
                  year_from: yearFrom, year_to: yearTo,
                  model_code: modelCode, engine: engineLabel,
                }));
                const inserted = insertResults(jobId, rows);
                incrementJobParts(jobId, inserted);
                totalOems += inserted;
                bulkInsertResults(rows).catch(() => {});
              }
              logger.info(`    │ ✅ Direct parts page: ${oems.length} OEMs`);
            } else {
              logger.warn(`    │ ⚠ Unexpected page level after HG click: ${btLevel}`);
            }

            logger.info(`    └── HG ${hg.code} done`);

          } catch (err: any) {
            logger.error(`    └── ❌ HG ${hg.code}: ${err.message}`);
            errors.push(`${model}/HG${hg.code}: ${err.message}`);
          }
        }

        logger.info(`  📊 Model "${model}" complete — ${totalOems} OEMs total so far`);

      } catch (err: any) {
        logger.error(`  ❌ Model "${model}": ${err.message}`);
        errors.push(`${model}: ${err.message}`);
      }

      await sleep(config.bulkDelayMs);
    }

    logger.info(`\n${'█'.repeat(60)}`);
    logger.info(`🏁 BRAND "${brand}" COMPLETE`);
    logger.info(`   Models: ${modelsFound}`);
    logger.info(`   OEMs found: ${totalOems}`);
    logger.info(`   Errors: ${errors.length}`);
    logger.info(`${'█'.repeat(60)}\n`);

    return { brand, modelsFound, totalOems, errors };

  } finally {
    // Update job status
    if (currentJobId) {
      const finalStatus = bulkPaused ? 'paused' : (consecutiveErrors >= config.bulkMaxConsecutiveErrors ? 'failed' : 'completed');
      updateJobStatus(currentJobId, finalStatus, {
        total_parts_found: totalOems,
        last_error: errors.length > 0 ? errors[errors.length - 1] : undefined,
      });
      logger.info(`📝 Job #${currentJobId} → ${finalStatus} (${totalOems} OEMs)`);
    }
    try { await page.close(); } catch {}
    bulkRunning = false;
    currentBrand = null;
    currentJobId = null;
  }
}

/**
 * Parse HG entries from value spans.
 */
function parseHgEntries(values: string[]): Array<{ code: string; name: string }> {
  const entries: Array<{ code: string; name: string }> = [];

  for (const v of values) {
    const match = v.match(/^(\d)\s+(.+)/);
    if (match) entries.push({ code: match[1], name: match[2] });
  }

  if (entries.length > 0) return entries;

  // Fallback: match known HG names
  const knownHgMap: Record<string, string> = {
    'Motor': '1', 'Kraftstoff': '2', 'Getriebe': '3',
    'Vorderachse': '4', 'Hinterachse': '5', 'Räder': '6',
    'Hebelwerk': '7', 'Karosserie': '8', 'Elektrik': '9', 'Zubehör': '0',
  };

  for (const v of values) {
    for (const [name, code] of Object.entries(knownHgMap)) {
      if (v.includes(name) && !entries.some(e => e.name === v)) {
        entries.push({ code, name: v });
        break;
      }
    }
  }

  return entries;
}

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY JOB-BASED CRAWL (kept for API compatibility)
// ═══════════════════════════════════════════════════════════════════════════

export async function startCrawl(jobId: number): Promise<void> {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  if (bulkRunning) {
    updateJobStatus(jobId, 'queued');
    return;
  }

  // Use the new brand-sequential approach
  try {
    const result = await crawlSingleBrand(job.brand);
    updateJobStatus(jobId, 'completed', {
      total_parts_found: result.totalOems,
      last_error: result.errors.length > 0 ? result.errors[result.errors.length - 1] : undefined,
    });
  } catch (err: any) {
    updateJobStatus(jobId, 'failed', { last_error: err.message });
  }
}
