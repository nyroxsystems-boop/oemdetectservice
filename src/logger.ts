import winston from 'winston';
import { createHash } from 'node:crypto';

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/g;
const SECRET_KEYS = /password|secret|token|cookie|authorization|api.?key|company.?id|username|^user$/i;

function vinFingerprint(vin: string): string {
  return createHash('sha256').update(vin).digest('hex').slice(0, 12);
}

export function safeUrlForLog(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `[${parsed.protocol.replace(':', '') || 'unknown'} URL]`;
    }
    if (
      parsed.hostname.toLowerCase() === 'www.partslink24.com'
      && parsed.pathname.startsWith('/pl24-app/')
    ) {
      const service = parsed.pathname.split('/').filter(Boolean)[1] || 'catalog';
      return `${parsed.origin}/pl24-app/${service}/[CATALOG_PATH]`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

function scrubString(value: string): string {
  return value
    .replace(
      /(https:\/\/www\.partslink24\.com\/pl24-app\/[^/\s"']+)\/[^\s"']+/gi,
      '$1/[CATALOG_PATH]',
    )
    .replace(VIN_RE, (vin) => `[VIN:${vinFingerprint(vin)}]`);
}

function scrub(value: unknown, key = ''): unknown {
  if (SECRET_KEYS.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((entry) => scrub(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, childValue]) => [childKey, scrub(childValue, childKey)]),
    );
  }
  return value;
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const safeMeta = scrub(meta) as Record<string, unknown>;
      const metaStr = Object.keys(safeMeta).length ? ` ${JSON.stringify(safeMeta)}` : '';
      return `${timestamp} [${level.toUpperCase().padEnd(5)}] ${scrubString(String(message))}${metaStr}`;
    }),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'scraper.log', maxsize: 5_000_000, maxFiles: 3 }),
  ],
});

export { logger };
