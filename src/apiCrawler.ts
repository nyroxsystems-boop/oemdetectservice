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
  error?: any;
  debug?: any;
}

// ── API Helper ───────────────────────────────────────────────────────────────

/**
 * Headers captured from the SPA's own network requests.
 * The SPA's JavaScript framework (Axios/Angular) adds custom headers
 * like XSRF tokens that are required for BOM endpoints.
 */
let capturedSpaHeaders: Record<string, string> = {};

/**
 * Set up a network interceptor to capture headers from PL24's own API requests.
 * Must be called BEFORE clicking the brand link so we catch the SPA's initial data load.
 */
function setupHeaderCapture(page: Page): void {
  capturedSpaHeaders = {};
  
  page.on('request', (request) => {
    // Only capture headers from PL24 API requests made by the SPA itself
    const url = request.url();
    if (url.includes('/p5vwag/extern/') && request.resourceType() === 'fetch') {
      if (Object.keys(capturedSpaHeaders).length === 0) {
        const headers = request.headers();
        // Capture all non-standard headers (skip trivially common ones)
        for (const [key, value] of Object.entries(headers)) {
          capturedSpaHeaders[key.toLowerCase()] = value;
        }
        logger.info(`⚡ Captured ${Object.keys(capturedSpaHeaders).length} SPA headers`);
        // Log interesting headers for debugging
        const interesting = Object.entries(capturedSpaHeaders)
          .filter(([k]) => k.startsWith('x-') || k === 'authorization' || k.includes('csrf') || k.includes('token'))
          .map(([k, v]) => `${k}: ${v.substring(0, 30)}`);
        if (interesting.length > 0) {
          logger.info(`⚡ Custom headers: ${interesting.join(', ')}`);
        }
      }
    }
  });
}

/**
 * Call a PL24 API endpoint using the browser's session cookies.
 * Injects the captured Bearer token from the SPA's own requests.
 */
async function pl24Fetch(page: Page, apiPath: string): Promise<PL24Response> {
  // Pass the captured auth token from Node.js into the browser context
  const capturedAuth = capturedSpaHeaders['authorization'] || '';
  
  const result = await page.evaluate(`
    (async function() {
      try {
        const headers = {
          'Accept': 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': window.location.href,
        };
        
        // Inject captured Bearer token from SPA (passed from Node.js)
        const capturedAuth = ${JSON.stringify(capturedAuth)};
        if (capturedAuth) {
          headers['Authorization'] = capturedAuth;
        }
        
        // Also try XSRF-TOKEN from cookies as backup
        const xsrf = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
        if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf[1]);
        
        const r = await fetch(${JSON.stringify(apiPath)}, {
          credentials: 'same-origin',
          headers,
        });
        if (!r.ok) {
          const respHeaders = {};
          r.headers.forEach((v, k) => { respHeaders[k] = v; });
          return {
            error: r.status,
            statusText: r.statusText,
            data: { records: [] },
            debug: {
              cookies: document.cookie.substring(0, 200),
              url: window.location.href,
              hasAuth: !!capturedAuth,
            },
          };
        }
        return await r.json();
      } catch(e) {
        return { error: e.message, data: { records: [] } };
      }
    })()
  `) as any;

  if (result.error) {
    // Log debug info for 403 errors
    if (result.debug) {
      logger.warn(`PL24 API ${result.error} debug:`, {
        cookies: result.debug.cookies?.substring(0, 100),
        pageUrl: result.debug.url?.substring(0, 60),
      });
    }
    throw new Error(`PL24 API ${result.error}: ${apiPath.substring(0, 80)}`);
  }

  return result as PL24Response;
}

/**
 * Try to fetch BOM data using Playwright's API request context.
 * This sends the request from Node.js with the browser's cookies attached.
 * Different from page.evaluate(fetch) — bypasses Service Workers and JS interceptors.
 */
async function pl24FetchViaPlaywright(page: Page, apiPath: string): Promise<PL24Response> {
  const fullUrl = apiPath.startsWith('http')
    ? apiPath
    : `https://www.partslink24.com${apiPath}`;
  
  try {
    const response = await page.request.get(fullUrl, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': page.url(),
        // Include any captured SPA headers
        ...Object.fromEntries(
          Object.entries(capturedSpaHeaders).filter(([k]) =>
            k.startsWith('x-') || k === 'authorization' || k.includes('csrf') || k.includes('token')
          )
        ),
      },
    });

    if (!response.ok()) {
      throw new Error(`PL24 API ${response.status()}: ${apiPath.substring(0, 80)}`);
    }

    return await response.json() as PL24Response;
  } catch (err: any) {
    throw new Error(`PL24 Playwright API: ${err.message?.substring(0, 100)}`);
  }
}

/**
 * Extract OEM numbers from the currently rendered DOM page.
 * Used as fallback when direct API calls return 403.
 */
async function extractOemsFromDom(page: Page): Promise<Array<{ oem: string; description: string }>> {
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

    // Set up header capture BEFORE clicking — catches the SPA's initial API call headers
    setupHeaderCapture(page);

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

      logger.info(`\n${'─'.repeat(50)}`);
      logger.info(`⚡ [${mi + 1}/${models.length}] ${modelName}`);
      logger.info(`  API path: ${model.link?.path?.substring(0, 80)}`);

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

            // ── Process Bildtafeln ──
            // Strategy 1: Direct API call to BOM endpoint (fastest)
            // Strategy 2: SPA URL navigation + DOM extraction (fallback for 403)
            //
            // The subgroups API returns BT records with link.path pointing to
            // /p5vwag/extern/bom/mdl?... — we try fetching that directly first.
            // If the BOM endpoint blocks us with 403, we construct the SPA URL
            // and navigate the browser to it, letting the SPA handle auth.

            let bomApiFailed = false; // Track if API approach works

            // For SPA fallback: construct HG subgroups page URL for back-navigation
            const hgPayload = Buffer.from(JSON.stringify({
              path: hg.link!.path, wid: 'subGroupsIllusTable', auto: true
            })).toString('base64');
            const hgSpaUrl = `https://www.partslink24.com/pl24-app/${serviceName}/0/${encodeURIComponent(hgPayload)}/`;

            for (const bt of bildtafeln) {
              if (!bt.link?.path) continue;
              if (apiAborted) break;

              const btIdx = bildtafeln.indexOf(bt);
              const btIllus = (bt.values?.illustrationNumber || '').replace(/\\/g, '');
              const btCaption = (bt.values?.captions || '').split('\n')[0].trim();
              const btSubgroup = bt.values?.subgroup || '';

              try {
                logger.info(`      [${btIdx + 1}/${bildtafeln.length}] BT ${btIllus} "${btCaption}" (UG:${btSubgroup})`);

                let oems: Array<{ oem: string; description: string }> = [];

                // ── Strategy 1: Direct API call via page.evaluate(fetch) ──
                if (!bomApiFailed) {
                  try {
                    const bomResp = await pl24Fetch(page, bt.link.path);
                    const parts = bomResp.data?.records || [];

                    const seen = new Set<string>();
                    for (const part of parts) {
                      const partNo = (part.values?.partNo || part.values?.['partNo'] || '').trim();
                      const caption = (part.values?.caption || part.values?.['captions'] || part.values?.['name'] || '').trim();
                      if (!partNo) continue;
                      const stripped = partNo.replace(/[\s.\-]/g, '');
                      if (stripped.length < 5 || stripped.length > 20) continue;
                      if (seen.has(stripped)) continue;
                      seen.add(stripped);
                      oems.push({ oem: partNo, description: caption });
                    }

                    if (parts.length > 0 && oems.length === 0) {
                      const firstPartKeys = Object.keys(parts[0].values || {});
                      logger.info(`      ○ BT ${btIllus}: ${parts.length} records, 0 OEMs (keys: ${firstPartKeys.join(', ')})`);
                    }
                  } catch (apiErr: any) {
                    if (apiErr.message?.includes('403')) {
                      if (!bomApiFailed) {
                        logger.warn(`      ⚠ BOM API (fetch) returns 403 — trying Playwright API...`);
                      }
                      
                      // ── Strategy 1.5: Playwright-level request (Node.js, different networking path) ──
                      try {
                        const bomResp = await pl24FetchViaPlaywright(page, bt.link!.path);
                        const parts = bomResp.data?.records || [];

                        const seen = new Set<string>();
                        for (const part of parts) {
                          const partNo = (part.values?.partNo || part.values?.['partNo'] || '').trim();
                          const caption = (part.values?.caption || part.values?.['captions'] || part.values?.['name'] || '').trim();
                          if (!partNo) continue;
                          const stripped = partNo.replace(/[\s.\-]/g, '');
                          if (stripped.length < 5 || stripped.length > 20) continue;
                          if (seen.has(stripped)) continue;
                          seen.add(stripped);
                          oems.push({ oem: partNo, description: caption });
                        }

                        if (oems.length > 0) {
                          logger.info(`      ⚡ Playwright API worked! ${oems.length} OEMs`);
                        }
                      } catch (pwErr: any) {
                        if (!bomApiFailed) {
                          logger.warn(`      ⚠ Playwright API also failed: ${pwErr.message?.substring(0, 60)}`);
                          logger.warn(`      ⚠ Switching to SPA navigation mode`);
                          bomApiFailed = true;
                        }
                      }
                    } else {
                      throw apiErr; // Re-throw non-403 errors
                    }
                  }
                }

                // ── Strategy 2: SPA navigation in NEW TAB + DOM extraction ──
                // IMPORTANT: Use a new tab to avoid destroying the main page's SPA session.
                // page.goto() on the main page kills the SPA's in-memory auth state → demo mode.
                if (bomApiFailed && oems.length === 0) {
                  let bomTab: Page | null = null;
                  try {
                    // Construct SPA URL for this specific BOM page
                    const bomPayload = Buffer.from(JSON.stringify({
                      path: bt.link!.path, wid: 'bomListTable', auto: true
                    })).toString('base64');
                    const bomSpaUrl = `https://www.partslink24.com/pl24-app/${serviceName}/0/${encodeURIComponent(bomPayload)}/`;

                    // Open in a new tab (shares cookies with the main page's browser context)
                    bomTab = await page.context().newPage();
                    await bomTab.goto(bomSpaUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                    // Wait for SPA to render value spans
                    await bomTab.waitForSelector('[class*="_value_"] span', { timeout: 8000 }).catch(() => {});
                    await sleep(1500);

                    // Check if page is in demo mode
                    const currentUrl = bomTab.url();
                    if (currentUrl.includes('/demo')) {
                      if (btIdx < 3) {
                        logger.warn(`      ⚠ New tab loaded in demo mode — session cookies insufficient`);
                      }
                    } else {
                      // Extract OEMs from the rendered BOM page
                      oems = await extractOemsFromDom(bomTab);
                    }

                    if (oems.length === 0 && btIdx < 3) {
                      const spanCount = await bomTab.evaluate(`document.querySelectorAll('[class*="_value_"] span').length`) as any as number;
                      logger.info(`      ○ BT ${btIllus}: 0 OEMs from DOM (${spanCount} spans, url=${currentUrl.substring(0, 70)})`);
                    }
                  } catch (spaErr: any) {
                    logger.warn(`      ⚠ SPA fallback failed for BT ${btIllus}: ${spaErr.message?.substring(0, 80)}`);
                  } finally {
                    // Always close the tab to avoid resource leaks
                    if (bomTab) await bomTab.close().catch(() => {});
                  }
                }

                // ── Store results ──
                if (oems.length > 0) {
                  const rows = oems.map(o => ({
                    vin: vehicleVin,
                    brand: brandUpper,
                    model: modelName,
                    oem: o.oem,
                    description: o.description,
                    bildtafel: btIllus,
                    hg_code: hgName.match(/^(\d)/)?.[1] || '',
                    hg_name: hgName,
                    fg_code: btSubgroup,
                    fg_name: btCaption,
                  }));

                  const inserted = insertResults(jobId, rows);
                  incrementJobParts(jobId, inserted);
                  totalOems += inserted;
                  logger.info(`      ✅ BT ${btIllus}: ${oems.length} OEMs stored (${inserted} new, total: ${totalOems})`);
                  if (oems.length <= 3) {
                    oems.forEach(o => logger.info(`         ${o.oem} — ${o.description?.substring(0, 40)}`));
                  } else {
                    logger.info(`         ${oems[0].oem} — ${oems[0].description?.substring(0, 40)} ... +${oems.length - 1} more`);
                  }
                }
              } catch (err: any) {
                logger.error(`      ❌ BT ${btIllus} error: ${err.message?.substring(0, 100)}`);
              }

              // Delay between requests — more for SPA mode (page navigation), less for API mode
              await sleep(bomApiFailed ? 500 : 200);
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
