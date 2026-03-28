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
import { logger } from './logger';
import { OemResult } from './cache';
import { enqueue } from './requestQueue';

// ── Constants ────────────────────────────────────────────────────────────────

const STORAGE_DIR = path.join(__dirname, '..', 'playwright-data');
const STORAGE_PATH = path.join(STORAGE_DIR, 'state.json');
const MAX_RETRIES = 2;
const NAVIGATION_TIMEOUT = 30_000;

// ── State ────────────────────────────────────────────────────────────────────

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let isLoggedIn = false;
let lastRequestTime = 0;
let lastSuccessfulLookup: string | null = null;

// ── Lifecycle ────────────────────────────────────────────────────────────────

export async function initBrowser(): Promise<void> {
  if (browser) return;

  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }

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

export async function closeBrowser(): Promise<void> {
  if (context) {
    try { await context.storageState({ path: STORAGE_PATH }); } catch { /* ignore */ }
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

async function assertNotBlocked(page: Page, ctx: string): Promise<void> {
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

  logger.info('Logging in to PartsLink24...', { companyId: config.pl24.companyId, user: config.pl24.username });

  try {
    // Navigate to PL24 — does JS redirect from index → startup.do → login page
    await page.goto(config.pl24.baseUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });

    // Wait for the redirect chain to settle
    await waitForStable(page);
    await humanDelay(1000, 2000);

    // ── Dismiss Usercentrics cookie consent overlay ──
    // This MUST happen before any clicks, because it intercepts all pointer events
    try {
      // Try shadow DOM button first (Usercentrics v2 uses shadow DOM)
      const ucRoot = page.locator('#usercentrics-root');
      if (await ucRoot.count() > 0) {
        logger.info('Cookie consent overlay detected — dismissing...');
        
        // Method 1: Try clicking common accept buttons
        const acceptSelectors = [
          'button[data-testid="uc-accept-all-button"]',
          'button:has-text("Alle akzeptieren")',
          'button:has-text("Accept All")',
          'button:has-text("Akzeptieren")',
          'button:has-text("Zustimmen")',
          '#uc-btn-accept-banner',
        ];
        
        let dismissed = false;
        for (const sel of acceptSelectors) {
          try {
            const btn = page.locator(sel).first();
            if (await btn.count() > 0 && await btn.isVisible({ timeout: 2000 })) {
              await btn.click({ timeout: 3000 });
              logger.info(`Cookie consent dismissed via: ${sel}`);
              dismissed = true;
              break;
            }
          } catch { /* try next selector */ }
        }
        
        // Method 2: Force-remove the overlay via JS
        if (!dismissed) {
          await page.evaluate(`
            (() => {
              const uc = document.getElementById('usercentrics-root');
              if (uc) uc.remove();
              document.querySelectorAll('[class*="overlay"], [class*="consent"], [class*="cookie"]').forEach(el => {
                if (el.style && el.style.position === 'fixed') el.remove();
              });
            })()
          `);
          logger.info('Cookie consent force-removed via JS');
        }
        
        await humanDelay(500, 1000);
      }
    } catch (err: any) {
      logger.warn('Cookie consent dismissal failed — continuing anyway', { error: err.message });
    }

    // Check for bot detection before login
    await assertNotBlocked(page, 'pre-login');

    // ── Find and fill the 3 login fields ──
    // Real PL24 login form (verified March 2026):
    //   Right panel with exactly 3 inputs:
    //     1. "Firmenkennung / ID:" → text input
    //     2. "Benutzername:"       → text input
    //     3. "Passwort:"           → password input
    //
    // STRATEGY: Use positional approach — most reliable across environments.
    // Find all visible text inputs + the password field, fill by position.

    // Wait for form to be ready
    const passField = page.locator('input[type="password"]:visible').first();
    try {
      await passField.waitFor({ state: 'visible', timeout: 10000 });
    } catch {
      logger.error('Password field not visible within 10s — login form not loaded');
      await takeScreenshot(page, 'login-no-form');
      return false;
    }

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

    // Fill Firmenkennung / ID (1st text input)
    const companyField = textInputs[0];
    await companyField.click();
    await humanDelay(100, 200);
    await companyField.fill(config.pl24.companyId);
    await humanDelay(200, 400);
    logger.info(`Filled Firmenkennung: "${config.pl24.companyId}"`);

    // Fill Benutzername (2nd text input)
    const userField = textInputs[1];
    await userField.click();
    await humanDelay(100, 200);
    await userField.fill(config.pl24.username);
    await humanDelay(200, 400);
    logger.info(`Filled Benutzername: "${config.pl24.username}"`);

    // Fill Passwort (password input)
    await passField.click();
    await humanDelay(100, 200);
    await passField.fill(config.pl24.password);
    await humanDelay(200, 400);
    logger.info('Filled Passwort: ****');

    // Debug: take screenshot BEFORE clicking login to verify fields are filled
    await takeScreenshot(page, 'login-before-submit');

    // Verify field values via JS (debug)
    try {
      const fieldValues: any = await page.evaluate(`
        (() => {
          const texts = Array.from(document.querySelectorAll('input[type="text"]'))
            .filter(i => i.offsetParent !== null)
            .map(i => i.value);
          const pass = document.querySelector('input[type="password"]')?.value?.length || 0;
          return { textValues: texts, passLength: pass };
        })()
      `);
      logger.info(`Field verification — text values: ${JSON.stringify(fieldValues.textValues)}, password length: ${fieldValues.passLength}`);
    } catch { /* ignore */ }

    // Click "Login" button
    let loginClicked = false;
    const loginSelectors = [
      'input[value="Login"]',                      // input submit button
      'input[type="submit"][value="Login"]',
      'button:has-text("Login")',                   // button element
      'a:has-text("Login")',                        // link styled as button
      'input[type="submit"]',                       // generic submit
    ];

    for (const sel of loginSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.count() > 0 && await btn.isVisible({ timeout: 2000 })) {
          logger.info(`Clicking Login via: ${sel}`);
          await btn.click();
          loginClicked = true;
          break;
        }
      } catch { /* try next */ }
    }

    if (!loginClicked) {
      // Fallback: submit via Enter on password field
      logger.info('No Login button found — pressing Enter');
      await passField.press('Enter');
    }

     // Wait for redirect after login → should land on dashboard
    // PL24 may keep the same URL (login.do) but load dashboard content.
    // Wait for reliable dashboard indicator: "Abmelden" link in nav.
    logger.info('Waiting for dashboard to load...');
    let dashboardLoaded = false;

    try {
      // Wait for "Abmelden" to appear — it ONLY exists on the dashboard, never on the login page
      await page.locator('text=Abmelden').first().waitFor({ state: 'visible', timeout: 15000 });
      dashboardLoaded = true;
      logger.info('Dashboard detected — "Abmelden" visible');
    } catch {
      logger.warn('"Abmelden" not found within 15s — checking other signals');
    }

    // Fallback: check for "Herzlich willkommen" (also unique to dashboard)
    if (!dashboardLoaded) {
      try {
        await page.locator('text=Herzlich willkommen').first().waitFor({ state: 'visible', timeout: 5000 });
        dashboardLoaded = true;
        logger.info('Dashboard detected — "Herzlich willkommen" visible');
      } catch {
        logger.warn('"Herzlich willkommen" not found');
      }
    }

    // Check for bot detection post-login
    await assertNotBlocked(page, 'post-login');

    if (!dashboardLoaded) {
      // Final verification attempt
      dashboardLoaded = await verifyLoginSuccess(page);
    }

    if (dashboardLoaded) {
      isLoggedIn = true;
      try { await context!.storageState({ path: STORAGE_PATH }); } catch { /* ignore */ }
      logger.info('✅ Login successful!');
      return true;
    }

    logger.error('Login failed — dashboard did not load');
    await takeScreenshot(page, 'login-failed');
    return false;

  } catch (err: any) {
    logger.error('Login failed with error', { error: err.message });
    await takeScreenshot(page, 'login-error');
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

  logger.warn('Login state unclear — no positive or negative signals matched');
  await takeScreenshot(page, 'login-unclear');
  return false;
}

async function ensureLoggedIn(page: Page): Promise<boolean> {
  if (isLoggedIn) {
    try {
      await page.goto(config.pl24.baseUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT });
      await waitForStable(page);
      if (await verifyLoginSuccess(page)) return true;
      logger.info('Session expired — re-logging in');
    } catch {
      logger.info('Session check failed — re-logging in');
    }
    isLoggedIn = false;
  }
  return await login(page);
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

async function selectBrand(page: Page, brand: string): Promise<boolean> {
  const upper = brand.toUpperCase();
  const names = BRAND_MAP[upper] || [brand];

  for (const name of names) {
    // Try img alt match first (brand logos are <img> elements)
    const imgSelectors = [
      `img[alt*="${name}" i]`,
      `a[title*="${name}" i]`,
      `img[title*="${name}" i]`,
    ];

    for (const sel of imgSelectors) {
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

  // Fallback: click any link containing brand text
  try {
    const textLink = page.locator(`a:has(img[alt*="${brand}" i])`).first();
    if (await textLink.count() > 0) {
      await textLink.click();
      await waitForStable(page);
      await humanDelay(500, 1000);
      return true;
    }
  } catch { /* ignore */ }

  logger.warn(`Brand "${brand}" not found in dashboard grid`);
  return false;
}

// ============================================================================
// VIN LOOKUP
//
// DASHBOARD (screenshot 4): "FAHRGESTELLNUMMER" label + text input + "GO" button
// CATALOG VIEW (screenshot 1): VIN already in top-left input, re-entry possible
// ============================================================================

async function navigateToVehicle(page: Page, vin: string, brand?: string): Promise<boolean> {
  logger.info('Navigating to vehicle...', { vin });

  try {
    // ── PL24 Dashboard: VIN input is on the MAIN PAGE (not in frames) ──
    // After login, the dashboard shows a text input with placeholder "Fahrgestellnummer"
    // next to a "GO" button. This is NOT inside an iframe — it's in the main DOM.
    await page.waitForTimeout(2000);

    // Log current URL for debugging
    logger.info(`Current URL: ${page.url()}`);

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

    // ── Step 4: Wait for SPA navigation to catalog ──
    // After clicking GO, PL24 navigates to a React SPA:
    //   https://www.partslink24.com/pl24-app/{brand}_parts/{VIN}/0/vehicle
    // The URL contains "/pl24-app/" — this is the key signal.
    logger.info('Waiting for catalog SPA to load...');

    let catalogFound = false;

    // Strategy 1: Wait for URL to change to /pl24-app/ (most reliable)
    try {
      await page.waitForURL(/\/pl24-app\//, { timeout: 30000 });
      logger.info(`✅ SPA URL detected: ${page.url()}`);
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
      logger.info('✅ Vehicle identified — catalog loaded', { vin, url: page.url() });
    } else {
      await takeScreenshot(page, 'vin-no-catalog');
      logger.warn('Catalog not found after GO — page may still be on dashboard', { vin, url: page.url() });

      // Debug: dump page content
      try {
        const bodyText = await page.locator('body').innerText({ timeout: 5000 });
        logger.info(`Page body (first 500 chars): ${bodyText.substring(0, 500)}`);
      } catch { /* ignore */ }
    }

    return catalogFound;

  } catch (err: any) {
    logger.error('Navigate to vehicle failed', { vin, error: err.message });
    await takeScreenshot(page, 'vin-error');
    return false;
  }
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

async function searchPart(page: Page, partQuery: string): Promise<OemResult[]> {
  logger.info('Searching for part...', { partQuery });

  try {
    // ── Find "Teile suchen" input on the SPA page ──
    let searchField = await findSearchInput(page);

    if (!searchField) {
      logger.error('"Teile suchen" input not found in catalog SPA!');
      logger.info(`Current URL: ${page.url()}`);
      await takeScreenshot(page, 'search-not-found');
      return [];
    }

    // Click, clear, and type search query
    await searchField.click();
    await humanDelay(200, 400);
    await searchField.fill('');
    await humanDelay(100, 200);
    await searchField.type(partQuery, { delay: 40 });
    await humanDelay(300, 600);
    logger.info('Search query entered', { partQuery });

    // Submit search (Enter key — most reliable in the SPA)
    await searchField.press('Enter');
    logger.info('Search submitted');

    // Wait for search results to appear
    await waitForSearchResults(page, partQuery);
    await humanDelay(1500, 3000);

    // Check for bot detection
    await assertNotBlocked(page, 'part-search');

    // Take debug screenshot
    await takeScreenshot(page, 'search-results');

    // Log current URL (should contain ?q=...)
    logger.info(`Search URL: ${page.url()}`);

    // Extract OEM results from the SPA page
    const results = await extractOemResults(page);
    logger.info(`Found ${results.length} OEM results for "${partQuery}"`, {
      results: results.slice(0, 5).map(r => `${r.oem} (${r.description})`),
    });

    return results;

  } catch (err: any) {
    logger.error('Part search failed', { partQuery, error: err.message });
    await takeScreenshot(page, 'search-error');
    return [];
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
async function waitForSearchResults(page: Page, query: string): Promise<void> {
  // Strategy 1: Wait for URL to contain search query parameter
  try {
    await page.waitForURL(/[?&]q=/, { timeout: 15000 });
    logger.info('URL contains search query parameter');
  } catch {
    logger.debug('URL did not update with search query');
  }

  // Strategy 2: Wait for result signals in the DOM
  const signals = [
    'text=Teilenummer',                              // Result field label
    'text=Bildtafel',                                // Result field label
    'text=Benennung',                                // Result field label
    `text=Suche:`,                                   // Search header
    'text=Es wurden keine Einträge',                 // No results message
  ];

  for (const signal of signals) {
    try {
      await page.locator(signal).first().waitFor({ state: 'visible', timeout: 10000 });
      logger.info(`Search results loaded — signal: "${signal}"`);
      return;
    } catch { /* try next */ }
  }

  // Fallback: just wait
  logger.warn('No search result signals detected — waiting 5s');
  await sleep(5000);
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

  } catch (err: any) {
    logger.error('Result extraction failed', { error: err.message });
    return [];
  }
}

function extractFromText(text: string): OemResult[] {
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
  const oemMatch = block.match(/Teilenummer\s+([A-Z0-9][\sA-Z0-9\-.]{4,25})/i);
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
    /Teilenummer\s+([A-Z0-9][\sA-Z0-9\-.]{6,18})/gi,        // Label-based
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

/**
 * Full OEM lookup pipeline — queued for serialized processing.
 */
export async function lookupOem(req: LookupRequest): Promise<LookupResponse> {
  const label = `VIN=${req.vin} Part="${req.partQuery}" Brand=${req.brand || 'auto'}`;
  return enqueue(() => lookupOemInternal(req), label);
}

async function lookupOemInternal(req: LookupRequest): Promise<LookupResponse> {
  const start = Date.now();
  const { vin, partQuery, brand } = req;

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
      if (!loggedIn) throw new Error('Login failed');

      // Step 2: Navigate to vehicle (brand + VIN)
      const vehicleFound = await navigateToVehicle(page, vin, brand);
      if (!vehicleFound) throw new Error('Vehicle identification failed');

      // Step 3: Search for part
      const results = await searchPart(page, partQuery);

      lastRequestTime = Date.now();
      lastSuccessfulLookup = new Date().toISOString();

      const screenshots: string[] = [];
      for (const f of ['search-results.png', 'vin-result.png']) {
        const p = path.join(STORAGE_DIR, f);
        if (fs.existsSync(p)) screenshots.push(p);
      }

      return {
        success: results.length > 0,
        vin, partQuery, results,
        fromCache: false,
        elapsedMs: Date.now() - start,
        screenshots,
      };

    } catch (err: any) {
      retries++;
      logger.warn(`Lookup attempt ${retries}/${MAX_RETRIES + 1} failed`, {
        vin, partQuery, error: err.message,
      });

      if (retries > MAX_RETRIES) {
        return {
          success: false, vin, partQuery, results: [],
          fromCache: false, elapsedMs: Date.now() - start,
          error: `All ${MAX_RETRIES + 1} attempts failed: ${err.message}`,
        };
      }

      isLoggedIn = false;
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return sleep(ms);
}

async function waitForStable(page: Page, timeout: number = NAVIGATION_TIMEOUT): Promise<void> {
  try {
    await page.waitForLoadState('load', { timeout });
  } catch {
    logger.debug('waitForStable: load timed out');
  }
  await sleep(1000);
}

async function takeScreenshot(page: Page, name: string): Promise<void> {
  try {
    const filepath = path.join(STORAGE_DIR, `${name}.png`);
    await page.screenshot({ path: filepath, fullPage: false });
    logger.debug(`Screenshot: ${filepath}`);
  } catch {
    logger.debug(`Failed to screenshot: ${name}`);
  }
}
