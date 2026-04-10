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

import { Pool } from 'pg';
import { logger } from './logger';

let pool: Pool | null = null;

export function getOemPool(): Pool | null {
    return pool;
}

export async function initOemDb(): Promise<boolean> {
    const url = process.env.OEM_DATABASE_URL;
    if (!url) {
        logger.warn('[OEM-DB] OEM_DATABASE_URL not set — OEM PostgreSQL disabled. Using SQLite only.');
        return false;
    }

    try {
        // Railway private networking uses plain TCP (no SSL), but the public
        // proxy (mainline.proxy.rlwy.net) requires SSL. Detect by hostname.
        const isPrivate = url.includes('.railway.internal');
        pool = new Pool({
            connectionString: url,
            ssl: isPrivate ? false : { rejectUnauthorized: false },
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        });

        logger.info(`[OEM-DB] Connecting to ${isPrivate ? 'private' : 'public'} PostgreSQL...`);

        // Test connection
        const client = await pool.connect();
        try {
            await runMigrations(client);
            logger.info('[OEM-DB] ✅ PostgreSQL connected + migrations applied');
        } finally {
            client.release();
        }
        return true;
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[OEM-DB] ❌ Failed to connect: ${msg}`);
        logger.error(`[OEM-DB] URL pattern: ${url.replace(/:[^@]+@/, ':***@')}`);
        pool = null;
        return false;
    }
}

async function runMigrations(client: import('pg').PoolClient): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    const applied = new Set(
        (await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)
    );

    if (!applied.has('001_oem_init')) {
        logger.info('[OEM-DB] Applying migration: 001_oem_init');
        await client.query('BEGIN');
        try {
            await client.query(`
                CREATE EXTENSION IF NOT EXISTS pg_trgm;

                CREATE TABLE IF NOT EXISTS oem_numbers (
                    id SERIAL PRIMARY KEY,
                    oem_number VARCHAR(50) NOT NULL,
                    brand VARCHAR(100) NOT NULL,
                    part_category VARCHAR(50) DEFAULT 'other',
                    part_description TEXT,
                    superseded_by VARCHAR(50),
                    sources JSONB DEFAULT '[]'::jsonb,
                    confidence REAL DEFAULT 0.5,
                    hit_count INTEGER DEFAULT 0,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(oem_number, brand, part_category)
                );

                CREATE TABLE IF NOT EXISTS cross_references (
                    id SERIAL PRIMARY KEY,
                    oem_number VARCHAR(50) NOT NULL,
                    cross_number VARCHAR(50) NOT NULL,
                    cross_brand VARCHAR(100),
                    cross_type VARCHAR(20) DEFAULT 'aftermarket',
                    source VARCHAR(100),
                    confidence REAL DEFAULT 0.5,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(oem_number, cross_number)
                );

                CREATE TABLE IF NOT EXISTS vehicle_fitments (
                    id SERIAL PRIMARY KEY,
                    oem_number VARCHAR(50) NOT NULL,
                    make VARCHAR(100) NOT NULL,
                    model VARCHAR(200),
                    model_code VARCHAR(50),
                    hsn VARCHAR(10),
                    tsn VARCHAR(10),
                    year_from INTEGER,
                    year_to INTEGER,
                    engine VARCHAR(100),
                    source VARCHAR(100),
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );

                CREATE INDEX IF NOT EXISTS idx_oem_num_trgm ON oem_numbers USING GIN (oem_number gin_trgm_ops);
                CREATE INDEX IF NOT EXISTS idx_oem_brand ON oem_numbers(brand);
                CREATE INDEX IF NOT EXISTS idx_xref_oem ON cross_references(oem_number);
                CREATE INDEX IF NOT EXISTS idx_xref_cross ON cross_references(cross_number);
                CREATE INDEX IF NOT EXISTS idx_xref_oem_trgm ON cross_references USING GIN (oem_number gin_trgm_ops);
                CREATE INDEX IF NOT EXISTS idx_fit_oem ON vehicle_fitments(oem_number);
                CREATE INDEX IF NOT EXISTS idx_fit_hsn_tsn ON vehicle_fitments(hsn, tsn);
                CREATE INDEX IF NOT EXISTS idx_fit_make ON vehicle_fitments(make);
            `);
            await client.query("INSERT INTO schema_migrations (name) VALUES ('001_oem_init')");
            await client.query('COMMIT');
            logger.info('[OEM-DB] ✅ 001_oem_init applied');
        } catch (err) {
            await client.query('ROLLBACK');
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('already exists')) {
                await client.query("INSERT INTO schema_migrations (name) VALUES ('001_oem_init') ON CONFLICT DO NOTHING");
                logger.warn('[OEM-DB] Tables already exist — marked as applied');
            } else {
                throw err;
            }
        }
    }

    // ── Migration 002: Vehicle master data + extended fitment columns ──
    if (!applied.has('002_vehicle_master')) {
        logger.info('[OEM-DB] Applying migration: 002_vehicle_master');
        await client.query('BEGIN');
        try {
            await client.query(`
                -- Vehicle master table: one row per unique vehicle variant
                -- Enables "which parts fit my car" lookups by KBA, VIN, or make/model
                CREATE TABLE IF NOT EXISTS vehicles (
                    id SERIAL PRIMARY KEY,
                    make VARCHAR(100) NOT NULL,
                    model VARCHAR(200) NOT NULL,
                    model_code VARCHAR(50),
                    variant VARCHAR(200),
                    body_type VARCHAR(50),
                    year_from INTEGER,
                    year_to INTEGER,
                    engine_code VARCHAR(50),
                    engine_description VARCHAR(200),
                    displacement_cc INTEGER,
                    power_kw INTEGER,
                    power_ps INTEGER,
                    fuel_type VARCHAR(30),
                    transmission VARCHAR(50),
                    drive_type VARCHAR(30),
                    hsn VARCHAR(10),
                    tsn VARCHAR(10),
                    kba_number VARCHAR(20),
                    source VARCHAR(100),
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    UNIQUE(make, model, year_from, engine_code, hsn, tsn)
                );

                -- Extend vehicle_fitments with a vehicle_id FK
                ALTER TABLE vehicle_fitments ADD COLUMN IF NOT EXISTS vehicle_id INTEGER REFERENCES vehicles(id);
                ALTER TABLE vehicle_fitments ADD COLUMN IF NOT EXISTS engine_code VARCHAR(50);
                ALTER TABLE vehicle_fitments ADD COLUMN IF NOT EXISTS displacement_cc INTEGER;
                ALTER TABLE vehicle_fitments ADD COLUMN IF NOT EXISTS power_kw INTEGER;
                ALTER TABLE vehicle_fitments ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(30);
                ALTER TABLE vehicle_fitments ADD COLUMN IF NOT EXISTS body_type VARCHAR(50);
                ALTER TABLE vehicle_fitments ADD COLUMN IF NOT EXISTS kba_number VARCHAR(20);

                -- Extend oem_numbers with aftermarket brand cross-ref count
                ALTER TABLE oem_numbers ADD COLUMN IF NOT EXISTS cross_ref_count INTEGER DEFAULT 0;

                -- Indexes
                CREATE INDEX IF NOT EXISTS idx_vehicles_make_model ON vehicles(make, model);
                CREATE INDEX IF NOT EXISTS idx_vehicles_hsn_tsn ON vehicles(hsn, tsn);
                CREATE INDEX IF NOT EXISTS idx_vehicles_kba ON vehicles(kba_number);
                CREATE INDEX IF NOT EXISTS idx_vehicles_engine ON vehicles(engine_code);
                CREATE INDEX IF NOT EXISTS idx_fit_vehicle_id ON vehicle_fitments(vehicle_id);
                CREATE INDEX IF NOT EXISTS idx_fit_kba ON vehicle_fitments(kba_number);
            `);
            await client.query("INSERT INTO schema_migrations (name) VALUES ('002_vehicle_master')");
            await client.query('COMMIT');
            logger.info('[OEM-DB] ✅ 002_vehicle_master applied');
        } catch (err) {
            await client.query('ROLLBACK');
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('already exists')) {
                await client.query("INSERT INTO schema_migrations (name) VALUES ('002_vehicle_master') ON CONFLICT DO NOTHING");
                logger.warn('[OEM-DB] 002 tables already exist — marked as applied');
            } else {
                logger.error(`[OEM-DB] 002_vehicle_master FAILED: ${msg}`);
            }
        }
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
 * Called after each Hauptgruppe/Bildtafel batch completes.
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
    [key: string]: unknown; // Allow extra fields (vin, bildtafel, etc.)
}>): Promise<number> {
    if (!pool || results.length === 0) return 0;

    let inserted = 0;
    for (const r of results) {
        try {
            await pool.query(
                `INSERT INTO oem_numbers (oem_number, brand, part_category, part_description, sources, confidence)
                 VALUES ($1, $2, $3, $4, '["PartsLink24"]'::jsonb, 0.9)
                 ON CONFLICT (oem_number, brand, part_category)
                 DO UPDATE SET hit_count = oem_numbers.hit_count + 1, updated_at = NOW()`,
                [r.oem, r.brand, r.hg_name || 'other', r.description || null]
            );

            if (r.model || r.model_code) {
                await pool.query(
                    `INSERT INTO vehicle_fitments (oem_number, make, model, model_code, year_from, year_to, engine, source)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PartsLink24')
                     ON CONFLICT DO NOTHING`,
                    [r.oem, r.brand, r.model || null, r.model_code || null, r.year_from || null, r.year_to || null, r.engine || null]
                );
            }
            inserted++;
        } catch {
            // Skip individual failures
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
