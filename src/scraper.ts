/**
 * 🤖 PARTSLINK24 SCRAPER — Production-Hardened Playwright Automation
 *
 * Automates the real PartsLink24 workflow (verified against live UI March 2026):
 *
 * LOGIN PAGE (partslink24.com):
 *   Right panel → "Firmenkennung / ID:" + "Benutzername:" + "Passwort:" + "Login" button
 *
 * DASHBOARD (after login):
 *   Top: "Abmelden" link
 *   Left: Brand logo grid + "FAHRGESTELLNUMMER" input + "GO" button
 *   Right: "Herzlich willkommen bei partslink24..." + Verwaltung panel
 *
 * CATALOG VIEW (after VIN identification — separate modern UI):
 *   Top bar: [BMW Logo] [VIN input] [🔍] | [Teile suchen] [🔍] | [Händler wählen]
 *   Breadcrumb: Startseite > BMW > WBAAT51010FW14413 > 3' E46
 *   Left panel: Fahrzeugidentifikation (Fahrgestellnummer, Modellbezeichnung, Produktionsdatum, Farbe, etc.)
 *   Main area: Hauptgruppe table (88, 01, 02, 03, 04, 11=Motor, 12=Motor-Elektrik, ...)
 *
 * SEARCH RESULTS (after "Teile suchen"):
 *   Left panel: "Suche: ölfilter"
 *   Results: Bildtafel | Teilenummer | Benennung | HG | FG — stacked vertically
 *
 * Production features:
 * - Exact selectors matched to real PL24 UI
 * - Bot-detection / CAPTCHA / account-lock checks
 * - Circuit breaker for repeated failures
 * - Request queue for concurrency safety
 * - Session persistence via storageState
 * - Comprehensive error screenshots
 */

import { chromium, Browser, BrowserContext, Page, Locator } from 'playwright';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { logger, safeUrlForLog } from './logger';
import { OemResult } from './cache';
import { enqueue } from './requestQueue';
import { SingleSessionGate } from './singleSessionGate';
import { isPartslinkSessionContinuationLabel } from './partslinkSession';
import {
  persistPrivateStorageState,
  preparePrivateStorageState,
} from './sessionStateStore';

// ── Constants ────────────────────────────────────────────────────────────────

const STORAGE_DIR = path.join(__dirname, '..', 'playwright-data');
const STORAGE_PATH = path.join(STORAGE_DIR, 'state.json');
const MAX_RETRIES = 2;
const NAVIGATION_TIMEOUT = 30_000;

// ── State ────────────────────────────────────────────────────────────────────

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let isLoggedIn = false;
let authenticationRejected = false;
let lastRequestTime = 0;
let lastSuccessfulLookup: string | null = null;
let browserInitPromise: Promise<void> | null = null;
const sessionGate = new SingleSessionGate();
const browserOperationGate = new SingleSessionGate();

/** Serialize every operation that uses the shared Partslink account/context.
 * Login serialization alone is insufficient: separate pages still mutate one
 * server-side interactive session and may invalidate each other. */
export function runExclusiveBrowserOperation<T>(operation: () => Promise<T>): Promise<T> {
  return browserOperationGate.runExclusive(operation);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

async function initBrowserOnce(): Promise<void> {
  if (browser && context) return;
  if (browser && !context) {
    try { await browser.close(); } catch { /* best effort */ }
    browser = null;
  }

  await preparePrivateStorageState(STORAGE_PATH);

  logger.info('Launching browser...', { headless: config.headless });

  browser = await chromium.launch({
    headless: config.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1440,900',
    ],
  });

  const hasStoredState = fs.existsSync(STORAGE_PATH);
  try {
    context = await browser.newContext({
      ...(hasStoredState ? { storageState: STORAGE_PATH } : {}),
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      javaScriptEnabled: true,
    });
    if (hasStoredState) logger.info('Restored browser session from storage');
  } catch {
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 },
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      javaScriptEnabled: true,
    });
    logger.info('Created fresh browser context');
  }

  // Remove webdriver flag to avoid detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
}

export async function initBrowser(): Promise<void> {
  if (browser && context) return;
  if (!browserInitPromise) {
    browserInitPromise = initBrowserOnce().finally(() => {
      browserInitPromise = null;
    });
  }
  await browserInitPromise;
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    try { await persistPrivateStorageState(context, STORAGE_PATH); } catch { /* ignore */ }
    await context.close();
    context = null;
  }
  if (browser) {
    await browser.close();
    browser = null;
  }
  isLoggedIn = false;
  logger.info('Browser closed');
}

export function getBrowserStatus(): { running: boolean; loggedIn: boolean; lastSuccess: string | null } {
  return {
    running: browser !== null && context !== null,
    loggedIn: isLoggedIn,
    lastSuccess: lastSuccessfulLookup,
  };
}

export function getContext(): BrowserContext | null {
  return context;
}

export function resetLoginState(): void {
  isLoggedIn = false;
}

// ============================================================================
// BOT DETECTION — Check for CAPTCHAs, blocks, session timeouts
// ============================================================================

async function checkForBotDetection(page: Page): Promise<{ blocked: boolean; reason?: string }> {
  try {
    const bodyText = await page.locator('body').innerText({ timeout: 5000 });
    const lower = bodyText.toLowerCase();

    // CAPTCHA detection
    if (lower.includes('captcha') || lower.includes('recaptcha') || lower.includes('hcaptcha')) {
      return { blocked: true, reason: 'CAPTCHA detected' };
    }

    // Account lock / block
    if (lower.includes('gesperrt') || lower.includes('blocked') || lower.includes('suspended')) {
      return { blocked: true, reason: 'Account appears blocked/suspended' };
    }

    // Rate limiting
    if (lower.includes('too many requests') || lower.includes('rate limit') || lower.includes('zu viele anfragen')) {
      return { blocked: true, reason: 'Rate limit hit' };
    }

    // Session timeout — from the real PL24 login page:
    // "Sie wurden von partslink24 abgemeldet. Bitte melden Sie sich erneut an"
    if (lower.includes('abgemeldet') || lower.includes('session abgelaufen') || lower.includes('erneut an')) {
      isLoggedIn = false;
      logger.warn('Session expired — will re-login');
      return { blocked: false };
    }

    // Access denied
    if (lower.includes('zugriff verweigert') || lower.includes('access denied')) {
      return { blocked: true, reason: 'Access denied' };
    }

    // Maintenance mode
    if (lower.includes('wartung') || lower.includes('maintenance')) {
      return { blocked: true, reason: 'PartsLink24 is in maintenance mode' };
    }

    return { blocked: false };
  } catch {
    return { blocked: false };
  }
}

export async function assertNotBlocked(page: Page, ctx: string): Promise<void> {
  const check = await checkForBotDetection(page);
  if (check.blocked) {
    logger.error(`⛔ Bot detection during: ${ctx}`, { reason: check.reason });
    await takeScreenshot(page, `blocked-${ctx}`);
    throw new Error(`Bot detection: ${check.reason}`);
  }
}

// ============================================================================
// LOGIN — Real PL24 Login Form (verified from screenshot)
//
// Right panel of partslink24.com:
//   "Firmenkennung / ID:"  → text input (pre-filled: "de-388960")
//   "Benutzername:"         → text input ("admin")
//   "Passwort:"             → password input
//   "Passwort vergessen?"   → link
//   [Login]                 → button
// ============================================================================

async function login(page: Page): Promise<boolean> {
  if (!config.pl24.companyId || !config.pl24.username || !config.pl24.password) {
    logger.error('PartsLink24 credentials not configured! Set PL24_COMPANY_ID, PL24_USERNAME, PL24_PASSWORD');
    return false;
  }

  logger.info('Logging in to PartsLink24...');

  try {
    // Navigate to PL24 — does JS redirect from index → startup.do → login page
    await page.goto(config.pl24.baseUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });

    // Wait for the redirect chain to settle
    await waitForStable(page);
    await humanDelay(2000, 3000);

    // ── Aggressively dismiss ALL overlays (cookie consent, modals, etc.) ──
    // This MUST happen before any clicks, because overlays intercept pointer events.
    try {
      await page.evaluate(`
        (() => {
          // Remove Usercentrics root
          const uc = document.getElementById('usercentrics-root');
          if (uc) uc.remove();
          // Remove ALL fixed/absolute overlays that could block clicks
          document.querySelectorAll('*').forEach(el => {
            const style = window.getComputedStyle(el);
            if ((style.position === 'fixed' || style.position === 'absolute') &&
                style.zIndex && parseInt(style.zIndex) > 100 &&
                el.tagName !== 'INPUT' && el.tagName !== 'FORM') {
              el.remove();
            }
          });
          // Remove common overlay classes
          document.querySelectorAll(
            '[class*="overlay"], [class*="consent"], [class*="cookie"], ' +
            '[class*="modal"], [class*="backdrop"], [id*="consent"], [id*="cookie"]'
          ).forEach(el => el.remove());
        })()
      `);
      logger.info('Overlays force-removed via JS');
    } catch (err: unknown) {
      logger.warn('Overlay removal failed — continuing', { error: err instanceof Error ? err.message : String(err) });
    }

    // Wait for page to stabilize after overlay removal
    await humanDelay(1000, 1500);

    // Check for bot detection before login
    await assertNotBlocked(page, 'pre-login');

    // Log current URL for debugging
    logger.info(`Login page URL: ${safeUrlForLog(page.url())}`);

    // ── Find and fill the 3 login fields ──
    // Real PL24 login form:
    //   1. "Firmenkennung / ID:" → text input
    //   2. "Benutzername:"       → text input
    //   3. "Passwort:"           → password input

    // Wait for form to be ready — wait for password field
    const passField = page.locator('input[type="password"]:visible').first();
    try {
      await passField.waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      logger.error('Password field not visible within 15s — login form not loaded');
      await takeScreenshot(page, 'login-no-form');
      return false;
    }

    // Extra wait for all form elements to be interactive
    await humanDelay(500, 1000);

    // Get ALL visible text inputs on the page
    const textInputs = await page.locator('input[type="text"]:visible').all();
    const passInputs = await page.locator('input[type="password"]:visible').all();
    logger.info(`Login form: ${textInputs.length} text inputs, ${passInputs.length} password inputs found`);

    if (textInputs.length < 2) {
      logger.error(`Expected 2+ text inputs for login, found ${textInputs.length}`);
      await takeScreenshot(page, 'login-wrong-inputs');
      return false;
    }

    if (passInputs.length < 1) {
      logger.error('No password input found');
      await takeScreenshot(page, 'login-no-password');
      return false;
    }

    // Fill Firmenkennung / ID (1st text input) — triple-click to select all, then fill
    const companyField = textInputs[0];
    await companyField.click({ clickCount: 3 });
    await humanDelay(100, 200);
    await companyField.fill('');
    await humanDelay(50, 100);
    await companyField.type(config.pl24.companyId, { delay: 30 });
    await humanDelay(200, 400);
    logger.info('Filled Firmenkennung');

    // Fill Benutzername (2nd text input)
    const userField = textInputs[1];
    await userField.click({ clickCount: 3 });
    await humanDelay(100, 200);
    await userField.fill('');
    await humanDelay(50, 100);
    await userField.type(config.pl24.username, { delay: 30 });
    await humanDelay(200, 400);
    logger.info('Filled Benutzername');

    // Fill Passwort (password input)
    await passField.click({ clickCount: 3 });
    await humanDelay(100, 200);
    await passField.fill('');
    await humanDelay(50, 100);
    await passField.type(config.pl24.password, { delay: 30 });
    await humanDelay(300, 500);
    logger.info('Filled Passwort: ****');

    // ── Submit login form ──
    // STRATEGY: Use Enter key FIRST (most reliable in real browser sessions),
    // then fall back to clicking specific buttons.
    // The old approach of clicking a:has-text("Login") was matching navigation links!

    logger.info('Submitting login via Enter key on password field...');
    await passField.press('Enter');

    // Wait for redirect PROPERLY — give PL24 up to 15s to redirect after Enter
    logger.info('Waiting for post-login redirect...');
    let loginRedirected = false;
    try {
      await page.waitForURL(url => {
        const u = url.toString().toLowerCase();
        return u.includes('brandmenu') || u.includes('dashboard')
          || u.includes('pl24-app') || u.includes('partslink24/user/');
      }, { timeout: 15000 });
      loginRedirected = true;
      logger.info(`✅ Login redirect detected: ${safeUrlForLog(page.url())}`);
    } catch {
      // Some PL24 variants replace the page without changing the URL.
      loginRedirected = await verifyLoginSuccess(page);
      logger.info(loginRedirected
        ? 'Dashboard detected without URL change'
        : `Post-login URL did not reach a dashboard: ${safeUrlForLog(page.url())}`);
    }

    if (!loginRedirected) {
      loginRedirected = await continueCurrentSessionIfOffered(page);
    }

    if (!loginRedirected && await invalidCredentialsVisible(page)) {
      logger.error('PartsLink24 rejected the configured credentials');
      authenticationRejected = true;
      await clearLoginFields(page);
      await takeScreenshot(page, 'login-failed');
      return false;
    }

    // ONLY if Enter truly didn't work (URL still on login page), try button click
    if (!loginRedirected) {
      logger.info('Enter key did not redirect — trying button click as fallback...');

      const loginSelectors = [
        'input[value="Login"]',
        'input[value="LOGIN"]',
        'input[type="submit"][value="Login"]',
        'input[type="submit"][value="LOGIN"]',
        'input[type="submit"]',
        'button:has-text("Login")',
        'button[type="submit"]',
      ];

      let buttonClicked = false;
      for (const sel of loginSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.count() > 0 && await btn.isVisible({ timeout: 2000 })) {
            logger.info(`Clicking Login via: ${sel}`);
            await btn.click();
            buttonClicked = true;
            break;
          }
        } catch { /* try next */ }
      }

      if (!buttonClicked) {
        logger.warn('No login button found either — login may have already submitted');
      }

      // Wait again for redirect after button click
      try {
        await page.waitForURL(url => {
          const u = url.toString().toLowerCase();
          return u.includes('brandmenu') || u.includes('dashboard')
            || u.includes('pl24-app') || u.includes('partslink24/user/');
        }, { timeout: 15000 });
        loginRedirected = true;
        logger.info(`✅ Login redirect after button click: ${safeUrlForLog(page.url())}`);
      } catch {
        loginRedirected = await verifyLoginSuccess(page);
        logger.warn(loginRedirected
          ? 'Dashboard detected after button click without URL change'
          : `Still on login page after button click: ${safeUrlForLog(page.url())}`);
      }

      if (!loginRedirected) {
        loginRedirected = await continueCurrentSessionIfOffered(page);
      }

      if (!loginRedirected && await invalidCredentialsVisible(page)) {
        logger.error('PartsLink24 rejected the configured credentials');
        authenticationRejected = true;
        await clearLoginFields(page);
        await takeScreenshot(page, 'login-failed');
        return false;
      }
    }

    // ── Wait for dashboard to load ──
    logger.info('Waiting for dashboard to load...');
    let dashboardLoaded = loginRedirected;

    // If already redirected, verify we're on the dashboard
    if (dashboardLoaded) {
      const currentUrl = page.url().toLowerCase();
      dashboardLoaded = currentUrl.includes('brandmenu') || currentUrl.includes('dashboard') ||
                        currentUrl.includes('pl24-app') || currentUrl.includes('partslink24/user/');
      if (dashboardLoaded) {
        logger.info(`Dashboard URL confirmed: ${safeUrlForLog(page.url())}`);
      }
    }

    // Fallback: wait for URL change if not yet detected
    if (!dashboardLoaded) {
      try {
        await page.waitForURL(url => {
          const u = url.toString().toLowerCase();
          return !u.includes('login') && !u.includes('startup') &&
                 (u.includes('brandmenu') || u.includes('dashboard') ||
                  u.includes('pl24-app') || u.includes('partslink24/user/'));
        }, { timeout: 10000 });
        logger.info(`Dashboard URL detected: ${safeUrlForLog(page.url())}`);
        dashboardLoaded = true;
      } catch {
        logger.warn('URL did not change to dashboard');
      }
    }

    // Strategy 2: Wait for "Abmelden" text (most reliable DOM signal)
    if (!dashboardLoaded) {
      try {
        await page.locator('text=Abmelden').first().waitFor({ state: 'visible', timeout: 10000 });
        dashboardLoaded = true;
        logger.info('Dashboard detected — "Abmelden" visible');
      } catch {
        logger.warn('"Abmelden" not found');
      }
    }

    // Strategy 3: Wait for "Herzlich willkommen"
    if (!dashboardLoaded) {
      try {
        await page.locator('text=Herzlich willkommen').first().waitFor({ state: 'visible', timeout: 5000 });
        dashboardLoaded = true;
        logger.info('Dashboard detected — "Herzlich willkommen" visible');
      } catch {
        logger.warn('"Herzlich willkommen" not found');
      }
    }

    // Strategy 4: Check for VIN input field (only exists on dashboard)
    if (!dashboardLoaded) {
      try {
        const vinField = page.locator('input[placeholder*="Fahrgestell" i], input[placeholder*="VIN" i]').first();
        if (await vinField.count() > 0 && await vinField.isVisible({ timeout: 5000 })) {
          dashboardLoaded = true;
          logger.info('Dashboard detected — VIN input field visible');
        }
      } catch { /* not found */ }
    }

    // Strategy 5: Check for brand logos (dashboard has a brand grid)
    if (!dashboardLoaded) {
      try {
        const brandLinks = await page.locator('a[href*="launchCatalog"]').count();
        if (brandLinks > 0) {
          dashboardLoaded = true;
          logger.info(`Dashboard detected — ${brandLinks} brand launch links found`);
        }
      } catch { /* not found */ }
    }

    // Check for bot detection post-login
    await assertNotBlocked(page, 'post-login');

    if (!dashboardLoaded) {
      // Final verification attempt via verifyLoginSuccess
      dashboardLoaded = await verifyLoginSuccess(page);
    }

    // Log final state for debugging
    logger.info(`Login result: dashboardLoaded=${dashboardLoaded}, URL=${safeUrlForLog(page.url())}`);

    if (dashboardLoaded) {
      isLoggedIn = true;
      authenticationRejected = false;
      try { await persistPrivateStorageState(context!, STORAGE_PATH); } catch { /* ignore */ }
      logger.info('✅ Login successful!');
      return true;
    }

    logger.error('Login failed — dashboard did not load');
    await clearLoginFields(page);
    await takeScreenshot(page, 'login-failed');

    // Keep diagnostics useful without copying account or page content into logs.
    try {
      const bodyText = await page.locator('body').innerText({ timeout: 5000 });
      logger.info('Login page content unavailable for authentication', { bodyCharacters: bodyText.length });
    } catch { /* ignore */ }

    return false;

  } catch (err: unknown) {
    logger.error('Login failed with error', { error: err instanceof Error ? err.message : String(err) });
    await clearLoginFields(page);
    await takeScreenshot(page, 'login-error');
    return false;
  }
}

async function clearLoginFields(page: Page): Promise<void> {
  try {
    await page.locator('input[type="text"], input[type="password"]').evaluateAll(inputs => {
      for (const input of inputs) {
        (input as unknown as { value: string }).value = '';
      }
    });
  } catch {
    // Best-effort redaction for diagnostic screenshots.
  }
}

async function removeCookieOverlay(page: Page): Promise<void> {
  try {
    const removed = await page.evaluate<number>(`
      (() => {
        let count = 0;
        const selectors = [
          '#usercentrics-root',
          '[data-testid*="uc-"]',
          '[class*="usercentrics" i]',
          '[id*="cookie" i][class*="overlay" i]',
          '[class*="cookie" i][class*="overlay" i]',
          '[id*="consent" i][class*="overlay" i]',
          '[class*="consent" i][class*="overlay" i]'
        ];
        for (const element of document.querySelectorAll(selectors.join(','))) {
          element.remove();
          count += 1;
        }
        return count;
      })()
    `);
    if (removed > 0) logger.info(`Removed ${removed} blocking cookie-consent element(s)`);
  } catch (error) {
    logger.warn('Could not remove cookie-consent overlay', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function continueCurrentSessionIfOffered(page: Page): Promise<boolean> {
  // Partslink allows only one browser session per account. With valid
  // credentials it can therefore show an intermediate takeover screen instead
  // of the dashboard. Search every frame because deployments have used both a
  // top-level page and an embedded dialog for this step.
  const deadline = Date.now() + 7_500;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const candidates = frame.locator(
        'button, a, input[type="submit"], input[type="button"], [role="button"]',
      );
      const count = Math.min(await candidates.count(), 100);

      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        let label = '';
        try {
          label = [
            await candidate.innerText({ timeout: 500 }).catch(() => ''),
            await candidate.getAttribute('value') ?? '',
            await candidate.getAttribute('aria-label') ?? '',
            await candidate.getAttribute('title') ?? '',
          ].filter(Boolean).join(' ');
        } catch {
          continue;
        }

        if (!isPartslinkSessionContinuationLabel(label)) continue;
        if (!await candidate.isVisible().catch(() => false)) continue;

        logger.info('PartsLink24 offered the single-session continuation action');
        await takeScreenshot(page, 'session-continuation-offered');
        await candidate.click({ timeout: 5_000 });
        logger.info('Clicked PartsLink24 single-session continuation action');

        try {
          await page.waitForLoadState('domcontentloaded', { timeout: 15_000 });
        } catch { /* SPA transitions do not always produce a load event */ }
        await waitForStable(page);

        const continued = await verifyLoginSuccess(page);
        logger.info(continued
          ? 'PartsLink24 session continuation completed successfully'
          : 'PartsLink24 session continuation did not reach the dashboard');
        return continued;
      }
    }

    await page.waitForTimeout(500);
  }

  return false;
}

async function invalidCredentialsVisible(page: Page): Promise<boolean> {
  try {
    const bodyText = await page.locator('body').innerText({ timeout: 5000 });
    return /anmeldedaten\s+sind\s+ungültig|invalid\s+credentials|kennwort\s+(?:ist\s+)?falsch/i.test(bodyText);
  } catch {
    return false;
  }
}

/**
 * Verify login success by checking for dashboard indicators.
 *
 * CRITICAL: Check NEGATIVE signals FIRST to prevent false positives!
 * The login page contains "Fahrgestellnummerneinstieg" in its marketing text,
 * which would falsely match a naive "fahrgestellnummer" check.
 *
 * Real PL24 dashboard (verified March 2026) shows:
 * - "Abmelden" link in top nav (UNIQUE to dashboard — never on login page)
 * - "Herzlich willkommen bei partslink24..." (UNIQUE to dashboard)
 * - "FAHRGESTELLNUMMER" input label (but this text also appears on login page!)
 * - "Verwaltung" section (UNIQUE to dashboard)
 */
async function verifyLoginSuccess(page: Page): Promise<boolean> {
  let bodyText: string;
  try {
    bodyText = await page.locator('body').innerText({ timeout: 8000 });
  } catch {
    return false;
  }

  const lower = bodyText.toLowerCase();

  // ── STEP 1: Check NEGATIVE signals FIRST ──
  // These indicate we're still on the login page — must check before positives!
  const negativeSignals = [
    'passwort vergessen',           // Login page "forgot password" link
    'anmeldung für registrierte',   // Login page header text
    'neu bei partslink24',          // Login page promo text
    'kennwort falsch',              // Login error message
    'bitte melden sie sich erneut', // Session expired message
  ];

  for (const signal of negativeSignals) {
    if (lower.includes(signal)) {
      logger.error(`Login failed — still on login page: "${signal}"`);
      return false;
    }
  }

  // ── STEP 2: Check POSITIVE signals ──
  // These are UNIQUE to the dashboard and do NOT appear on the login page
  const dashboardSignals = [
    'abmelden',                     // Top nav link — MOST RELIABLE (login page has "Abonnement" not "Abmelden")
    'herzlich willkommen',          // Dashboard welcome text
    'verwaltung',                   // Right panel section
    'händler auswählen',            // Dashboard link
    'kurzeinstieg',                 // Dashboard quick-start link
  ];

  for (const signal of dashboardSignals) {
    if (lower.includes(signal)) {
      logger.info(`Login verified via: "${signal}"`);
      return true;
    }
  }

  // Also check catalog view signals (in case session restored directly to catalog)
  const catalogSignals = [
    'fahrzeugidentifikation',       // Catalog left panel
    'hauptgruppe',                  // Catalog main table
    'teile suchen',                 // Catalog search input
  ];

  for (const signal of catalogSignals) {
    if (lower.includes(signal)) {
      logger.info(`Login verified via catalog signal: "${signal}"`);
      return true;
    }
  }

  // The current Partslink portal (/portal-ui) may render only the VIN search
  // control before any welcome text. Unlike the marketing login page, this is
  // an actual interactive VIN input and therefore a reliable authenticated
  // signal.
  try {
    const vinSearch = page.locator(
      'input[placeholder*="Fahrgestell" i], input[data-test-id*="vinSearch" i]',
    ).first();
    if (await vinSearch.isVisible({ timeout: 2_000 })) {
      logger.info('Login verified via authenticated VIN search input');
      return true;
    }
  } catch {
    // Continue to the diagnostic fallback below.
  }

  logger.warn('Login state unclear — no positive or negative signals matched');
  await takeScreenshot(page, 'login-unclear');
  return false;
}

async function probeSharedSession(page: Page): Promise<boolean> {
  try {
    await page.goto(config.pl24.baseUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
    await waitForStable(page);
    await removeCookieOverlay(page);
    // /portal-ui mounts the authenticated VIN control asynchronously. A quick
    // body read can otherwise misclassify a valid restored session as a login
    // failure and start an unnecessary second account session.
    try {
      await Promise.race([
        page.locator(
          'input[placeholder*="Fahrgestell" i], input[data-test-id*="vinSearch" i]',
        ).first().waitFor({ state: 'visible', timeout: 12_000 }),
        page.locator('input[type="password"]:visible').first()
          .waitFor({ state: 'visible', timeout: 12_000 }),
      ]);
    } catch {
      // verifyLoginSuccess below produces the authoritative diagnostic.
    }
    if (await verifyLoginSuccess(page)) {
      isLoggedIn = true;
      authenticationRejected = false;
      try { await persistPrivateStorageState(context!, STORAGE_PATH); } catch { /* ignore */ }
      logger.info('Reusing active PartsLink24 session');
      return true;
    }
    if (await continueCurrentSessionIfOffered(page)) {
      isLoggedIn = true;
      authenticationRejected = false;
      try { await persistPrivateStorageState(context!, STORAGE_PATH); } catch { /* ignore */ }
      logger.info('Reusing continued PartsLink24 session');
      return true;
    }
  } catch {
    logger.info('PartsLink24 session probe failed');
  }
  return false;
}

export async function ensureLoggedIn(page: Page): Promise<boolean> {
  return sessionGate.runExclusive(async () => {
    // Always probe the shared context first. This is essential after a process
    // restart: storageState may already contain the only active PL24 session,
    // while the in-memory isLoggedIn flag necessarily starts as false.
    if (await probeSharedSession(page)) return true;

    // An explicit credential rejection is process-latched. This prevents
    // direct, bulk and QA callers from turning one rejected login into a
    // sequence of account attempts. A controlled restart permits exactly one
    // new attempt after credentials or the external PL24 session were fixed.
    if (authenticationRejected) {
      logger.warn('PartsLink24 authentication remains blocked after explicit credential rejection');
      return false;
    }

    if (isLoggedIn) {
      logger.info('Stored PartsLink24 session expired — one controlled re-login is required');
    }
    isLoggedIn = false;
    try {
      return await login(page);
    } catch (error) {
      logger.warn('Controlled PartsLink24 login failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  });
}

// ============================================================================
// BRAND SELECTION — Click on brand logo in the dashboard grid
//
// Real PL24 dashboard (screenshot 4):
// Brand logos in a grid, each is an <img> inside an <a> link.
// Visible brands: VW, SKODA, SEAT, CUPRA, Audi, Alpine, Bentley,
//   BMW, BMW Classic, Citroën, Dacia, Cupra, Fiat, Ford, Ford Pro,
//   Hyundai, Infiniti, Iveco, Jaguar, Jeep, Kia, Land Rover,
//   Lexus, MAN, Mercedes Classic, etc.
// ============================================================================

const BRAND_MAP: Record<string, string[]> = {
  VW:          ['Volkswagen', 'VW'],
  VOLKSWAGEN:  ['Volkswagen', 'VW'],
  AUDI:        ['Audi'],
  BMW:         ['BMW'],
  MERCEDES:    ['Mercedes'],
  PORSCHE:     ['Porsche'],
  SEAT:        ['SEAT', 'Seat'],
  SKODA:       ['SKODA', 'Skoda', 'Škoda'],
  CUPRA:       ['CUPRA', 'Cupra'],
  FORD:        ['Ford'],
  OPEL:        ['Opel'],
  TOYOTA:      ['Toyota'],
  HYUNDAI:     ['Hyundai'],
  KIA:         ['Kia'],
  RENAULT:     ['Renault'],
  PEUGEOT:     ['Peugeot'],
  CITROEN:     ['Citroën', 'Citroen'],
  FIAT:        ['Fiat'],
  VOLVO:       ['Volvo'],
  JAGUAR:      ['Jaguar'],
  'LAND ROVER':['Land Rover'],
  MINI:        ['MINI', 'Mini'],
  NISSAN:      ['Nissan'],
  HONDA:       ['Honda'],
  MAZDA:       ['Mazda'],
  SUZUKI:      ['Suzuki'],
  LEXUS:       ['Lexus'],
  BENTLEY:     ['Bentley'],
  IVECO:       ['Iveco'],
  MAN:         ['MAN'],
  DACIA:       ['Dacia'],
  INFINITI:    ['Infiniti'],
  JEEP:        ['Jeep'],
  ALPINE:      ['Alpine'],
};

export { BRAND_MAP };

/**
 * PL24 service names used in launchCatalog.do URLs.
 * Discovered from real PL24 dashboard HTML (April 2026):
 *   <a href="/partslink24/launchCatalog.do?service=audi_parts&t=...">Audi</a>
 */
const PL24_SERVICE_MAP: Record<string, string> = {
  VW:          'vw_parts',
  AUDI:        'audi_parts',
  BMW:         'bmw_parts',
  MERCEDES:    'mercedes_parts',
  PORSCHE:     'porsche_parts',
  SEAT:        'seat_parts',
  SKODA:       'skoda_parts',
  CUPRA:       'cupra_parts',
  FORD:        'fordp_parts',
  OPEL:        'opel_parts',
  TOYOTA:      'toyota_parts',
  HYUNDAI:     'hyundai_parts',
  KIA:         'kia_parts',
  RENAULT:     'renault_parts',
  PEUGEOT:     'peugeot_parts',
  CITROEN:     'citroen_parts',
  FIAT:        'fiatp_parts',
  VOLVO:       'volvo_parts',
  JAGUAR:      'jaguar_parts',
  'LAND ROVER':'landrover_parts',
  MINI:        'mini_parts',
  NISSAN:      'nissan_parts',
  HONDA:       'honda_parts',
  MAZDA:       'mazda_parts',
  SUZUKI:      'suzuki_parts',
  LEXUS:       'lexus_parts',
  BENTLEY:     'bentley_parts',
  DACIA:       'dacia_parts',
  JEEP:        'jeep_parts',
  ALPINE:      'alpine_parts',
  IVECO:       'iveco_parts',
  INFINITI:    'infiniti_parts',
  MAN:         'man_parts',
};

export { PL24_SERVICE_MAP };

export async function selectBrand(page: Page, brand: string): Promise<boolean> {
  const upper = brand.toUpperCase();
  const names = BRAND_MAP[upper] || [brand];
  const serviceName = PL24_SERVICE_MAP[upper];
  await removeCookieOverlay(page);

  // Strategy 1: Click launchCatalog link by service name (most reliable)
  // PL24 dashboard uses: <a href="/partslink24/launchCatalog.do?service=audi_parts&t=...">
  if (serviceName) {
    try {
      const sel = `a[href*="service=${serviceName}"]`;
      const el = page.locator(sel).first();
      if (await el.count() > 0) {
        logger.info(`Selecting brand "${brand}" via launchCatalog: ${sel}`);
        await el.click();
        await waitForStable(page);
        await humanDelay(500, 1000);
        return true;
      }
    } catch { /* try next */ }
  }

  // Strategy 2: Click link by brand text (backup)
  for (const name of names) {
    const textSelectors = [
      `a:text-is("${name}")`,
      `a:has-text("${name}")`,
      `img[alt*="${name}" i]`,
      `a[title*="${name}" i]`,
    ];

    for (const sel of textSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible()) {
          logger.info(`Selecting brand "${name}" via: ${sel}`);
          await el.click();
          await waitForStable(page);
          await humanDelay(500, 1000);
          return true;
        }
      } catch { /* try next */ }
    }
  }

  logger.warn(`Brand "${brand}" not found in dashboard grid`);
  return false;
}

// ============================================================================
// VIN LOOKUP
//
// DASHBOARD (screenshot 4): "FAHRGESTELLNUMMER" label + text input + "GO" button
// CATALOG VIEW (screenshot 1): VIN already in top-left input, re-entry possible
// ============================================================================

export async function navigateToVehicle(page: Page, vin: string, brand?: string): Promise<boolean> {
  logger.info('Navigating to vehicle...', { vin });

  try {
    // ── PL24 Dashboard: VIN input is on the MAIN PAGE (not in frames) ──
    // After login, the dashboard shows a text input with placeholder "Fahrgestellnummer"
    // next to a "GO" button. This is NOT inside an iframe — it's in the main DOM.
    await page.waitForTimeout(2000);
    await removeCookieOverlay(page);

    // Log current URL for debugging
    logger.info(`Current URL: ${safeUrlForLog(page.url())}`);

    // ── Step 1: Find VIN input on the dashboard ──
    let vinField: Locator | null = null;
    const vinSelectors = [
      'input[placeholder="Fahrgestellnummer"]',     // Exact match from real PL24 dashboard
      'input[placeholder*="FAHRGESTELL" i]',        // Case-insensitive variant
      'input[placeholder*="fahrgestell" i]',
      'input[maxlength="17"][type="text"]',          // VIN length attribute
    ];

    for (const sel of vinSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0 && await el.isVisible({ timeout: 3000 })) {
          vinField = el;
          logger.info(`Found VIN field via: ${sel}`);
          break;
        }
      } catch { /* try next */ }
    }

    // Fallback: check inside frames (in case PL24 ever switches back to framesets)
    if (!vinField) {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        for (const sel of vinSelectors) {
          try {
            const el = frame.locator(sel).first();
            if (await el.count() > 0) {
              vinField = el;
              logger.info(`Found VIN field in frame "${frame.name()}": ${sel}`);
              break;
            }
          } catch { /* skip */ }
        }
        if (vinField) break;
      }
    }

    if (!vinField) {
      logger.error('VIN input not found on dashboard!');
      await takeScreenshot(page, 'vin-not-found');
      return false;
    }

    // ── Step 2: Enter VIN ──
    // Usercentrics can mount again after the authenticated portal SPA renders,
    // even when it was already removed on the login page.
    await removeCookieOverlay(page);
    await vinField.click();
    await humanDelay(200, 400);
    await vinField.fill('');
    await humanDelay(100, 200);
    await vinField.type(vin, { delay: 50 });
    await humanDelay(300, 600);
    logger.info('VIN entered', { vin });

    // ── Step 3: Click GO button ──
    // Real PL24 dashboard: the GO button is right next to the VIN input.
    // It can be an <input type="submit" value="GO">, a <button>, or a <div>.
    let goClicked = false;
    const goSelectors = [
      'input[type="submit"][value="GO"]',            // Submit button with GO text
      'input[type="submit"][value="Go"]',
      'button:has-text("GO")',                       // Button with GO text
      'div.search-btn',                              // Div-based GO button
      '#tooltip-go',                                 // GO tooltip div
      'input[type="submit"]',                        // Generic submit
    ];

    for (const sel of goSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.count() > 0 && await btn.isVisible({ timeout: 2000 })) {
          logger.info(`Clicking GO: ${sel}`);
          await btn.click();
          goClicked = true;
          break;
        }
      } catch { /* try next */ }
    }

    if (!goClicked) {
      logger.info('GO button not found — submitting via Enter key');
      await vinField.press('Enter');
    }

    // A VIN can be offered by more than one licensed catalog (for example
    // "Ford" and "Ford Nutzfahrzeuge"). The new portal waits for this choice
    // instead of navigating immediately.
    await chooseVinCatalogOption(page, vin, brand);

    // ── Step 4: Wait for SPA navigation to catalog ──
    // After clicking GO, PL24 navigates to a React SPA:
    //   https://www.partslink24.com/pl24-app/{brand}_parts/{VIN}/0/vehicle
    // The URL contains "/pl24-app/" — this is the key signal.
    logger.info('Waiting for catalog SPA to load...');

    let catalogFound = false;

    // Strategy 1: Wait for URL to change to /pl24-app/ (most reliable)
    try {
      await page.waitForURL(/\/pl24-app\//, { timeout: 30000 });
      logger.info(`✅ SPA URL detected: ${safeUrlForLog(page.url())}`);
      catalogFound = true;
    } catch {
      logger.warn('URL did not change to /pl24-app/ within 30s');
    }

    // Strategy 2: Wait for catalog UI signals in the DOM
    if (!catalogFound) {
      const signals = [
        'input[placeholder="Teile suchen"]',         // Parts search field in catalog
        'text=Hauptgruppe',                           // Main category header
        'text=Fahrzeugidentifikation',                // Vehicle ID panel
      ];

      for (let attempt = 0; attempt < 10; attempt++) {
        for (const sig of signals) {
          try {
            const el = page.locator(sig).first();
            if (await el.isVisible({ timeout: 2000 })) {
              logger.info(`✅ Catalog signal found: "${sig}" (attempt ${attempt + 1})`);
              catalogFound = true;
              break;
            }
          } catch { /* skip */ }
        }
        if (catalogFound) break;
        logger.info(`Catalog not ready (attempt ${attempt + 1}/10)...`);
        await page.waitForTimeout(3000);
      }
    }

    // Wait for SPA to fully render — the URL changes BEFORE React components mount
    if (catalogFound) {
      // Wait for the "Teile suchen" search input to appear (key indicator the SPA is ready)
      logger.info('SPA URL loaded — waiting for React components to mount...');
      try {
        await page.locator('input[placeholder="Teile suchen"]').first().waitFor({ state: 'visible', timeout: 15000 });
        logger.info('✅ "Teile suchen" input visible — SPA fully rendered');
      } catch {
        // Fallback: wait for any catalog signal
        logger.warn('"Teile suchen" not visible within 15s — checking other signals');
        try {
          await page.locator('text=Hauptgruppe').first().waitFor({ state: 'visible', timeout: 10000 });
          logger.info('✅ "Hauptgruppe" visible — SPA rendered');
        } catch {
          logger.warn('SPA render signals not detected — proceeding anyway');
          await page.waitForTimeout(5000); // Last resort: just wait
        }
      }
      await takeScreenshot(page, 'vin-result');
      logger.info('✅ Vehicle identified — catalog loaded', { vin, url: safeUrlForLog(page.url()) });
    } else {
      await takeScreenshot(page, 'vin-no-catalog');
      logger.warn('Catalog not found after GO — page may still be on dashboard', {
        vin,
        url: safeUrlForLog(page.url()),
      });

      // Record only content length; page text can contain account and vehicle data.
      try {
        const bodyText = await page.locator('body').innerText({ timeout: 5000 });
        logger.info('Catalog page did not expose a known result signal', { bodyCharacters: bodyText.length });
      } catch { /* ignore */ }
    }

    return catalogFound;

  } catch (err: unknown) {
    logger.error('Navigate to vehicle failed', { vin, error: err instanceof Error ? err.message : String(err) });
    await takeScreenshot(page, 'vin-error');
    return false;
  }
}

async function chooseVinCatalogOption(page: Page, vin: string, brand?: string): Promise<boolean> {
  const ambiguityPrompt = page.getByText(
    /Für diese FIN wurden mehrere Einträge gefunden|multiple entries (?:were )?found/i,
  ).first();

  try {
    await ambiguityPrompt.waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    return false;
  }

  const normalizedBrand = brand?.trim().toUpperCase();
  const vinMatches = page.getByText(vin, { exact: true });
  const count = await vinMatches.count();
  let fallback: Locator | null = null;

  for (let index = 0; index < count; index += 1) {
    let candidate = vinMatches.nth(index);
    fallback ??= candidate;

    // Walk only through the small option row. Stop before reaching the popup
    // container, which includes all alternatives and would make the choice
    // ambiguous again.
    for (let depth = 0; depth < 4; depth += 1) {
      candidate = candidate.locator('xpath=..');
      const text = (await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!text || text.length > 160 || !text.includes(vin)) continue;

      const upper = text.toUpperCase();
      const isPreferred = !normalizedBrand
        || (normalizedBrand === 'FORD'
          ? upper.startsWith('FORD ') && !upper.includes('NUTZFAHRZEUGE')
          : upper.includes(normalizedBrand));

      if (!isPreferred) continue;
      logger.info('Selecting VIN catalog option', { brand: brand || 'first available' });
      await candidate.click({ timeout: 5_000 });
      return true;
    }
  }

  if (fallback) {
    logger.warn('No exact brand match in VIN catalog choices — selecting the first option', { brand });
    await fallback.click({ timeout: 5_000 });
    return true;
  }

  logger.warn('VIN catalog ambiguity prompt was visible, but no selectable option was found');
  return false;
}

// ============================================================================
// PART SEARCH — "Teile suchen" input in the SPA catalog top bar
//
// Real PL24 catalog (verified March 2026):
// Top bar: [BMW Logo] [VIN input] [🔍] | [Teile suchen] [🔍] | [Händler wählen]
// The "Teile suchen" field is a React MUI input with placeholder="Teile suchen".
//
// After search, URL changes to: /pl24-app/{brand}_parts/{VIN}/0/search?q={query}
// Left sidebar panel shows: "Suche: ölfilter"
// Results in a scrollable drawer (div._listScrollContainer_*):
//   Bildtafel    11_9979
//   Teilenummer  11 42 7 508 966
//   Benennung    Ölfilter mit Kunststoffdeckel
//   HG           11
//   FG           30
// ============================================================================

const PART_SEARCH_POSITION_WORDS = new Set([
  'vorn', 'vorne', 'hinten', 'links', 'rechts', 'linke', 'rechter', 'rechte',
  'linker', 'oben', 'unten', 'innen', 'aussen', 'außen', 'fahrerseite',
  'beifahrerseite', 'vorderachse', 'hinterachse', 'va', 'ha', 'vl', 'vr', 'hl', 'hr',
]);

const PART_SEARCH_ALIASES: Array<[RegExp, string]> = [
  [/\bpenelst(?:u|ü)tze\b/gi, 'Pendelstütze'],
  [/\bbremszange\b/gi, 'Bremssattel'],
  [/\bbremssattelhalter\b|\bbremssatteltr(?:a|ä)ger\b/gi, 'Bremsträger'],
  [/\bhandbremsseil\b|\bhandbremszug\b|\bfeststellbremsseil\b|\bfeststellbremszug\b|\b(?:bowdenzug|seilzug)\s+feststellbremse\b/gi, 'Handbremsbowdenzug'],
  [/\bdomlager\b|\bfederbeinlager\b/gi, 'Stützlager'],
  [/\bstabigummi\b|\bstabilisatorlager\b/gi, 'Gummilager Stabilisator'],
  [/\bschwenklager\b/gi, 'Achsschenkel'],
  [/\bspurstangenkopf\b/gi, 'Spurstange'],
  [/\bt(?:u|ü)rfalle\b/gi, 'Türschloss'],
  [/\b(?:wa[\s-]?pu|wasserpump)\b/gi, 'Wasserpumpe'],
  [/\bluftmesser\b/gi, 'Luftmassenmesser'],
  [/\b(?:lima|lichtmaschine)\b/gi, 'Generator'],
  [/\b(?:rückleuchte|rueckleuchte|schlussleuchte)\b/gi, 'Heckleuchte'],
  [/\bfensterheber\s+ohne\s+motor\b/gi, 'Fensterheber'],
  [/\b(?:fensterhebermotor|elektromotor\s+fensterheber)\b/gi, 'Fensterheberantrieb'],
  [/\b(?:kraftstoffpumpe\s+im\s+tank|tankpumpe|vorförderpumpe|vorfoerderpumpe)\b/gi, 'Kraftstoffpumpe'],
  [/\b(?:kraftstoffhochdruckpumpe|hochdruckpumpe|einspritzpumpe)\b/gi, 'Hochdruckpumpe'],
  [/\b(?:bremsbelag\s*(?:verschleiß|verschleiss)sensor|verschleißsensor\s+bremsbelag|verschleisssensor\s+bremsbelag|warnkontakt\s+bremsbelag)\b/gi, 'Bremsbelagfühler'],
  [/\b(?:klimakondensator|klimakühler|klimakuehler)\b/gi, 'Kondensator'],
  [/\bscheibenwischer\b/gi, 'Wischerblatt'],
];

/**
 * Partslink's free-text search treats additional words broadly. A query such as
 * "Koppelstange vorne links" therefore returns arbitrary parts whose names only
 * contain "vorne links". Search the component family first; axle/side remain
 * independent result semantics in the comparison layer.
 */
export function partslinkSearchQuery(partQuery: string): string {
  const original = partQuery.normalize('NFKC').replace(/\s+/g, ' ').trim();
  let aliased = original;
  for (const [pattern, replacement] of PART_SEARCH_ALIASES) {
    aliased = aliased.replace(pattern, replacement);
  }
  const componentOnly = aliased
    .split(/[\s,;/()[\]{}]+/)
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => !PART_SEARCH_POSITION_WORDS.has(token.toLocaleLowerCase('de-DE')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return componentOnly || original;
}

async function searchPart(
  page: Page,
  partQuery: string,
  options: { fastAudit?: boolean } = {},
): Promise<OemResult[]> {
  logger.info('Searching for part...', { partQuery });

  try {
    await removeCookieOverlay(page);
    // ── Find "Teile suchen" input on the SPA page ──
    let searchField = await findSearchInput(page);

    if (!searchField) {
      logger.error('"Teile suchen" input not found in catalog SPA!');
      logger.info(`Current URL: ${safeUrlForLog(page.url())}`);
      await takeScreenshot(page, 'search-not-found');
      throw new Error('PARTSLINK_SEARCH_FIELD_MISSING');
    }

    // Click, clear, and type search query
    await searchField.click();
    await humanDelay(options.fastAudit ? 50 : 200, options.fastAudit ? 100 : 400);
    await searchField.fill('');
    await humanDelay(options.fastAudit ? 25 : 100, options.fastAudit ? 75 : 200);
    await searchField.type(partQuery, { delay: options.fastAudit ? 15 : 40 });
    await humanDelay(options.fastAudit ? 100 : 300, options.fastAudit ? 250 : 600);
    logger.info('Search query entered', { partQuery });

    // Submit search (Enter key — most reliable in the SPA)
    await searchField.press('Enter');
    logger.info('Search submitted');

    // Wait for search results to appear
    const resultState = await waitForSearchResults(page, partQuery);
    await humanDelay(options.fastAudit ? 350 : 1500, options.fastAudit ? 700 : 3000);

    // Check for bot detection
    await assertNotBlocked(page, 'part-search');

    // Take debug screenshot
    await takeScreenshot(page, 'search-results');

    // Log current URL (should contain ?q=...)
    logger.info(`Search URL: ${safeUrlForLog(page.url())}`);

    // Extract OEM results from the SPA page
    if (resultState === 'empty') {
      logger.info(`Partslink explicitly reported no OEM results for "${partQuery}"`);
      return [];
    }

    const results = await extractOemResults(page);
    if (results.length === 0) {
      throw new Error('PARTSLINK_RESULT_EXTRACTION_EMPTY');
    }
    logger.info(`Found ${results.length} OEM results for "${partQuery}"`, {
      results: results.slice(0, 5).map(r => `${r.oem} (${r.description})`),
    });

    return results;

  } catch (err: unknown) {
    logger.error('Part search failed', { partQuery, error: err instanceof Error ? err.message : String(err) });
    await takeScreenshot(page, 'search-error');
    throw err;
  }
}

async function findSearchInput(page: Page): Promise<Locator | null> {
  // The catalog is a React SPA — "Teile suchen" input is on the MAIN PAGE.
  // The React components mount asynchronously after URL change, so we must WAIT for them.
  // Exact HTML: <input placeholder="Teile suchen" type="text" class="MuiInputBase-input...">

  // Strategy 1: Wait for the exact selector (most reliable)
  const primarySelector = 'input[placeholder="Teile suchen"]';
  try {
    const el = page.locator(primarySelector).first();
    await el.waitFor({ state: 'visible', timeout: 20000 });
    logger.info(`Found search field via waitFor: ${primarySelector}`);
    return el;
  } catch {
    logger.warn(`"${primarySelector}" not visible within 20s`);
  }

  // Strategy 2: Try alternative selectors with shorter timeout
  const altSelectors = [
    '#partSearchInput input[type="text"]',          // Parent container ID
    'input[placeholder*="Teile" i]',               // Partial match
    'input[placeholder*="suchen" i]',              // Partial match
    'input[placeholder*="search" i]',              // English fallback
  ];

  for (const sel of altSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible({ timeout: 3000 })) {
        logger.info(`Found search field via fallback: ${sel}`);
        return el;
      }
    } catch { /* try next */ }
  }

  // Strategy 3: Positional — find text inputs and use the search one
  // In the catalog SPA, there are typically 2+ text inputs: VIN display + search
  try {
    const allInputs = await page.locator('input[type="text"]:visible').all();
    logger.info(`Positional fallback: ${allInputs.length} visible text inputs found`);
    if (allInputs.length >= 2) {
      // The search input is typically the last one or the second one
      return allInputs[allInputs.length - 1];
    }
  } catch { /* ignore */ }

  // Debug: log what IS on the page
  try {
    const inputs = await page.locator('input').all();
    const inputInfo = [];
    for (const inp of inputs.slice(0, 10)) {
      try {
        const placeholder = await inp.getAttribute('placeholder');
        const type = await inp.getAttribute('type');
        const visible = await inp.isVisible();
        inputInfo.push({ placeholder, type, visible });
      } catch { /* skip */ }
    }
    logger.info(`All inputs on page: ${JSON.stringify(inputInfo)}`);
  } catch { /* ignore */ }

  return null;
}

/**
 * Wait for search results to appear in the SPA sidebar.
 * Real PL24 shows "Suche: ölfilter" header and Bildtafel/Teilenummer blocks
 * in a scrollable drawer panel.
 */
async function waitForSearchResults(
  page: Page,
  query: string,
): Promise<'results' | 'empty'> {
  // Strategy 1: Wait for URL to contain search query parameter
  try {
    await page.waitForURL(/[?&]q=/, { timeout: 15000 });
    logger.info('URL contains search query parameter');
  } catch {
    logger.debug('URL did not update with search query');
  }

  // Strategy 2: Wait for result signals in the DOM
  const resultSignals = [
    'text=Teilenummer',                              // Result field label
    'text=Bildtafel',                                // Result field label
    'text=Benennung',                                // Result field label
  ];

  for (const signal of resultSignals) {
    try {
      await page.locator(signal).first().waitFor({ state: 'visible', timeout: 10000 });
      logger.info(`Search results loaded — signal: "${signal}"`);
      return 'results';
    } catch { /* try next */ }
  }

  const emptySignals = [
    'text=Es wurden keine Einträge',
    'text=Keine Einträge gefunden',
    'text=Keine Ergebnisse gefunden',
    'text=Keine Treffer',
  ];
  for (const signal of emptySignals) {
    try {
      await page.locator(signal).first().waitFor({ state: 'visible', timeout: 3000 });
      logger.info(`Partslink explicitly reported an empty result — signal: "${signal}"`);
      return 'empty';
    } catch { /* try next */ }
  }

  logger.error('No conclusive Partslink result state detected', {
    query,
    url: safeUrlForLog(page.url()),
  });
  throw new Error('PARTSLINK_RESULT_STATE_UNCONFIRMED');
}

// ============================================================================
// RESULT EXTRACTION — Parse the real PL24 search results (from screenshot 2)
//
// Format (exactly as shown in real UI):
//   Bildtafel    11_9979
//   Teilenummer  11 42 7 508 966
//   Benennung    Ölfilter mit Kunststoffdeckel
//   HG           11
//   FG           30
//
//   Bildtafel    11_9979
//   Teilenummer  11 42 7 508 968
//   Benennung    Ölfilterdeckel
//   HG           11
//   FG           30
//
//   Bildtafel    02_0057
//   Teilenummer  11 42 7 508 969
//   Benennung    Satz Ölfiltereinsatz
//   HG           02
//   FG           05
// ============================================================================

async function extractOemResults(page: Page): Promise<OemResult[]> {
  try {
    const bodyText = await page.locator('body').innerText({ timeout: 8000 });
    const results = extractFromText(bodyText);

    // Deduplicate by normalized OEM + description
    const unique = new Map<string, OemResult>();
    for (const r of results) {
      const key = r.oem.replace(/[\s\-.]/g, '') + '|' + r.description;
      if (!unique.has(key)) unique.set(key, r);
    }

    const deduped = Array.from(unique.values());
    logger.info(`Extracted ${results.length} raw → ${deduped.length} unique results`);
    return deduped;

  } catch (err: unknown) {
    logger.error('Result extraction failed', { error: err instanceof Error ? err.message : String(err) });
    throw new Error(
      `PARTSLINK_RESULT_EXTRACTION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function extractFromText(text: string): OemResult[] {
  const results: OemResult[] = [];

  // Strategy 1: Split by "Bildtafel" boundaries (each result block starts with Bildtafel)
  const blocks = text.split(/(?=Bildtafel\s)/gi);
  for (const block of blocks) {
    if (!block.includes('Teilenummer')) continue;
    const result = parseResultBlock(block);
    if (result) results.push(result);
  }

  // Strategy 2: Split by "Teilenummer" boundaries
  if (results.length === 0) {
    const tnBlocks = text.split(/(?=Teilenummer\s)/gi);
    for (const block of tnBlocks) {
      if (!block.startsWith('Teilenummer')) continue;
      const result = parseResultBlock(block);
      if (result) results.push(result);
    }
  }

  // Strategy 3: Regex-based extraction for specific OEM formats
  if (results.length === 0) {
    results.push(...extractByPattern(text));
  }

  return results;
}

function parseResultBlock(block: string): OemResult | null {
  const bildMatch = block.match(/Bildtafel\s+(\S+)/i);
  // Keep the match on one line. `\s` also consumes newlines and previously
  // appended the following "Benennung" label to otherwise valid OEM numbers.
  const oemMatch = block.match(/Teilenummer\s+([A-Z0-9][ A-Z0-9\-.]{4,25})/i);
  const descMatch = block.match(/Benennung\s+(.+?)(?:\n|Bildtafel|HG\s|FG\s|$)/i);
  const hgMatch = block.match(/\bHG\s+(\d+)/i);
  const fgMatch = block.match(/\bFG\s+(\d+)/i);

  if (!oemMatch) return null;

  const oem = oemMatch[1].trim();
  // Real BMW OEM: "11 42 7 508 966" = 11 chars without spaces
  if (oem.replace(/\s/g, '').length < 7) return null;

  return {
    oem,
    description: descMatch?.[1]?.trim() || '',
    bildtafel: bildMatch?.[1]?.trim(),
    hg: hgMatch?.[1]?.trim(),
    fg: fgMatch?.[1]?.trim(),
  };
}

function extractByPattern(text: string): OemResult[] {
  const results: OemResult[] = [];
  const found = new Set<string>();

  const patterns = [
    /Teilenummer\s+([A-Z0-9][ A-Z0-9\-.]{6,18})/gi,         // Value capture stays on one line
    /(\d{2}\s\d{2}\s\d\s\d{3}\s\d{3})/g,                    // BMW: "11 42 7 508 966"
    /([A-Z]\s?\d{3}\s?\d{3}\s?\d{2}\s?\d{2})/g,             // Mercedes: "A 205 421 10 12"
    /([A-Z0-9]{2,3}\s?\d{3}\s?\d{3}\s?[A-Z0-9]{0,2})/g,    // VAG: "5Q0 615 301 F"
    /(9[A-Z]\d\s?\d{3}\s?\d{3}\s?\d{2})/g,                  // Porsche
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const oem = match[1].trim();
      const normalized = oem.replace(/\s/g, '');
      if (normalized.length >= 7 && normalized.length <= 15 && !found.has(normalized)) {
        found.add(normalized);

        const idx = text.indexOf(oem);
        const nearby = text.substring(Math.max(0, idx - 150), idx + oem.length + 150);
        const descMatch = nearby.match(/Benennung\s+(.+?)(?:\n|Teilenummer|Bildtafel)/i);

        results.push({
          oem,
          description: descMatch?.[1]?.trim() || '',
        });
      }
    }
  }

  return results;
}

// ============================================================================
// PUBLIC API — Queue-wrapped for concurrency safety
// ============================================================================

export interface LookupRequest {
  vin: string;
  partQuery: string;
  brand?: string;
}

export interface LookupResponse {
  success: boolean;
  vin: string;
  partQuery: string;
  results: OemResult[];
  fromCache: boolean;
  elapsedMs: number;
  error?: string;
  screenshots?: string[];
}

export interface BatchLookupRequest {
  vin: string;
  partQueries: string[];
  brand?: string;
}

/**
 * Full OEM lookup pipeline — queued for serialized processing.
 */
export async function lookupOem(req: LookupRequest): Promise<LookupResponse> {
  const label = `VIN=${req.vin} Part="${req.partQuery}" Brand=${req.brand || 'auto'}`;
  return enqueue(() => runExclusiveBrowserOperation(() => lookupOemInternal(req)), label);
}

/**
 * Batch pipeline for QA and catalogue audits.
 *
 * Partslink's login and VIN navigation dominate the runtime of a lookup. This
 * variant opens the vehicle once and performs every search serially inside the
 * same SPA page and the same authenticated browser session.
 */
export async function lookupOemBatch(req: BatchLookupRequest): Promise<LookupResponse[]> {
  const queries = req.partQueries
    .map(query => String(query || '').trim())
    .filter(Boolean);
  if (!queries.length || queries.length > 250) {
    throw new Error('PARTSLINK_BATCH_SIZE_INVALID');
  }
  const label = `VIN=${req.vin} Batch=${queries.length} Brand=${req.brand || 'auto'}`;
  const timeoutMs = Math.max(300_000, Math.min(30 * 60_000, queries.length * 15_000));
  return enqueue(
    () => runExclusiveBrowserOperation(() => lookupOemBatchInternal({ ...req, partQueries: queries })),
    label,
    'low',
    timeoutMs,
  );
}

async function lookupOemBatchInternal(req: BatchLookupRequest): Promise<LookupResponse[]> {
  const { vin, brand, partQueries } = req;
  const failedBatch = (error: string): LookupResponse[] => partQueries.map(partQuery => ({
    success: false,
    vin,
    partQuery,
    results: [],
    fromCache: false,
    elapsedMs: 0,
    error,
  }));

  if (!context) return failedBatch('Browser not initialized');

  let page: Page | null = null;
  try {
    page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const loggedIn = await ensureLoggedIn(page);
    if (!loggedIn) {
      return failedBatch(authenticationRejected || await invalidCredentialsVisible(page)
        ? 'Partslink authentication rejected'
        : 'Login failed');
    }
    const vehicleFound = await navigateToVehicle(page, vin, brand);
    if (!vehicleFound) return failedBatch('Vehicle identification failed');

    const responses: LookupResponse[] = [];
    for (let index = 0; index < partQueries.length; index += 1) {
      const partQuery = partQueries[index];
      const startedAt = Date.now();
      try {
        const timeSinceLastReq = Date.now() - lastRequestTime;
        if (timeSinceLastReq < config.requestDelayMs) {
          await sleep(config.requestDelayMs - timeSinceLastReq);
        }
        const results = await searchPart(
          page,
          partslinkSearchQuery(partQuery),
          { fastAudit: process.env.PARTSLINK_FAST_AUDIT === 'true' },
        );
        lastRequestTime = Date.now();
        lastSuccessfulLookup = new Date().toISOString();
        responses.push({
          success: true,
          vin,
          partQuery,
          results,
          fromCache: false,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        logger.warn('Batch part lookup failed', {
          batchIndex: index + 1,
          batchSize: partQueries.length,
          partQuery,
          error,
        });
        responses.push({
          success: false,
          vin,
          partQuery,
          results: [],
          fromCache: false,
          elapsedMs: Date.now() - startedAt,
          error,
        });
      }
    }
    return responses;
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
  }
}

async function lookupOemInternal(req: LookupRequest): Promise<LookupResponse> {
  const start = Date.now();
  const { vin, partQuery, brand } = req;
  const catalogSearchQuery = partslinkSearchQuery(partQuery);

  // Rate limiting
  const timeSinceLastReq = Date.now() - lastRequestTime;
  if (timeSinceLastReq < config.requestDelayMs) {
    const waitMs = config.requestDelayMs - timeSinceLastReq;
    logger.debug(`Rate limiting — waiting ${waitMs}ms`);
    await sleep(waitMs);
  }

  if (!context) {
    return {
      success: false, vin, partQuery, results: [],
      fromCache: false, elapsedMs: Date.now() - start,
      error: 'Browser not initialized',
    };
  }

  let page: Page | null = null;
  let retries = 0;

  while (retries <= MAX_RETRIES) {
    try {
      page = await context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      // Step 1: Login
      const loggedIn = await ensureLoggedIn(page);
      if (!loggedIn) {
        throw new Error(authenticationRejected || await invalidCredentialsVisible(page)
          ? 'Partslink authentication rejected'
          : 'Login failed');
      }

      // Step 2: Navigate to vehicle (brand + VIN)
      const vehicleFound = await navigateToVehicle(page, vin, brand);
      if (!vehicleFound) throw new Error('Vehicle identification failed');

      // Step 3: Search for part
      const results = await searchPart(page, catalogSearchQuery);

      lastRequestTime = Date.now();
      lastSuccessfulLookup = new Date().toISOString();

      const screenshots: string[] = [];
      if (process.env.PARTSLINK_SCREENSHOTS === 'true') {
        for (const f of ['search-results.png', 'vin-result.png']) {
          const p = path.join(STORAGE_DIR, f);
          if (fs.existsSync(p)) screenshots.push(f);
        }
      }

      return {
        // The lookup itself completed even when this wording has no result.
        // The comparison layer classifies a genuine empty result separately
        // from provider and authentication failures.
        success: true,
        vin, partQuery, results,
        fromCache: false,
        elapsedMs: Date.now() - start,
        screenshots,
      };

    } catch (err: unknown) {
      retries++;
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.warn(`Lookup attempt ${retries}/${MAX_RETRIES + 1} failed`, {
        vin, partQuery, error: errorMessage,
      });

      const nonRetryable = errorMessage === 'Partslink authentication rejected';
      if (nonRetryable || retries > MAX_RETRIES) {
        return {
          success: false, vin, partQuery, results: [],
          fromCache: false, elapsedMs: Date.now() - start,
          error: nonRetryable
            ? errorMessage
            : `All ${MAX_RETRIES + 1} attempts failed: ${errorMessage}`,
        };
      }

      // A vehicle/search/navigation failure does not prove that the account
      // session expired. The next attempt probes the shared context and only
      // performs a new login when Partslink itself proves the session invalid.
      await humanDelay(3000, 6000);

    } finally {
      if (page) {
        try { await page.close(); } catch { /* ignore */ }
      }
    }
  }

  return {
    success: false, vin, partQuery, results: [],
    fromCache: false, elapsedMs: Date.now() - start,
    error: 'Max retries exceeded',
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return sleep(ms);
}

export async function waitForStable(page: Page, timeout: number = NAVIGATION_TIMEOUT): Promise<void> {
  try {
    await page.waitForLoadState('load', { timeout });
  } catch {
    logger.debug('waitForStable: load timed out');
  }
  await sleep(1000);
}

function diagnosticScreenshotFilename(name: string): string | null {
  switch (name) {
    case 'blocked-pre-login': return 'blocked-pre-login.png';
    case 'blocked-post-login': return 'blocked-post-login.png';
    case 'blocked-part-search': return 'blocked-part-search.png';
    case 'login-no-form': return 'login-no-form.png';
    case 'login-wrong-inputs': return 'login-wrong-inputs.png';
    case 'login-no-password': return 'login-no-password.png';
    case 'login-failed': return 'login-failed.png';
    case 'login-error': return 'login-error.png';
    case 'session-continuation-offered': return 'session-continuation-offered.png';
    case 'login-unclear': return 'login-unclear.png';
    case 'vin-not-found': return 'vin-not-found.png';
    case 'vin-result': return 'vin-result.png';
    case 'vin-no-catalog': return 'vin-no-catalog.png';
    case 'vin-error': return 'vin-error.png';
    case 'search-not-found': return 'search-not-found.png';
    case 'search-results': return 'search-results.png';
    case 'search-error': return 'search-error.png';
    default: return null;
  }
}

export async function takeScreenshot(page: Page, name: string): Promise<void> {
  if (process.env.PARTSLINK_SCREENSHOTS !== 'true') return;
  const filename = diagnosticScreenshotFilename(name);
  if (!filename) {
    logger.warn('Rejected unsafe diagnostic screenshot name');
    return;
  }
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(STORAGE_DIR, 0o700);
    const filepath = path.join(STORAGE_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    fs.chmodSync(filepath, 0o600);
    logger.debug('Diagnostic screenshot captured', { name });
  } catch {
    logger.debug(`Failed to screenshot: ${name}`);
  }
}
