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

    // Step 2: Navigate to brand SPA (needed for cookie context)
    await page.goto(`https://www.partslink24.com/pl24-app/${serviceName}/0/0?desktop=true&lang=de`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(2000);

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

            // Process each Bildtafel — BOM endpoint needs SPA navigation (403 on direct fetch)
            // So we navigate to the SPA URL and extract OEMs from DOM
            for (const bt of bildtafeln) {
              if (!bt.link?.path) continue;

              try {
                // Build SPA URL from the API path
                const bomPayload = JSON.stringify({ path: bt.link.path, wid: 'bomlist', auto: true });
                const bomEncoded = Buffer.from(bomPayload).toString('base64');
                const bomSpaUrl = `https://www.partslink24.com/pl24-app/${serviceName}/0/${encodeURIComponent(bomEncoded)}/`;

                await page.goto(bomSpaUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                await sleep(1500);

                // Extract OEMs from DOM using the proven _value_ span method
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
                }
              } catch (err: any) {
                // Single BT failure — continue
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
