/**
 * 💾 CACHE — SQLite-based OEM lookup cache
 *
 * Stores previously looked-up results so we never
 * hit PartsLink24 twice for the same query.
 *
 * Features:
 * - WAL mode for concurrent read performance
 * - TTL-based expiry with cleanup
 * - Only successful lookups are cached (no error caching)
 */

import Database from 'better-sqlite3';
import path from 'path';
import { logger } from './logger';
import { config } from './config';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CachedResult {
  vin: string;
  partQuery: string;
  results: OemResult[];
  createdAt: string;
}

export interface OemResult {
  oem: string;
  description: string;
  bildtafel?: string;
  hg?: string;
  fg?: string;
}

// ── Database Setup ───────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, '..', 'cache.db');
let db: Database.Database;

export function initCache(): void {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS lookups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vin TEXT NOT NULL,
      part_query TEXT NOT NULL,
      results_json TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(vin, part_query)
    );

    CREATE INDEX IF NOT EXISTS idx_lookups_vin ON lookups(vin);
    CREATE INDEX IF NOT EXISTS idx_lookups_query ON lookups(vin, part_query);
    CREATE INDEX IF NOT EXISTS idx_lookups_created ON lookups(created_at);
  `);

  // Add result_count column if it doesn't exist (migration)
  try {
    db.exec('ALTER TABLE lookups ADD COLUMN result_count INTEGER NOT NULL DEFAULT 0');
  } catch { /* column already exists */ }

  const count = (db.prepare('SELECT COUNT(*) as c FROM lookups').get() as { c: number } | undefined)?.c || 0;
  logger.info(`Cache initialized — ${count} cached lookups`, { path: DB_PATH });

  // Run initial cleanup
  const cleaned = cleanupExpired();
  if (cleaned > 0) {
    logger.info(`Cleaned up ${cleaned} expired cache entries`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check cache for a previous lookup.
 * Returns null if not found or expired.
 */
export function getCached(vin: string, partQuery: string): CachedResult | null {
  const row = db.prepare(`
    SELECT vin, part_query, results_json, created_at
    FROM lookups
    WHERE vin = ? AND part_query = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(vin.toUpperCase(), partQuery.toLowerCase()) as { vin: string; part_query: string; results_json: string; created_at: string } | undefined;

  if (!row) return null;

  // Check TTL
  const age = (Date.now() - new Date(row.created_at + 'Z').getTime()) / 1000;
  if (age > config.cacheTtlSeconds) {
    logger.debug('Cache entry expired', { vin, partQuery, ageHours: Math.round(age / 3600) });
    return null;
  }

  try {
    const results = JSON.parse(row.results_json);
    // Don't return cache entries with no results (shouldn't happen, but safety check)
    if (!Array.isArray(results) || results.length === 0) return null;

    return {
      vin: row.vin,
      partQuery: row.part_query,
      results,
      createdAt: row.created_at,
    };
  } catch {
    logger.warn('Failed to parse cached results', { vin, partQuery });
    return null;
  }
}

/**
 * Store a lookup result in the cache.
 * Only stores successful lookups with actual results.
 */
export function setCache(vin: string, partQuery: string, results: OemResult[]): void {
  // Never cache empty results
  if (!results || results.length === 0) {
    logger.debug('Skipping cache — no results to store', { vin, partQuery });
    return;
  }

  db.prepare(`
    INSERT OR REPLACE INTO lookups (vin, part_query, results_json, result_count, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(vin.toUpperCase(), partQuery.toLowerCase(), JSON.stringify(results), results.length);

  logger.info('Cached lookup result', { vin, partQuery, resultCount: results.length });
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): {
  totalEntries: number;
  oldestEntry: string | null;
  newestEntry: string | null;
  totalResults: number;
} {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      MIN(created_at) as oldest,
      MAX(created_at) as newest,
      SUM(result_count) as totalResults
    FROM lookups
  `).get() as { total: number; oldest: string | null; newest: string | null; totalResults: number } | undefined;

  return {
    totalEntries: stats?.total || 0,
    oldestEntry: stats?.oldest || null,
    newestEntry: stats?.newest || null,
    totalResults: stats?.totalResults || 0,
  };
}

/**
 * Remove expired cache entries.
 * Returns the number of deleted entries.
 */
export function cleanupExpired(): number {
  const ttlSeconds = config.cacheTtlSeconds;
  const result = db.prepare(`
    DELETE FROM lookups
    WHERE datetime(created_at) < datetime('now', '-' || ? || ' seconds')
  `).run(ttlSeconds);

  return result.changes;
}
