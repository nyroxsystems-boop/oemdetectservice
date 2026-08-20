import dotenv from 'dotenv';
dotenv.config();

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const parseOrigins = (value: string | undefined): string[] =>
  (value || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

export const config = {
  // PartsLink24 credentials
  pl24: {
    companyId: process.env.PL24_COMPANY_ID || '',   // Firmenkennung / ID (e.g. "de-388960")
    username: process.env.PL24_USERNAME || '',        // Benutzername
    password: process.env.PL24_PASSWORD || '',        // Passwort
    baseUrl: 'https://www.partslink24.com',
  },

  // Server
  port: parsePositiveInt(process.env.PORT, 4100),
  apiKey: process.env.CATALOG_API_KEY?.trim() || '',
  corsAllowedOrigins: parseOrigins(process.env.CORS_ALLOWED_ORIGINS),

  // Browser
  headless: process.env.HEADLESS !== 'false',

  // Rate limiting
  requestDelayMs: parsePositiveInt(process.env.REQUEST_DELAY_MS, 3000),

  // Cache
  cacheTtlSeconds: parsePositiveInt(process.env.CACHE_TTL_SECONDS, 2592000), // 30 days

  // Bulk scraper — export target (WhatsApp-Bot API)
  wwsBotUrl: process.env.WWS_BOT_URL?.trim() || '',
  adminToken: process.env.ADMIN_TOKEN || '',

  // Bulk scraper — crawl settings
  bulkDelayMs: parsePositiveInt(process.env.BULK_DELAY_MS, 2000), // delay between tree nodes
  bulkMaxConsecutiveErrors: parsePositiveInt(process.env.BULK_MAX_ERRORS, 3),
};

const PLACEHOLDERS = new Set([
  'admin',
  'changeme',
  'change_me',
  'replace_me',
  'your_password',
  'your_token',
]);

function isMissingOrPlaceholder(value: string | undefined, allowAdminUsername = false): boolean {
  const normalized = value?.trim().toLowerCase() || '';
  return !normalized
    || (PLACEHOLDERS.has(normalized) && !(allowAdminUsername && normalized === 'admin'))
    || normalized.startsWith('your_')
    || normalized.startsWith('replace_');
}

export function productionConfigErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== 'production') return [];

  const errors: string[] = [];
  const apiKey = env.CATALOG_API_KEY?.trim() || '';
  if (apiKey.length < 32 || isMissingOrPlaceholder(apiKey)) {
    errors.push('CATALOG_API_KEY must be a non-placeholder secret with at least 32 characters');
  }

  for (const name of ['PL24_COMPANY_ID', 'PL24_USERNAME', 'PL24_PASSWORD'] as const) {
    const allowAdminUsername = name === 'PL24_USERNAME';
    if (isMissingOrPlaceholder(env[name], allowAdminUsername)) {
      errors.push(`${name} must be configured`);
    }
  }

  if (env.OEM_DATABASE_REQUIRED !== 'true') {
    errors.push('OEM_DATABASE_REQUIRED must be true in production');
  }
  if (!env.OEM_DATABASE_URL?.trim()) {
    errors.push('OEM_DATABASE_URL must be configured in production');
  }

  if (env.WWS_BOT_URL) {
    try {
      const url = new URL(env.WWS_BOT_URL);
      if (url.protocol !== 'https:') errors.push('WWS_BOT_URL must use HTTPS in production');
    } catch {
      errors.push('WWS_BOT_URL must be a valid URL');
    }
    if ((env.ADMIN_TOKEN?.trim() || '').length < 32 || isMissingOrPlaceholder(env.ADMIN_TOKEN)) {
      errors.push('ADMIN_TOKEN must be a non-placeholder secret with at least 32 characters when WWS_BOT_URL is set');
    }
  }

  for (const origin of parseOrigins(env.CORS_ALLOWED_ORIGINS)) {
    try {
      if (new URL(origin).protocol !== 'https:') {
        errors.push(`CORS origin must use HTTPS in production: ${origin}`);
      }
    } catch {
      errors.push(`CORS origin is invalid: ${origin}`);
    }
  }

  return errors;
}

export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  const errors = productionConfigErrors(env);
  if (errors.length > 0) {
    throw new Error(`Invalid production configuration:\n- ${errors.join('\n- ')}`);
  }
}
