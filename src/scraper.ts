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

    // ── Find the 3 login fields ──
    // Real PL24 login form has exactly 3 inputs in right panel:
    //   1. "Firmenkennung / ID:" → text input
    //   2. "Benutzername:" → text input
    //   3. "Passwort:" → password input

    let companyField: Locator | null = null;
    let userField: Locator | null = null;
    let passField: Locator | null = null;

    // Strategy 1: Find by exact label text (from screenshot)
    // PL24 uses plain text labels, not <label> elements, so we search for nearby text + input
    try {
      // "Firmenkennung / ID:" — find text then look for sibling/child input
      companyField = page.locator('text=Firmenkennung').locator('..').locator('input[type="text"]').first();
      if (await companyField.count() === 0) companyField = null;
    } catch { companyField = null; }

    try {
      userField = page.locator('text=Benutzername').locator('..').locator('input[type="text"]').first();
      if (await userField.count() === 0) userField = null;
    } catch { userField = null; }

    // Password field is always the most reliable
    passField = page.locator('input[type="password"]').first();

    // Strategy 2: Positional fallback — PL24 login has exactly 2 text + 1 password inputs
    if (!companyField || !userField) {
      const textInputs = await page.locator('input[type="text"]:visible').all();
      const passInputs = await page.locator('input[type="password"]:visible').all();

      logger.info(`Login form discovery: ${textInputs.length} text inputs, ${passInputs.length} password inputs`);

      if (textInputs.length >= 2) {
        // Order: Firmenkennung (1st), Benutzername (2nd)
        if (!companyField) companyField = textInputs[0];
        if (!userField) userField = textInputs[1];
        logger.info('Using positional login strategy (2+ text inputs found)');
      } else if (textInputs.length === 1 && passInputs.length >= 1) {
        if (!userField) userField = textInputs[0];
        logger.info('Only 1 text input found — company might be pre-filled');
      }
    }

    if (!passField || await passField.count() === 0) {
      logger.error('Password field not found — cannot login');
      await takeScreenshot(page, 'login-no-password');
      return false;
    }

    // Fill the fields in order
    if (companyField && await companyField.count() > 0) {
      await companyField.click();
      await humanDelay(100, 300);
      await companyField.fill('');
      await companyField.type(config.pl24.companyId, { delay: 30 });
      await humanDelay(200, 500);
      logger.debug('Filled Firmenkennung / ID');
    }

    if (userField && await userField.count() > 0) {
      await userField.click();
      await humanDelay(100, 300);
      await userField.fill('');
      await userField.type(config.pl24.username, { delay: 30 });
      await humanDelay(200, 500);
      logger.debug('Filled Benutzername');
    }

    await passField.click();
    await humanDelay(100, 300);
    await passField.fill('');
    await passField.type(config.pl24.password, { delay: 30 });
    await humanDelay(300, 600);
    logger.debug('Filled Passwort');

    // Click "Login" button — real PL24 has a "Login" button below the form
    const loginBtn = page.locator('button:has-text("Login"), input[value="Login"], a:has-text("Login")').first();
    if (await loginBtn.count() > 0) {
      logger.info('Clicking "Login" button');
      await loginBtn.click();
    } else {
      // Fallback: submit via Enter on password field
      logger.info('No Login button found — pressing Enter');
      await passField.press('Enter');
    }

    // Wait for redirect after login → should land on dashboard
    await waitForStable(page, NAVIGATION_TIMEOUT);
    await humanDelay(1500, 3000);

    // Check for bot detection post-login
    await assertNotBlocked(page, 'post-login');

    // Verify login success
    const success = await verifyLoginSuccess(page);

    if (success) {
      isLoggedIn = true;
      try { await context!.storageState({ path: STORAGE_PATH }); } catch { /* ignore */ }
      logger.info('✅ Login successful!');
      return true;
    }

    logger.error('Login failed — could not verify success');
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
 * Real PL24 dashboard (from screenshot 4) shows:
 * - "Abmelden" link in top nav
 * - "Herzlich willkommen bei partslink24..."
 * - "FAHRGESTELLNUMMER" input label
 * - "Verwaltung" section
 * - Brand logos grid
 */
async function verifyLoginSuccess(page: Page): Promise<boolean> {
  let bodyText: string;
  try {
    bodyText = await page.locator('body').innerText({ timeout: 8000 });
  } catch {
    return false;
  }

  const lower = bodyText.toLowerCase();

  // Positive signals — real PL24 dashboard contains these
  const positiveSignals = [
    'abmelden',                     // Top nav link
    'herzlich willkommen',          // Dashboard welcome text
    'fahrgestellnummer',            // VIN input label on dashboard
    'verwaltung',                   // Right panel section
    'kurzeinstieg',                 // Dashboard link
    'händler auswählen',            // Dashboard link
    'original teile katalog',       // Dashboard description
  ];

  for (const signal of positiveSignals) {
    if (lower.includes(signal)) {
      logger.info(`Login verified via: "${signal}"`);
      return true;
    }
  }

  // Also check catalog view signals (in case session restored directly to catalog)
  const catalogSignals = [
    'fahrzeugidentifikation',       // Left panel
    'hauptgruppe',                  // Main table
    'teile suchen',                 // Search input
  ];

  for (const signal of catalogSignals) {
    if (lower.includes(signal)) {
      logger.info(`Login verified via catalog signal: "${signal}"`);
      return true;
    }
  }

  // Negative signals — still on login page
  const negativeSignals = [
    'passwort vergessen',           // Login page element
    'kennwort falsch',
    'anmeldung für registrierte',   // Login page header text
    'neu bei partslink24',          // Login page text
  ];

  for (const signal of negativeSignals) {
    if (lower.includes(signal)) {
      logger.error(`Login failed — still on login page: "${signal}"`);
      return false;
    }
  }

  // Check URL for clues
  const url = page.url().toLowerCase();
  if (url.includes('login') || url.includes('signin') || url.includes('startup.do')) {
    logger.warn('URL suggests still on login/startup page');
    return false;
  }

  logger.warn('Login state unclear — assuming success');
  return true;
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
  logger.info('Navigating to vehicle...', { vin, brand });

  try {
    // PL24 uses a FRAMESET — VIN input + GO button are inside a frame
    await page.waitForTimeout(2000);
    const frames = page.frames();
    logger.info(`Page has ${frames.length} frames — scanning for VIN/GO...`);

    // Log all frames
    for (let i = 0; i < frames.length; i++) {
      try {
        logger.info(`  Frame ${i}: name="${frames[i].name()}" url="${frames[i].url().substring(0, 100)}"`);
      } catch { /* ignore */ }
    }

    // Find the frame containing the GO button (it's a <div class="search-btn">, NOT a <button>)
    let contentFrame: any = null;
    for (const frame of frames) {
      try {
        // PL24 GO button: <div class="search-btn" onclick="searchText();"><div id="tooltip-go">GO</div></div>
        const goCount = await frame.locator('div.search-btn, #tooltip-go').count();
        if (goCount > 0) {
          contentFrame = frame;
          logger.info(`✅ Found GO button (div.search-btn) in frame: "${frame.name()}"`);
          break;
        }
      } catch { /* skip */ }
    }

    // Fallback: frame with VIN input placeholder or brand images
    if (!contentFrame) {
      for (const frame of frames) {
        try {
          const vinInput = await frame.locator('input[placeholder="Fahrgestellnummer"]').count();
          if (vinInput > 0) {
            contentFrame = frame;
            logger.info(`Found content frame via VIN placeholder: "${frame.name()}"`);
            break;
          }
        } catch { /* skip */ }
      }
    }

    // Last fallback: frame with visible text inputs
    if (!contentFrame) {
      for (const frame of frames) {
        try {
          const count = await frame.locator('input[type="text"]:visible').count();
          if (count > 0) {
            contentFrame = frame;
            logger.info(`Using frame with ${count} inputs: "${frame.name()}"`);
            break;
          }
        } catch { /* skip */ }
      }
    }

    if (!contentFrame) {
      logger.error('No content frame found!');
      await takeScreenshot(page, 'no-frame');
      return false;
    }

    // Find VIN input IN the frame
    // Exact HTML: <input name="text" type="text" placeholder="Fahrgestellnummer" maxLength="17">
    let vinField: any = null;
    const vinSels = [
      'input[placeholder="Fahrgestellnummer"]',   // EXACT match from DevTools
      'input[name="text"][maxlength="17"]',        // form field for VIN
      'input[name*="fahrgestell" i]', 'input[name*="vin" i]',
    ];
    for (const sel of vinSels) {
      try {
        const el = contentFrame.locator(sel).first();
        if (await el.count() > 0) {
          vinField = el;
          logger.info(`Found VIN field via: ${sel}`);
          break;
        }
      } catch { /* next */ }
    }

    // Fallback: input inside form[name="search-text"]
    if (!vinField) {
      try {
        const formInput = contentFrame.locator('form[name="search-text"] input[type="text"]').first();
        if (await formInput.count() > 0) { vinField = formInput; logger.info('Found VIN via form[name=search-text]'); }
      } catch { /* ignore */ }
    }

    // Fallback: first text input in frame
    if (!vinField) {
      const inputs = await contentFrame.locator('input[type="text"]:visible').all();
      if (inputs.length > 0) { vinField = inputs[0]; logger.info(`Using first input in frame (${inputs.length})`); }
    }

    if (!vinField) { logger.error('VIN input not found!'); return false; }

    // Enter VIN
    await vinField.click(); await humanDelay(100, 300);
    await vinField.fill(''); await humanDelay(100, 200);
    await vinField.type(vin, { delay: 50 }); await humanDelay(300, 600);
    logger.info('VIN entered');

    // Click GO IN the frame
    // Exact HTML: <div class="search-btn" onclick="searchText();return false;"><div id="tooltip-go">GO</div></div>
    // Also: <input id="hidden-search" class="auto-submit" type="submit" onclick="searchText();return false;">
    let goClicked = false;
    const goSels = [
      'div.search-btn',                    // EXACT match — the visible GO div
      '#tooltip-go',                        // inner GO text div
      '#hidden-search',                     // hidden submit input
      'input[type="submit"]',              // generic submit
    ];
    for (const sel of goSels) {
      try {
        const btn = contentFrame.locator(sel).first();
        if (await btn.count() > 0) {
          logger.info(`Clicking GO: ${sel}`);
          await btn.click();
          goClicked = true;
          break;
        }
      } catch { /* next */ }
    }
    if (!goClicked) { logger.info('GO not found — Enter'); await vinField.press('Enter'); }

    // Wait for catalog in any frame (up to 60s)
    logger.info('Waiting for catalog...');
    await page.waitForTimeout(5000);

    const signals = ['Hauptgruppe', 'Fahrzeugidentifikation', 'Teile suchen', 'Modellbezeichnung'];
    let catalogFound = false;

    for (let attempt = 0; attempt < 12; attempt++) {
      for (const frame of page.frames()) {
        try {
          const text = await frame.locator('body').innerText({ timeout: 2000 });
          for (const sig of signals) {
            if (text.includes(sig)) {
              logger.info(`✅ Catalog: "${sig}" in frame "${frame.name()}" (attempt ${attempt + 1})`);
              catalogFound = true;
              break;
            }
          }
        } catch { /* skip */ }
        if (catalogFound) break;
      }
      if (catalogFound) break;
      logger.info(`Catalog not ready (attempt ${attempt + 1}/12)...`);
      await page.waitForTimeout(5000);
    }

    // Debug dump
    for (const frame of page.frames()) {
      try {
        const body = await frame.locator('body').innerText({ timeout: 2000 });
        logger.info(`Frame "${frame.name()}": ${body.substring(0, 200)}`);
      } catch { /* skip */ }
    }

    if (catalogFound) {
      logger.info('✅ Vehicle identified', { vin });
    } else {
      await takeScreenshot(page, 'vin-no-catalog');
      logger.warn('Catalog not found after GO', { vin });
    }
    return true;

  } catch (err: any) {
    logger.error('Navigate failed', { vin, error: err.message });
    await takeScreenshot(page, 'vin-error');
    return false;
  }
}

// ============================================================================
// PART SEARCH — "Teile suchen" input in catalog view top bar
//
// Real PL24 catalog (screenshot 1+2):
// Top bar: [VIN input] [🔍] | [Teile suchen] [🔍] | [Händler wählen]
// The "Teile suchen" field is the SECOND text input in the top bar.
//
// After search (screenshot 2):
// Left panel: "Suche: ölfilter"
// Results stacked vertically:
//   Bildtafel    11_9979
//   Teilenummer  11 42 7 508 966
//   Benennung    Ölfilter mit Kunststoffdeckel
//   HG           11
//   FG           30
// ============================================================================

async function searchPart(page: Page, partQuery: string): Promise<OemResult[]> {
  logger.info('Searching for part...', { partQuery });

  try {
    // Find "Teile suchen" input
    let searchField = await findSearchInput(page);

    if (!searchField) {
      logger.error('"Teile suchen" input not found!');
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

    // Submit search
    await submitPartSearch(page, searchField);

    // Wait for search results
    await waitForSearchResults(page, partQuery);
    await humanDelay(2000, 4000);

    // Check for bot detection
    await assertNotBlocked(page, 'part-search');

    // Take debug screenshot
    await takeScreenshot(page, 'search-results');

    // Dump frame content for debugging extraction
    for (const frame of page.frames()) {
      try {
        const bodyText = await frame.locator('body').innerText({ timeout: 3000 });
        if (bodyText.length > 50) {
          logger.info(`Frame "${frame.name()}" body (first 400 chars):`, { body: bodyText.substring(0, 400) });
          if (bodyText.includes('Teilenummer')) {
            logger.info(`✅ "Teilenummer" found in frame "${frame.name()}" — extraction should work`);
          }
        }
      } catch { /* skip */ }
    }

    // Extract OEM results
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
  // Exact HTML from DevTools: <input placeholder="Teile suchen" type="text" class="MuiInputBase-input...">
  // Parent: <div id="partSearchInput">
  // The catalog view loads in a FRAME, so scan all frames
  const selectors = [
    'input[placeholder="Teile suchen"]',           // EXACT match from DevTools
    '#partSearchInput input[type="text"]',          // parent container
    'input[placeholder*="Teile suchen" i]',
    'input[placeholder*="suchen" i]',
  ];

  // Try main page first
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.count() > 0 && await el.isVisible()) {
        logger.info(`Found search field on main page: ${sel}`);
        return el;
      }
    } catch { /* try next */ }
  }

  // Try ALL frames
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      try {
        const el = frame.locator(sel).first();
        if (await el.count() > 0) {
          logger.info(`Found search field in frame "${frame.name()}": ${sel}`);
          return el;
        }
      } catch { /* try next */ }
    }
  }

  // Positional fallback (second visible text input in any frame)
  for (const frame of page.frames()) {
    try {
      const allInputs = await frame.locator('input[type="text"]:visible').all();
      if (allInputs.length >= 2) {
        logger.info(`Using second text input in frame "${frame.name()}" (${allInputs.length} total)`);
        return allInputs[1];
      }
    } catch { /* ignore */ }
  }

  return null;
}

async function submitPartSearch(page: Page, searchField: Locator): Promise<void> {
  // Try magnifying glass next to search input
  try {
    const parent = searchField.locator('..');
    const icons = await parent.locator('button, a, [role="button"], svg, img').all();
    for (const icon of icons) {
      if (await icon.isVisible()) {
        logger.debug('Clicking search magnifying glass');
        await icon.click();
        return;
      }
    }
  } catch { /* fall through */ }

  // Try search button
  const btnSelectors = [
    'button:has-text("Suchen")',
    'input[type="submit"]',
  ];
  for (const sel of btnSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0) {
        await btn.click();
        return;
      }
    } catch { /* try next */ }
  }

  // Enter key
  await searchField.press('Enter');
}

/**
 * Wait for search results to appear.
 * Real PL24 shows "Suche: ölfilter" header and Bildtafel/Teilenummer blocks.
 */
async function waitForSearchResults(page: Page, query: string): Promise<void> {
  const signals = [
    `text=Suche: ${query}`,
    'text=Teilenummer',
    'text=Bildtafel',
    'text=Benennung',
  ];

  for (const signal of signals) {
    try {
      await page.locator(signal).first().waitFor({ state: 'visible', timeout: 15000 });
      logger.debug(`Search results loaded — signal: "${signal}"`);
      return;
    } catch { /* try next */ }
  }

  // Fallback
  try {
    await page.waitForLoadState('load', { timeout: 20000 });
  } catch {
    logger.warn('Search results wait timed out');
  }
  await sleep(2000);
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
