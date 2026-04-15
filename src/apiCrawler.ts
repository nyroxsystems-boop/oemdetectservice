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
  getJob, upsertVehicle, getBulkStats, isBtAlreadyScraped,
} from './bulkStore';

// ── Shared state with bulkCrawler (import the setters) ───────────────────────
// We need to set bulkRunning/currentBrand so the UI shows the correct status

let apiRunning = false;
let apiCurrentBrand: string | null = null;
let apiPaused = false;

export function getApiState() {
  return { running: apiRunning, currentBrand: apiCurrentBrand, paused: apiPaused };
}

export function cancelApi(): void {
  apiRunning = false;
  apiCurrentBrand = null;
  apiAborted = true;
  apiPaused = false;
}

export function pauseApi(): void {
  apiPaused = true;
}

export function resumeApi(): void {
  apiPaused = false;
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

// ── Adaptive Rate Limiting ───────────────────────────────────────────────────

/** Delay between BOM requests — starts at 500ms, increases on 429 */
let bomRequestDelay = 500;

// ── Dynamic Service Name Discovery ──────────────────────────────────────────

const discoveredServiceNames: Record<string, string> = {};

/**
 * Discover actual PL24 service names from the dashboard HTML.
 * The dashboard has links like: <a href="/partslink24/launchCatalog.do?service=bmw&t=...">
 * This handles cases where PL24_SERVICE_MAP has incorrect entries (e.g. BMW, Mercedes, Ford).
 */
async function discoverServiceNames(page: Page): Promise<Record<string, string>> {
  if (Object.keys(discoveredServiceNames).length > 0) return discoveredServiceNames;

  try {
    const links = await page.evaluate(`
      (() => {
        const results = {};
        const anchors = document.querySelectorAll('a[href*="launchCatalog"]');
        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          const match = href.match(/service=([^&]+)/);
          if (match) {
            const serviceName = match[1];
            const img = a.querySelector('img');
            const alt = img ? (img.getAttribute('alt') || '').trim() : '';
            const title = (a.getAttribute('title') || '').trim();
            const text = (a.textContent || '').trim();
            const brandLabel = alt || title || text;
            if (brandLabel && serviceName) {
              results[brandLabel.toUpperCase().trim()] = serviceName;
            }
          }
        }
        return results;
      })()
    `) as Record<string, string>;

    Object.assign(discoveredServiceNames, links);
    logger.info('⚡ Discovered service names from dashboard:');
    for (const [brand, svc] of Object.entries(links)) {
      const staticName = PL24_SERVICE_MAP[brand];
      const marker = staticName && staticName !== svc ? ` ⚠️ (static map had "${staticName}")` : '';
      logger.info(`   ${brand} → ${svc}${marker}`);
    }
  } catch (err: any) {
    logger.warn(`⚡ Service name discovery failed: ${err.message}`);
  }

  return discoveredServiceNames;
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
 *
 * Captures BOTH fetch and XHR requests — the SPA may use Axios (which uses XHR)
 * rather than the native fetch API.
 */
function setupHeaderCapture(page: Page): void {
  capturedSpaHeaders = {};

  page.on('request', (request) => {
    const url = request.url();
    const rtype = request.resourceType();
    // Capture both fetch AND xhr — Axios uses XMLHttpRequest under the hood
    if (url.includes('/p5vwag/extern/') && (rtype === 'fetch' || rtype === 'xhr')) {
      const headers = request.headers();

      // Always grab the full set on first capture
      if (Object.keys(capturedSpaHeaders).length === 0) {
        for (const [key, value] of Object.entries(headers)) {
          capturedSpaHeaders[key.toLowerCase()] = value;
        }
        logger.info(`⚡ Captured ${Object.keys(capturedSpaHeaders).length} SPA headers (type: ${rtype})`);
      }

      // Keep updating auth-related headers from ALL subsequent requests
      const auth = headers['authorization'] || headers['Authorization'];
      if (auth) {
        capturedSpaHeaders['authorization'] = auth;
        logger.info(`⚡ Auth header captured: ${auth.substring(0, 50)}... (type: ${rtype})`);
      }
      const xsrf = headers['x-xsrf-token'] || headers['X-XSRF-TOKEN'];
      if (xsrf) {
        capturedSpaHeaders['x-xsrf-token'] = xsrf;
      }

      // Log interesting headers on first few captures
      const interesting = Object.entries(headers)
        .filter(([k]) => k.startsWith('x-') || k === 'authorization' || k.includes('csrf') || k.includes('token') || k.includes('bearer'))
        .map(([k, v]) => `${k}: ${v.substring(0, 40)}`);
      if (interesting.length > 0) {
        logger.info(`⚡ Request headers [${rtype}]: ${interesting.join(', ')}`);
      }
    }
  });
}

/**
 * Call a PL24 API endpoint using the browser's session cookies.
 * Injects any captured auth headers from the SPA's own requests.
 */
async function pl24Fetch(page: Page, apiPath: string): Promise<PL24Response> {
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Pass captured auth headers from Node.js into the browser context
    const capturedAuth = capturedSpaHeaders['authorization'] || '';
    const capturedXsrf = capturedSpaHeaders['x-xsrf-token'] || '';

    const result = await page.evaluate(`
      (async function() {
        try {
          const headers = {
            'Accept': 'application/json, text/plain, */*',
          };

          // Inject captured auth headers from SPA (passed from Node.js)
          const capturedAuth = ${JSON.stringify(capturedAuth)};
          if (capturedAuth) {
            headers['Authorization'] = capturedAuth;
          }

          // XSRF-TOKEN: try captured header first, then cookie
          const capturedXsrf = ${JSON.stringify(capturedXsrf)};
          if (capturedXsrf) {
            headers['X-XSRF-TOKEN'] = capturedXsrf;
          } else {
            const xsrf = document.cookie.match(/XSRF-TOKEN=([^;]+)/);
            if (xsrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf[1]);
          }

          const r = await fetch(${JSON.stringify(apiPath)}, {
            credentials: 'include',
            headers,
          });
          if (!r.ok) {
            // Capture response body — the error message tells us WHY
            let responseBody = '';
            try { responseBody = await r.text(); } catch {}
            const respHeaders = {};
            r.headers.forEach((v, k) => { respHeaders[k] = v; });
            return {
              error: r.status,
              statusText: r.statusText,
              data: { records: [] },
              debug: {
                responseBody: responseBody.substring(0, 500),
                responseHeaders: respHeaders,
                requestUrl: ${JSON.stringify(apiPath)},
                cookies: document.cookie.substring(0, 500),
                url: window.location.href,
                hasAuth: !!capturedAuth,
                headersSent: Object.keys(headers).join(', '),
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
      // ── 429 Too Many Requests — retry with exponential backoff ──
      if (result.error === 429 && attempt < maxRetries) {
        const backoffSec = 30 * Math.pow(2, attempt); // 30s, 60s, 120s
        logger.warn(`⚡ 429 Rate Limited — waiting ${backoffSec}s before retry (${attempt + 1}/${maxRetries})...`);
        // Also increase the adaptive BOM delay to reduce future 429s
        bomRequestDelay = Math.min(bomRequestDelay * 2, 5000);
        logger.info(`⚡ Adaptive BOM delay increased to ${bomRequestDelay}ms`);
        await sleep(backoffSec * 1000);
        continue;
      }

      // Log comprehensive debug info for errors
      if (result.debug) {
        logger.warn(`PL24 API ${result.error} [${result.statusText}] debug:`, {
          responseBody: result.debug.responseBody?.substring(0, 200),
          cookies: result.debug.cookies?.substring(0, 150),
          pageUrl: result.debug.url?.substring(0, 80),
          hasAuth: result.debug.hasAuth,
          headersSent: result.debug.headersSent,
          requestUrl: result.debug.requestUrl?.substring(0, 100),
        });
        if (result.debug.responseHeaders) {
          const interesting = Object.entries(result.debug.responseHeaders)
            .filter(([k]: [string, any]) => /auth|token|session|www-auth|allow|csrf/i.test(k))
            .map(([k, v]: [string, any]) => `${k}: ${v}`);
          if (interesting.length > 0) {
            logger.warn(`  Response headers: ${interesting.join(', ')}`);
          }
        }
      }
      throw new Error(`PL24 API ${result.error}: ${apiPath.substring(0, 80)}`);
    }

    return result as PL24Response;
  }

  // Should not reach here, but TypeScript needs it
  throw new Error(`PL24 API: max retries exceeded for ${apiPath.substring(0, 80)}`);
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
 * Fetch BOM data by navigating within the SPA and intercepting the API response.
 * Uses the MAIN page's authenticated SPA context — no new tab needed.
 * The SPA's own HTTP client handles auth, and we intercept the response.
 */
async function fetchBomViaSpaRoute(
  page: Page, bomApiPath: string, serviceName: string
): Promise<PL24Response> {
  // Encode BOM path as SPA route payload (same format the SPA uses internally)
  const payload = Buffer.from(JSON.stringify({
    path: bomApiPath, wid: 'bomListTable', auto: true
  })).toString('base64');
  const bomSpaPath = `/pl24-app/${serviceName}/0/${encodeURIComponent(payload)}/`;

  // Set up response interception BEFORE triggering navigation
  const responsePromise = page.waitForResponse(
    resp => {
      const u = resp.url();
      return (u.includes('/p5vwag/extern/bom/') || u.includes('/extern/bom/')) &&
             resp.request().resourceType() !== 'document';
    },
    { timeout: 15000 }
  );

  // Trigger SPA internal navigation via History API + popstate
  await page.evaluate(`
    (() => {
      window.history.pushState({}, '', ${JSON.stringify(bomSpaPath)});
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    })()
  `);

  const response = await responsePromise;

  if (!response.ok()) {
    const body = await response.text().catch(() => '');
    throw new Error(`SPA-route BOM ${response.status()}: ${body.substring(0, 100)}`);
  }

  return await response.json() as PL24Response;
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
  let serviceName = PL24_SERVICE_MAP[brandUpper];
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

    // Step 1.5: Discover correct service names from dashboard HTML
    // This handles brands where PL24_SERVICE_MAP has wrong entries (BMW, Mercedes, Ford)
    const discovered = await discoverServiceNames(page);
    if (discovered[brandUpper] && discovered[brandUpper] !== serviceName) {
      logger.info(`⚡ Overriding service name: "${serviceName}" → "${discovered[brandUpper]}" (from dashboard)`);
      serviceName = discovered[brandUpper];
    }

    // Reset adaptive delay for each brand
    bomRequestDelay = 500;

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

    // Wait for SPA to make at least one authenticated API call (captures Bearer token)
    // The SPA bootstraps async — auth headers may arrive after the initial page load
    if (!capturedSpaHeaders['authorization']) {
      logger.info('⚡ Waiting for SPA to fire authenticated API call...');
      for (let i = 0; i < 10 && !capturedSpaHeaders['authorization']; i++) {
        await sleep(1000);
      }
      if (!capturedSpaHeaders['authorization']) {
        logger.warn('⚡ No authorization header captured after 10s — BOM API will likely 403');
      }
    }

    const spaUrl = page.url();
    const isDemo = spaUrl.includes('/demo');
    logger.info(`⚡ SPA URL: ${spaUrl.substring(0, 80)}${isDemo ? ' ⚠️ DEMO MODE!' : ' ✅ Authenticated'}`);

    if (isDemo) {
      throw new Error('SPA loaded in demo mode — session transfer failed');
    }

    // Step 2.5: Extract auth tokens from all browser storage locations
    const storageInfo = await page.evaluate(`
      (() => {
        const info = { ls: {}, ss: {}, cookies: document.cookie, idb: [] };
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          info.ls[k] = localStorage.getItem(k)?.substring(0, 200);
        }
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          info.ss[k] = sessionStorage.getItem(k)?.substring(0, 200);
        }
        // Check if window.fetch was patched by the SPA
        info.fetchPatched = window.fetch.toString().indexOf('[native code]') === -1;
        return info;
      })()
    `) as any;

    logger.info(`⚡ Browser storage scan:`);
    logger.info(`  Cookies: ${storageInfo.cookies?.substring(0, 150)}`);
    logger.info(`  localStorage keys: ${Object.keys(storageInfo.ls).join(', ') || '(empty)'}`);
    logger.info(`  sessionStorage keys: ${Object.keys(storageInfo.ss).join(', ') || '(empty)'}`);
    logger.info(`  fetch patched by SPA: ${storageInfo.fetchPatched}`);

    // Look for auth tokens in storage
    for (const [store, data] of [['localStorage', storageInfo.ls], ['sessionStorage', storageInfo.ss]] as const) {
      for (const [key, val] of Object.entries(data as Record<string, string>)) {
        if (/auth|token|bearer|jwt|session/i.test(key) || /eyJ[A-Za-z0-9_-]{10,}/.test(val || '')) {
          logger.info(`  ⚡ Potential auth in ${store}["${key}"]: ${(val || '').substring(0, 100)}`);
          // If it looks like a JWT, use it
          const jwtMatch = (val || '').match(/(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/);
          if (jwtMatch && !capturedSpaHeaders['authorization']) {
            capturedSpaHeaders['authorization'] = `Bearer ${jwtMatch[1]}`;
            logger.info(`  ⚡ JWT extracted from ${store} → authorization header set`);
          }
        }
      }
    }

    // Also scan IndexedDB for auth tokens
    try {
      const idbTokens = await page.evaluate(`
        (async () => {
          try {
            const dbs = await indexedDB.databases();
            const tokens = [];
            for (const dbInfo of dbs) {
              try {
                const db = await new Promise((resolve, reject) => {
                  const req = indexedDB.open(dbInfo.name);
                  req.onsuccess = () => resolve(req.result);
                  req.onerror = () => reject(req.error);
                });
                const storeNames = Array.from(db.objectStoreNames);
                tokens.push({ db: dbInfo.name, stores: storeNames });
                for (const storeName of storeNames) {
                  if (/auth|token|session/i.test(storeName)) {
                    try {
                      const tx = db.transaction(storeName, 'readonly');
                      const store = tx.objectStore(storeName);
                      const all = await new Promise((resolve, reject) => {
                        const req = store.getAll();
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => reject(req.error);
                      });
                      tokens.push({ db: dbInfo.name, store: storeName, data: JSON.stringify(all).substring(0, 300) });
                    } catch {}
                  }
                }
                db.close();
              } catch {}
            }
            return tokens;
          } catch { return []; }
        })()
      `) as any[];
      if (idbTokens?.length > 0) {
        logger.info(`  ⚡ IndexedDB: ${JSON.stringify(idbTokens).substring(0, 300)}`);
      }
    } catch {}

    // Step 3: Fetch model list via API
    const upds = '2026-03-27--00-02'; // PL24 update timestamp
    const modelsResp = await pl24Fetch(page,
      `/p5vwag/extern/vehicle/modelfamilies?lang=de&localMarketOnly=true&serviceName=${serviceName}&upds=${upds}`
    );

    // ⚠️ Check if API returned demo mode (subscription expired)
    if ((modelsResp as any).demo === true) {
      logger.error('⚠️ PL24 API returned demo=true — Abonnement abgelaufen! Subscription must be renewed.');
      throw new Error('PL24 subscription expired (demo=true in API response). Renew at partslink24.com');
    }

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
    let restrictionKeysLogged = false;
    for (let mi = 0; mi < models.length; mi++) {
      if (apiAborted) { logger.info('⚡ ABORTED by admin'); break; }
      // Pause support — chain/admin can pause mid-crawl
      while (apiPaused && !apiAborted) { await sleep(1000); }
      const model = models[mi];
      const modelName = model.values.caption;
      if (!model.link?.path) continue;

      // Extract internal model code from caption: "A3 (8P)" → "8P", "3er (F30)" → "F30"
      const modelCodeMatch = modelName.match(/\(([A-Z0-9]{1,5})\)\s*$/);
      const modelCode = modelCodeMatch?.[1] || null;

      logger.info(`\n${'─'.repeat(50)}`);
      logger.info(`⚡ [${mi + 1}/${models.length}] ${modelName}${modelCode ? ` [code: ${modelCode}]` : ''}`);
      logger.info(`  API path: ${model.link?.path?.substring(0, 80)}`);

      try {
        // Get years
        const yearsResp = await pl24Fetch(page, model.link.path);
        const years = yearsResp.data.records.filter(r => r.values?.caption && r.link?.path);

        if (years.length === 0) {
          logger.warn(`  ⚡ No years for ${modelName}`);
          continue;
        }

        // Compute full year range (all years for this model), then pick most recent for drill-down
        const yearNums = years
          .map(y => parseInt(y.values.caption || '0'))
          .filter(n => n > 1900 && n < 2100);
        const yearFrom = yearNums.length ? Math.min(...yearNums) : null;
        const yearTo = yearNums.length ? Math.max(...yearNums) : null;

        const sortedYears = years.sort((a, b) =>
          parseInt(b.values.caption || '0') - parseInt(a.values.caption || '0')
        );
        const year = sortedYears[0];
        logger.info(`  ⚡ Year range: ${yearFrom}-${yearTo} (using ${year.values.caption} for drill-down, ${years.length} total)`);

        // Follow link — might go to HG or restrictions
        let nextResp = await pl24Fetch(page, year.link!.path);
        let nextWid = year.link!.wid || '';
        let engineLabel: string | null = null;

        // Handle restrictions (drill down until we reach maingroups)
        let drillDown = 0;
        while (nextWid !== 'mainGroupsTable' && !nextWid.includes('mainGroup') && drillDown < 3) {
          const firstRecord = nextResp.data.records.find(r => r.link?.path);
          if (!firstRecord) break;

          // Check if we're already at HG level
          const captions = nextResp.data.records.map(r => r.values?.caption || '');
          const isHg = captions.some(c => /^\d\s+/.test(c) || /Motor|Getriebe|Karosserie|Elektrik/.test(c));
          if (isHg) break;

          // Capture engine label from the first restriction level we hit.
          // This is the label of the restriction we *choose* to drill into —
          // so every OEM scraped below inherits this engine context.
          if (nextWid.toLowerCase().includes('restriction') ||
              nextWid.toLowerCase().includes('engine') ||
              nextWid.toLowerCase().includes('modeltype')) {
            engineLabel = firstRecord.values?.caption || null;
            // Log all keys once per brand so we can discover richer engine fields later
            if (!restrictionKeysLogged) {
              logger.info(`  ⚡ Restriction fields (first encounter): ${JSON.stringify(Object.keys(firstRecord.values || {}))}`);
              logger.info(`  ⚡ Restriction values (first encounter): ${JSON.stringify(firstRecord.values).substring(0, 300)}`);
              restrictionKeysLogged = true;
            }
          }

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
          if (apiAborted) break;
          while (apiPaused && !apiAborted) { await sleep(1000); }
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
              const hgCodeNum = hgName.match(/^(\d)/)?.[1] || '';

              // Smart resume: skip BTs already in the database
              if (btIllus && isBtAlreadyScraped(brandUpper, modelName, hgCodeNum, btIllus)) {
                if (btIdx < 3) logger.info(`      [${btIdx + 1}/${bildtafeln.length}] BT ${btIllus} — SKIP (already scraped)`);
                continue;
              }

              try {
                logger.info(`      [${btIdx + 1}/${bildtafeln.length}] BT ${btIllus} "${btCaption}" (UG:${btSubgroup})`);

                let oems: Array<{ oem: string; description: string }> = [];

                // ── Strategy 1: Direct API call via page.evaluate(fetch) ──
                if (!bomApiFailed) {
                  try {
                    const bomResp = await pl24Fetch(page, bt.link.path);
                    const parts = bomResp.data?.records || [];

                    // Check if BOM response says demo mode
                    if ((bomResp as any).demo === true) {
                      logger.warn(`      ⚠ BOM returned demo=true — subscription issue`);
                      bomApiFailed = true;
                    } else {
                      const seen = new Set<string>();
                      for (const part of parts) {
                        const v = part.values || {};
                        const partNo = (v.partNo || v.partno || '').trim();
                        const desc = (v.description || v.caption || v.captions || v.name || '').trim();
                        if (!partNo) continue;
                        const stripped = partNo.replace(/[\s.\-]/g, '');
                        if (stripped.length < 5 || stripped.length > 20) continue;
                        if (seen.has(stripped)) continue;
                        seen.add(stripped);
                        oems.push({ oem: partNo, description: desc });
                      }

                      if (parts.length > 0 && oems.length === 0) {
                        const firstPartKeys = Object.keys(parts[0].values || {});
                        logger.info(`      ○ BT ${btIllus}: ${parts.length} records, 0 OEMs (keys: ${firstPartKeys.join(', ')})`);
                      }
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
                          const v = part.values || {};
                          const partNo = (v.partNo || v.partno || '').trim();
                          const desc = (v.description || v.caption || v.captions || v.name || '').trim();
                          if (!partNo) continue;
                          const stripped = partNo.replace(/[\s.\-]/g, '');
                          if (stripped.length < 5 || stripped.length > 20) continue;
                          if (seen.has(stripped)) continue;
                          seen.add(stripped);
                          oems.push({ oem: partNo, description: desc });
                        }

                        if (oems.length > 0) {
                          logger.info(`      ⚡ Playwright API worked! ${oems.length} OEMs`);
                        }
                      } catch (pwErr: any) {
                        if (!bomApiFailed) {
                          logger.warn(`      ⚠ Playwright API also failed: ${pwErr.message?.substring(0, 60)}`);
                          bomApiFailed = true;
                        }
                      }
                    } else if (apiErr.message?.includes('429')) {
                      // 429 after all retries in pl24Fetch — skip this BT but don't flag API as permanently failed
                      logger.warn(`      ⚠ 429 after retries — skipping BT ${btIllus}, cooling down 60s...`);
                      await sleep(60000);
                    } else {
                      throw apiErr; // Re-throw other errors
                    }
                  }
                }

                // ── Strategy 2: SPA in-page navigation + response interception ──
                // Instead of opening a new tab (which goes to demo mode), navigate
                // WITHIN the main page's SPA using pushState + popstate.
                // The SPA's own HTTP client handles auth properly.
                if (bomApiFailed && oems.length === 0) {
                  try {
                    logger.info(`      ⚡ Trying SPA route navigation for BT ${btIllus}...`);
                    const bomResp = await fetchBomViaSpaRoute(page, bt.link!.path, serviceName);
                    const parts = bomResp.data?.records || [];

                    const seen = new Set<string>();
                    for (const part of parts) {
                      const v = part.values || {};
                      const partNo = (v.partNo || v.partno || '').trim();
                      const desc = (v.description || v.caption || v.captions || v.name || '').trim();
                      if (!partNo) continue;
                      const stripped = partNo.replace(/[\s.\-]/g, '');
                      if (stripped.length < 5 || stripped.length > 20) continue;
                      if (seen.has(stripped)) continue;
                      seen.add(stripped);
                      oems.push({ oem: partNo, description: desc });
                    }

                    if (oems.length > 0) {
                      logger.info(`      ⚡ SPA route worked! ${oems.length} OEMs`);
                    }
                  } catch (spaErr: any) {
                    logger.warn(`      ⚠ SPA route failed: ${spaErr.message?.substring(0, 80)}`);

                    // ── Strategy 3: DOM extraction as last resort ──
                    try {
                      // Wait for SPA to render (it may have partially navigated)
                      await page.waitForSelector('[class*="_value_"] span', { timeout: 5000 }).catch(() => {});
                      await sleep(1000);
                      const currentUrl = page.url();
                      if (!currentUrl.includes('/demo')) {
                        oems = await extractOemsFromDom(page);
                        if (oems.length > 0) {
                          logger.info(`      ⚡ DOM extraction worked! ${oems.length} OEMs`);
                        }
                      }
                    } catch (domErr: any) {
                      logger.warn(`      ⚠ DOM extraction also failed: ${domErr.message?.substring(0, 60)}`);
                    }
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
                    year_from: yearFrom,
                    year_to: yearTo,
                    model_code: modelCode,
                    engine: engineLabel,
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

              // Delay between BOM requests — adaptive (increases on 429), more for SPA fallback
              await sleep(bomApiFailed ? 500 : bomRequestDelay);
            }
          } catch (err: any) {
            logger.warn(`    ⚡ HG "${hgName}" error: ${err.message}`);
            errors.push(`${modelName}/${hgName}: ${err.message}`);
          }

          // Cooldown between HG groups to avoid triggering rate limits
          await sleep(2000);
        }

        logger.info(`  ⚡ ${modelName}: done (total OEMs: ${totalOems})`);

      } catch (err: any) {
        logger.warn(`  ⚡ ${modelName} error: ${err.message}`);
        errors.push(`${modelName}: ${err.message}`);
      }

      // Delay between models
      await sleep(1000);
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
