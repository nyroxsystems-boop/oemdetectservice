/**
 * 🗄️ OEM PostgreSQL Database
 *
 * Separate PostgreSQL instance dedicated to OEM data:
 * - oem_numbers: every OEM part number we've ever seen
 * - cross_references: OE ↔ aftermarket mappings
 * - vehicle_fitments: which parts fit which vehicles
 *
 * This replaces the local SQLite for persistent OEM storage.
 * The SQLite cache (cache.ts) stays for fast scraper lookups,
 * but every result also gets pushed here for long-term storage
 * and cross-service queries.
 *
 * Env var: OEM_DATABASE_URL (separate from the bot-service DB)
 */

import { Pool, PoolConfig } from 'pg';
import { logger } from './logger';
import { runOemMigrations } from './oemMigrations';

let pool: Pool | null = null;

export function getOemPool(): Pool | null {
    return pool;
}

const UNSAFE_CONNECTION_STRING_TLS_KEYS = new Set([
    'sslmode',
    'sslcert',
    'sslkey',
    'sslrootcert',
]);

function parseBoolean(value: string | undefined, name: string): boolean | undefined {
    if (value === undefined || value.trim() === '') return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    throw new Error(`${name} must be either "true" or "false"`);
}

function isPrivateDatabaseHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host === '::1' || host.endsWith('.internal') || host.endsWith('.local') || host.endsWith('.svc')) {
        return true;
    }

    // Single-label DNS names are service-discovery names on the private network
    // (for example `postgres` or `oem-db`).
    if (!host.includes('.') && !host.includes(':')) return true;

    const octets = host.split('.').map(part => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((part, index) => !/^\d+$/.test(host.split('.')[index]) || part < 0 || part > 255)) {
        return false;
    }

    return octets[0] === 10
        || octets[0] === 127
        || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168)
        || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function parseDatabaseUrl(rawUrl: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('OEM_DATABASE_URL must be a valid PostgreSQL URL');
    }

    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        throw new Error('OEM_DATABASE_URL must use the postgres:// or postgresql:// protocol');
    }
    if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
        throw new Error('OEM_DATABASE_URL must include a hostname and database name');
    }

    for (const key of parsed.searchParams.keys()) {
        if (UNSAFE_CONNECTION_STRING_TLS_KEYS.has(key.toLowerCase())) {
            throw new Error(`OEM_DATABASE_URL must not contain ${key}; configure TLS only with OEM_DATABASE_SSL_MODE and OEM_DATABASE_SSL_CA`);
        }
    }
    return parsed;
}

export function buildOemPoolConfig(rawUrl: string, env: NodeJS.ProcessEnv = process.env): PoolConfig {
    const parsedUrl = parseDatabaseUrl(rawUrl);
    const legacyRejectUnauthorized = parseBoolean(
        env.OEM_DATABASE_SSL_REJECT_UNAUTHORIZED,
        'OEM_DATABASE_SSL_REJECT_UNAUTHORIZED',
    );
    if (legacyRejectUnauthorized === false) {
        throw new Error('OEM_DATABASE_SSL_REJECT_UNAUTHORIZED=false is forbidden; use OEM_DATABASE_SSL_MODE=disable only for a private database host');
    }

    const sslMode = (env.OEM_DATABASE_SSL_MODE || 'verify-full').trim().toLowerCase();
    if (sslMode !== 'verify-full' && sslMode !== 'disable') {
        throw new Error('OEM_DATABASE_SSL_MODE must be either "verify-full" or "disable"');
    }
    if (sslMode === 'disable' && legacyRejectUnauthorized === true) {
        throw new Error('OEM_DATABASE_SSL_MODE=disable conflicts with OEM_DATABASE_SSL_REJECT_UNAUTHORIZED=true; remove the deprecated variable');
    }
    if (sslMode === 'disable' && !isPrivateDatabaseHost(parsedUrl.hostname)) {
        throw new Error('OEM_DATABASE_SSL_MODE=disable is allowed only for private/internal database hosts');
    }

    const ca = env.OEM_DATABASE_SSL_CA?.replace(/\\n/g, '\n').trim();
    if (sslMode === 'disable' && ca) {
        throw new Error('OEM_DATABASE_SSL_CA cannot be set when OEM_DATABASE_SSL_MODE=disable');
    }

    return {
        connectionString: rawUrl,
        ssl: sslMode === 'disable'
            ? false
            : {
                rejectUnauthorized: true,
                ...(ca ? { ca } : {}),
            },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    };
}

function redactDatabaseTarget(rawUrl: string): string {
    try {
        const parsed = new URL(rawUrl);
        const port = parsed.port ? `:${parsed.port}` : '';
        return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}`;
    } catch {
        return '[invalid OEM_DATABASE_URL]';
    }
}

export function allowDegradedOemDatabase(env: NodeJS.ProcessEnv): boolean {
    return ['development', 'test'].includes(env.NODE_ENV || '')
        && env.OEM_DATABASE_ALLOW_DEGRADED === 'true';
}

export async function initOemDb(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    const url = env.OEM_DATABASE_URL?.trim();
    const databaseRequired = parseBoolean(env.OEM_DATABASE_REQUIRED, 'OEM_DATABASE_REQUIRED') === true;
    if (!url) {
        if (databaseRequired) {
            throw new Error('OEM_DATABASE_URL is required when OEM_DATABASE_REQUIRED=true');
        }
        logger.warn('[OEM-DB] OEM_DATABASE_URL not set — OEM PostgreSQL disabled. Using SQLite only.');
        return false;
    }

    if (pool) return true;

    let candidatePool: Pool | null = null;
    try {
        const poolConfig = buildOemPoolConfig(url, env);
        candidatePool = new Pool(poolConfig);
        logger.info(`[OEM-DB] Connecting to ${redactDatabaseTarget(url)} (${poolConfig.ssl === false ? 'private plaintext transport' : 'verified TLS'})...`);

        // Test connection
        const client = await candidatePool.connect();
        try {
            await runOemMigrations(client);
            logger.info('[OEM-DB] ✅ PostgreSQL connected + migrations applied');
        } finally {
            client.release();
        }

        pool = candidatePool;
        candidatePool = null;
        return true;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[OEM-DB] ❌ Failed to connect: ${msg}`);
        logger.error(`[OEM-DB] Target: ${redactDatabaseTarget(url)}`);
        if (candidatePool) {
            try {
                await candidatePool.end();
            } catch (closeError: unknown) {
                logger.error('[OEM-DB] Failed to close unsuccessful connection pool', {
                    error: closeError instanceof Error ? closeError.message : String(closeError),
                });
            }
        }
        pool = null;
        if (!allowDegradedOemDatabase(env)) {
            throw new Error(`OEM PostgreSQL initialization failed: ${msg}`, { cause: err });
        }
        logger.warn('[OEM-DB] Explicit development fallback enabled by OEM_DATABASE_ALLOW_DEGRADED=true — continuing with SQLite only.');
        return false;
    }
}

// ── Insert Functions ─────────────────────────────────────────

/**
 * Store a scraped OEM number. Upserts: increments hit_count on conflict.
 */
export async function insertOemNumber(data: {
    oem_number: string;
    brand: string;
    part_category?: string;
    part_description?: string;
    source?: string;
    confidence?: number;
}): Promise<void> {
    if (!pool) return;
    const sources = data.source ? JSON.stringify([data.source]) : '[]';
    try {
        await pool.query(
            `INSERT INTO oem_numbers (oem_number, brand, part_category, part_description, sources, confidence)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6)
             ON CONFLICT (oem_number, brand, part_category)
             DO UPDATE SET
                part_description = COALESCE(NULLIF($4, ''), oem_numbers.part_description),
                sources = oem_numbers.sources || $5::jsonb,
                confidence = GREATEST(oem_numbers.confidence, $6),
                hit_count = oem_numbers.hit_count + 1,
                updated_at = NOW()`,
            [data.oem_number, data.brand, data.part_category || 'other', data.part_description || null, sources, data.confidence ?? 0.5]
        );
    } catch (err) {
        logger.warn('[OEM-DB] Insert oem_number failed:', err instanceof Error ? err.message : err);
    }
}

/**
 * Store a vehicle fitment for an OEM number.
 */
export async function insertFitment(data: {
    oem_number: string;
    make: string;
    model?: string;
    model_code?: string;
    year_from?: number;
    year_to?: number;
    engine?: string;
    source?: string;
}): Promise<void> {
    if (!pool) return;
    try {
        await pool.query(
            `INSERT INTO vehicle_fitments (oem_number, make, model, model_code, year_from, year_to, engine, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT DO NOTHING`,
            [data.oem_number, data.make, data.model || null, data.model_code || null, data.year_from || null, data.year_to || null, data.engine || null, data.source || null]
        );
    } catch (err) {
        logger.warn('[OEM-DB] Insert fitment failed:', err instanceof Error ? err.message : err);
    }
}

/**
 * Upsert a vehicle into the master table. Returns the vehicle ID.
 */
export async function upsertVehicle(data: {
    make: string;
    model: string;
    model_code?: string | null;
    variant?: string | null;
    body_type?: string | null;
    year_from?: number | null;
    year_to?: number | null;
    engine_code?: string | null;
    engine_description?: string | null;
    displacement_cc?: number | null;
    power_kw?: number | null;
    power_ps?: number | null;
    fuel_type?: string | null;
    transmission?: string | null;
    drive_type?: string | null;
    hsn?: string | null;
    tsn?: string | null;
    kba_number?: string | null;
    source?: string | null;
}): Promise<number | null> {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `INSERT INTO vehicles (make, model, model_code, variant, body_type, year_from, year_to,
                engine_code, engine_description, displacement_cc, power_kw, power_ps,
                fuel_type, transmission, drive_type, hsn, tsn, kba_number, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
             ON CONFLICT (make, model, year_from, engine_code, hsn, tsn)
             DO UPDATE SET
                model_code = COALESCE(EXCLUDED.model_code, vehicles.model_code),
                engine_description = COALESCE(EXCLUDED.engine_description, vehicles.engine_description),
                displacement_cc = COALESCE(EXCLUDED.displacement_cc, vehicles.displacement_cc),
                power_kw = COALESCE(EXCLUDED.power_kw, vehicles.power_kw),
                power_ps = COALESCE(EXCLUDED.power_ps, vehicles.power_ps),
                fuel_type = COALESCE(EXCLUDED.fuel_type, vehicles.fuel_type)
             RETURNING id`,
            [
                data.make, data.model, data.model_code || null, data.variant || null,
                data.body_type || null, data.year_from || null, data.year_to || null,
                data.engine_code || null, data.engine_description || null,
                data.displacement_cc || null, data.power_kw || null, data.power_ps || null,
                data.fuel_type || null, data.transmission || null, data.drive_type || null,
                data.hsn || null, data.tsn || null, data.kba_number || null, data.source || null,
            ]
        );
        return result.rows[0]?.id || null;
    } catch (err) {
        logger.warn('[OEM-DB] Upsert vehicle failed:', err instanceof Error ? err.message : err);
        return null;
    }
}

/**
 * Bulk insert scraped OEM results from a bulk crawl job.
 * Uses multi-row INSERT for speed (1 query instead of N).
 */
export async function bulkInsertResults(results: Array<{
    oem: string;
    description?: string | null;
    brand: string;
    model?: string | null;
    model_code?: string | null;
    hg_name?: string | null;
    year_from?: number | null;
    year_to?: number | null;
    engine?: string | null;
    [key: string]: unknown;
}>): Promise<number> {
    if (!pool || results.length === 0) return 0;

    let inserted = 0;

    // Batch oem_numbers: multi-row INSERT with UNNEST
    try {
        const oems = results.map(r => r.oem);
        const brands = results.map(r => r.brand);
        const categories = results.map(r => r.hg_name || 'other');
        const descriptions = results.map(r => r.description || null);

        const res = await pool.query(
            `INSERT INTO oem_numbers (oem_number, brand, part_category, part_description, sources, confidence)
             SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[],
                ARRAY_FILL('["PartsLink24"]'::jsonb, ARRAY[$5::int]),
                ARRAY_FILL(0.9::real, ARRAY[$5::int]))
             ON CONFLICT (oem_number, brand, part_category)
             DO UPDATE SET hit_count = oem_numbers.hit_count + 1, updated_at = NOW()`,
            [oems, brands, categories, descriptions, results.length]
        );
        inserted = res.rowCount || 0;
    } catch (err) {
        logger.warn('[OEM-DB] Bulk insert oem_numbers failed:', err instanceof Error ? err.message : err);
    }

    // Batch fitments: multi-row INSERT with UNNEST
    const fitments = results.filter(r => r.model || r.model_code);
    if (fitments.length > 0) {
        try {
            await pool.query(
                `INSERT INTO vehicle_fitments (oem_number, make, model, model_code, year_from, year_to, engine, source)
                 SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[],
                    $5::int[], $6::int[], $7::text[],
                    ARRAY_FILL('PartsLink24'::text, ARRAY[$8::int]))
                 ON CONFLICT DO NOTHING`,
                [
                    fitments.map(r => r.oem),
                    fitments.map(r => r.brand),
                    fitments.map(r => r.model || null),
                    fitments.map(r => r.model_code || null),
                    fitments.map(r => r.year_from ?? null),
                    fitments.map(r => r.year_to ?? null),
                    fitments.map(r => r.engine || null),
                    fitments.length,
                ]
            );
        } catch (err) {
            logger.warn('[OEM-DB] Bulk insert fitments failed:', err instanceof Error ? err.message : err);
        }
    }

    return inserted;
}

// ── Query Functions ──────────────────────────────────────────

/**
 * Fuzzy search OEM numbers. Used by the Bot-Service and Admin-Dashboard.
 */
export async function searchOem(query: string, limit = 25): Promise<unknown[]> {
    if (!pool) return [];
    try {
        const result = await pool.query(
            `SELECT oem_number, brand, part_category, part_description, confidence, hit_count,
                    GREATEST(similarity(oem_number, $1), COALESCE(similarity(part_description, $1), 0)) AS relevance
             FROM oem_numbers
             WHERE oem_number % $1 OR oem_number ILIKE $2 OR part_description ILIKE $2
             ORDER BY relevance DESC
             LIMIT $3`,
            [query, `%${query}%`, limit]
        );
        return result.rows;
    } catch (err) {
        logger.warn('[OEM-DB] Search failed:', err instanceof Error ? err.message : err);
        return [];
    }
}

/**
 * Get OEM DB stats for the health endpoint.
 */
export async function getOemDbStats(): Promise<{ oem_numbers: number; cross_references: number; vehicle_fitments: number } | null> {
    if (!pool) return null;
    try {
        const result = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM oem_numbers)::int AS oem_numbers,
                (SELECT COUNT(*) FROM cross_references)::int AS cross_references,
                (SELECT COUNT(*) FROM vehicle_fitments)::int AS vehicle_fitments
        `);
        return result.rows[0];
    } catch {
        return null;
    }
}

export async function closeOemDb(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
    }
}
