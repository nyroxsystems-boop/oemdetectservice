/**
 * ⚡ API CRAWLER — Direct PL24 REST API Access (10-20x faster than browser mode)
 *
 * Instead of clicking through the PL24 React SPA, this calls the underlying
 * REST API directly using page.evaluate(fetch). The session cookies from the
 * Playwright login are reused for auth.
 *
 * API endpoints discovered via network interception (April 2026):
 *
 * 1. /p5vwag/extern/vehicle/modelfamilies?serviceName={brand}_parts
 *    → {data: {records: [{values: {caption}, link: {path}}]}}
 *
 * 2. /p5vwag/extern/vehicle/modelyears?familyKey={key}
 *    → years with links to maingroups or restrictions
 *
 * 3. /p5vwag/extern/groups/mdl_maingroups?...
 *    → HG entries (1 Motor, 2 Kraftstoff, etc.) with links to subgroups
 *
 * 4. /p5vwag/extern/groups/mdl_subgroups_illus?...
 *    → Bildtafeln with illustrationNumber and links to BOM
 *
 * 5. /p5vwag/extern/bom/mdl?...
 *    → Parts with partNo (OEM number) and caption (description)
 *
 * Auth: Session cookies from Playwright login (fetch inside page context)
 */

import { Page } from 'playwright';
import { logger } from './logger';
import { config } from './config';
import {
  ensureLoggedIn, getContext, PL24_SERVICE_MAP,
  sleep, humanDelay, resetLoginState,
} from './scraper';
import {
  insertResults, incrementJobParts, createJob, updateJobStatus,
  getJob, upsertVehicle, getBulkStats,
} from './bulkStore';

// ── Shared state with bulkCrawler (import the setters) ───────────────────────
// We need to set bulkRunning/currentBrand so the UI shows the correct status

let apiRunning = false;
let apiCurrentBrand: string | null = null;

export function getApiState() {
  return { running: apiRunning, currentBrand: apiCurrentBrand };
}

export function cancelApi(): void {
  apiRunning = false;
  apiCurrentBrand = null;
  apiAborted = true;
}

let apiAborted = false;

export function isApiAborted(): boolean {
  return apiAborted;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface PL24Record {
  id?: string;
  values: Record<string, string>;
  link?: { path: string; wid?: string };
  unavailable?: boolean;
}

interface PL24Response {
  data: { records: PL24Record[] };
  crumbs?: Array<{ name: string }>;
  demo?: boolean;
}

// ── API Helper ───────────────────────────────────────────────────────────────

/**
 * Call a PL24 API endpoint using the browser's session cookies.
 * This runs fetch() INSIDE the page context so cookies are sent automatically.
 */
async function pl24Fetch(page: Page, apiPath: string): Promise<PL24Response> {
  const result = await page.evaluate(`
    (function() {
      return fetch(${JSON.stringify(apiPath)})
        .then(function(r) {
          if (!r.ok) return { error: r.status, data: { records: [] } };
          return r.json();
        })
        .catch(function(e) { return { error: e.message, data: { records: [] } }; });
    })()
  `) as any;

  if (result.error) {
    throw new Error(`PL24 API ${result.error}: ${apiPath.substring(0, 80)}`);
  }

  return result as PL24Response;
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

export async function crawlBrandViaApi(brand: string): Promise<{
  brand: string; modelsFound: number; totalOems: number; errors: string[];
}> {
  const brandUpper = brand.toUpperCase();
  const serviceName = PL24_SERVICE_MAP[brandUpper];
  if (!serviceName) throw new Error(`Unknown brand: ${brand}`);

  const ctx = getContext();
  if (!ctx) throw new Error('Browser not initialized');

  logger.info(`\n⚡ API CRAWLER: ${brandUpper}`);
  logger.info(`${'═'.repeat(60)}`);

  // Create a page just for login + API calls (no UI interaction needed)
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  let totalOems = 0;
  const errors: string[] = [];
  let modelsFound = 0;

  apiRunning = true;
  apiCurrentBrand = brandUpper;
  apiAborted = false;

  try {
    // Step 1: Login (reuses existing session if valid)
    let loggedIn = await ensureLoggedIn(page);
    if (!loggedIn) {
      resetLoginState();
      await humanDelay(2000, 4000);
      loggedIn = await ensureLoggedIn(page);
      if (!loggedIn) throw new Error('Login failed');
    }
    logger.info('⚡ Login OK');

    // Step 2: Navigate to brand SPA via the dashboard link (transfers JSP session → SPA)
    // We need to click the actual launchCatalog link from the dashboard to get the session token
    logger.info('⚡ Clicking brand link on dashboard to transfer session to SPA...');

    // Find and click the brand link on the dashboard page
    const brandLinkClicked = await page.evaluate(`
      (() => {
        const links = document.querySelectorAll('a[href*="launchCatalog"][href*="${serviceName}"]');
        if (links.length > 0) { links[0].click(); return true; }
        return false;
      })()
    `) as any as boolean;

    if (!brandLinkClicked) {
      // Fallback: navigate directly
      logger.warn('⚡ Brand link not found on dashboard, trying direct navigation');
      await page.goto(`https://www.partslink24.com/partslink24/launchCatalog.do?service=${serviceName}`, {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
    }

    // Wait for SPA to load
    try {
      await page.waitForURL(/\/pl24-app\//, { timeout: 20000 });
    } catch {
      logger.warn('⚡ SPA URL not detected after brand click');
    }
    await sleep(3000);

    const spaUrl = page.url();
    const isDemo = spaUrl.includes('/demo');
    logger.info(`⚡ SPA URL: ${spaUrl.substring(0, 80)}${isDemo ? ' ⚠️ DEMO MODE!' : ' ✅ Authenticated'}`);

    if (isDemo) {
      throw new Error('SPA loaded in demo mode — session transfer failed');
    }

    // Step 3: Fetch model list via API
    const upds = '2026-03-27--00-02'; // PL24 update timestamp
    const modelsResp = await pl24Fetch(page,
      `/p5vwag/extern/vehicle/modelfamilies?lang=de&localMarketOnly=true&serviceName=${serviceName}&upds=${upds}`
    );

    // Filter: keep all models with a caption and a link, skip catalog info entries
    const skipNames = ['Sonderkataloge', 'Elektrische Verbind.', 'Chemische Stoffe',
      'Serviceteile', 'Kataloginformationen', 'V-Seiten', 'MSP-Seiten'];
    const models = modelsResp.data.records.filter(r =>
      r.values?.caption &&
      r.link?.path &&
      !skipNames.includes(r.values.caption)
      // NOTE: removed !r.unavailable — was filtering out most models
    );
    modelsFound = models.length;
    logger.info(`⚡ ${brandUpper}: ${models.length} models found`);

    // Create job for tracking
    const vehicleVin = `PL24-API-${brandUpper}`;
    try { upsertVehicle({ vin: vehicleVin, brand: brandUpper, model: 'ALL' }); } catch { /* dup */ }
    const job = createJob(1); // Use vehicle ID 1 as placeholder
    const jobId = job.id;
    updateJobStatus(jobId, 'running', { total_hg: models.length });

    // Step 4: Process each model
    for (let mi = 0; mi < models.length; mi++) {
      if (apiAborted) { logger.info('⚡ ABORTED by admin'); break; }
      const model = models[mi];
      const modelName = model.values.caption;
      if (!model.link?.path) continue;

      logger.info(`\n⚡ [${mi + 1}/${models.length}] ${modelName}`);

      try {
        // Get years
        const yearsResp = await pl24Fetch(page, model.link.path);
        const years = yearsResp.data.records.filter(r => r.values?.caption && r.link?.path);

        if (years.length === 0) {
          logger.warn(`  ⚡ No years for ${modelName}`);
          continue;
        }

        // Pick most recent year
        const sortedYears = years.sort((a, b) =>
          parseInt(b.values.caption || '0') - parseInt(a.values.caption || '0')
        );
        const year = sortedYears[0];
        logger.info(`  ⚡ Year: ${year.values.caption} (of ${years.length})`);

        // Follow link — might go to HG or restrictions
        let nextResp = await pl24Fetch(page, year.link!.path);
        let nextWid = year.link!.wid || '';

        // Handle restrictions (drill down until we reach maingroups)
        let drillDown = 0;
        while (nextWid !== 'mainGroupsTable' && !nextWid.includes('mainGroup') && drillDown < 3) {
          const firstRecord = nextResp.data.records.find(r => r.link?.path);
          if (!firstRecord) break;

          // Check if we're already at HG level
          const captions = nextResp.data.records.map(r => r.values?.caption || '');
          const isHg = captions.some(c => /^\d\s+/.test(c) || /Motor|Getriebe|Karosserie|Elektrik/.test(c));
          if (isHg) break;

          logger.info(`  ⚡ Drill-down: ${firstRecord.values.caption} (wid: ${nextWid})`);
          nextResp = await pl24Fetch(page, firstRecord.link!.path);
          nextWid = firstRecord.link!.wid || '';
          drillDown++;
        }

        // Now we should have HG entries
        const hgEntries = nextResp.data.records.filter(r =>
          r.values?.caption && r.link?.path &&
          !['Kataloginformationen', 'V-Seiten', 'MSP-Seiten', 'Sonderkataloge',
            'Chemische Stoffe', 'Serviceteile', 'Elektrische Verbind.'].includes(r.values.caption)
        );

        logger.info(`  ⚡ ${hgEntries.length} HG entries`);

        // Process each HG
        for (const hg of hgEntries) {
          if (!hg.link?.path) continue;
          const hgName = hg.values.caption;

          try {
            // Get Bildtafeln
            const btResp = await pl24Fetch(page, hg.link.path);
            const bildtafeln = btResp.data.records.filter(r => r.link?.path);

            logger.info(`    ⚡ HG "${hgName}": ${bildtafeln.length} Bildtafeln`);

            // Log first BT for debugging
            if (bildtafeln.length > 0) {
              const firstBt = bildtafeln[0];
              logger.info(`      ⚡ First BT: illustration=${firstBt.values?.illustrationNumber}, subgroup=${firstBt.values?.subgroup}, caption=${firstBt.values?.captions?.substring(0, 40)}`);
              logger.info(`      ⚡ First BT link: ${firstBt.link?.path?.substring(0, 100)}`);
            }

            // Process Bildtafeln — navigate SPA to HG page, then click each BT row
            // Build the SPA URL for this HG's subgroups page (authenticated, not demo)
            const hgPayload = JSON.stringify({ path: hg.link!.path, wid: 'subGroupsIllusTable', auto: true });
            const hgEncoded = await page.evaluate(`btoa(${JSON.stringify(hgPayload)})`) as any as string;
            const hgSpaUrl = `https://www.partslink24.com/pl24-app/${serviceName}/0/${hgEncoded}/`;

            for (const bt of bildtafeln) {
              if (!bt.link?.path) continue;
              if (apiAborted) break;

              try {
                // Step 1: Navigate to HG Bildtafel list page (go back each time for clean state)
                await page.goto(hgSpaUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                await sleep(1500);

                // Step 2: Click the Bildtafel row by its illustration number or caption
                const btIllus = bt.values?.illustrationNumber || '';
                const btCaption = bt.values?.captions || '';
                const btSubgroup = bt.values?.subgroup || '';

                // Try clicking by caption (most unique), then illustration number parts
                let clicked = false;
                if (btCaption) {
                  clicked = await page.evaluate(`
                    (() => {
                      const searchText = ${JSON.stringify(btCaption.split('\n')[0].trim())};
                      const spans = document.querySelectorAll('[class*="_value_"] span, [class*="_value_"]');
                      for (const s of spans) {
                        if (s.children.length === 0 && s.textContent?.trim() === searchText) {
                          const row = s.closest('[class*="_row_"], [class*="_line_"], [class*="Row"], tr') || s.parentElement?.parentElement;
                          if (row) { row.click(); return true; }
                          s.click(); return true;
                        }
                      }
                      return false;
                    })()
                  `) as any as boolean;
                }

                if (!clicked && btIllus) {
                  // Try clicking by illustration number parts (e.g., "100" from "100-010")
                  const illusParts = btIllus.replace(/\\/g, '').split('-');
                  if (illusParts.length >= 2) {
                    clicked = await page.evaluate(`
                      (() => {
                        const part2 = ${JSON.stringify(illusParts[1])};
                        const spans = document.querySelectorAll('[class*="_value_"] span, [class*="_value_"]');
                        for (const s of spans) {
                          if (s.children.length === 0 && s.textContent?.trim() === part2) {
                            const row = s.closest('[class*="_row_"], [class*="_line_"], [class*="Row"], tr') || s.parentElement?.parentElement;
                            if (row) { row.click(); return true; }
                            s.click(); return true;
                          }
                        }
                        return false;
                      })()
                    `) as any as boolean;
                  }
                }

                if (!clicked) continue;
                await sleep(1500);

                // Debug: log for first BT of each HG
                if (bt === bildtafeln[0]) {
                  const curUrl = page.url();
                  const isDemo = curUrl.includes('/demo');
                  logger.info(`      ⚡ First BT click: ${isDemo ? '⚠️ DEMO' : '✅ Auth'} url=${curUrl.substring(0, 60)}`);
                }

                // Step 3: Extract OEMs from DOM using the proven _value_ span method
                const oems = await page.evaluate(`
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
                    ];
                    const results = [];
                    const seen = new Set();
                    for (let i = 0; i < values.length; i++) {
                      const v = values[i];
                      const isOem = oemPatterns.some(p => p.test(v));
                      const stripped = v.replace(/[\\s.-]/g, '');
                      const structuralOem = !isOem && stripped.length >= 7 && stripped.length <= 15 &&
                        /^[A-Z0-9]+$/.test(stripped) && /\\d/.test(stripped) && /[A-Z]/.test(stripped);
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

                if (oems.length > 0) {
                  const btNumber = bt.values?.illustrationNumber || '';
                  const rows = oems.map(o => ({
                    vin: vehicleVin,
                    brand: brandUpper,
                    model: modelName,
                    oem: o.oem,
                    description: o.description,
                    bildtafel: btNumber,
                    hg_code: hgName.match(/^(\d)/)?.[1] || '',
                    hg_name: hgName,
                    fg_code: bt.values?.subgroup || '',
                    fg_name: bt.values?.captions || '',
                  }));

                  const inserted = insertResults(jobId, rows);
                  incrementJobParts(jobId, inserted);
                  totalOems += inserted;
                  logger.info(`      ⚡ BT ${bt.values?.illustrationNumber || '?'}: ${oems.length} OEMs (total: ${totalOems})`);
                }
              } catch (err: any) {
                logger.warn(`      ⚡ BT error: ${err.message?.substring(0, 80)}`);
              }

              // Small delay between BT pages
              await sleep(300);
            }
          } catch (err: any) {
            logger.warn(`    ⚡ HG "${hgName}" error: ${err.message}`);
            errors.push(`${modelName}/${hgName}: ${err.message}`);
          }
        }

        logger.info(`  ⚡ ${modelName}: done (total OEMs: ${totalOems})`);

      } catch (err: any) {
        logger.warn(`  ⚡ ${modelName} error: ${err.message}`);
        errors.push(`${modelName}: ${err.message}`);
      }

      // Small delay between models
      await sleep(500);
    }

    updateJobStatus(jobId, 'completed', { total_parts_found: totalOems });

    logger.info(`\n${'═'.repeat(60)}`);
    logger.info(`⚡ ${brandUpper} COMPLETE: ${modelsFound} models, ${totalOems} OEMs`);
    logger.info(`${'═'.repeat(60)}\n`);

  } finally {
    apiRunning = false;
    apiCurrentBrand = null;
    await page.close();
  }

  return { brand: brandUpper, modelsFound, totalOems, errors };
}
