import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { logger } from './logger';

const MIGRATION_LOCK_ID = 731_946_205;

export interface OemMigration {
    name: string;
    sql: string;
    invariantSql: string;
}

const migration001Sql = `
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    CREATE TABLE IF NOT EXISTS public.oem_numbers (
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

    CREATE TABLE IF NOT EXISTS public.cross_references (
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

    CREATE TABLE IF NOT EXISTS public.vehicle_fitments (
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

    CREATE INDEX IF NOT EXISTS idx_oem_num_trgm ON public.oem_numbers USING GIN (oem_number gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_oem_brand ON public.oem_numbers(brand);
    CREATE INDEX IF NOT EXISTS idx_xref_oem ON public.cross_references(oem_number);
    CREATE INDEX IF NOT EXISTS idx_xref_cross ON public.cross_references(cross_number);
    CREATE INDEX IF NOT EXISTS idx_xref_oem_trgm ON public.cross_references USING GIN (oem_number gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_fit_oem ON public.vehicle_fitments(oem_number);
    CREATE INDEX IF NOT EXISTS idx_fit_hsn_tsn ON public.vehicle_fitments(hsn, tsn);
    CREATE INDEX IF NOT EXISTS idx_fit_make ON public.vehicle_fitments(make);
`;

const migration001Invariant = `
    SELECT (
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')
        AND to_regclass('public.oem_numbers') IS NOT NULL
        AND to_regclass('public.cross_references') IS NOT NULL
        AND to_regclass('public.vehicle_fitments') IS NOT NULL
        AND (
            SELECT COUNT(DISTINCT column_name) = 11
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'oem_numbers'
              AND column_name = ANY(ARRAY['id', 'oem_number', 'brand', 'part_category', 'part_description', 'superseded_by', 'sources', 'confidence', 'hit_count', 'created_at', 'updated_at'])
        )
        AND (
            SELECT COUNT(DISTINCT column_name) = 8
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'cross_references'
              AND column_name = ANY(ARRAY['id', 'oem_number', 'cross_number', 'cross_brand', 'cross_type', 'source', 'confidence', 'created_at'])
        )
        AND (
            SELECT COUNT(DISTINCT column_name) = 12
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'vehicle_fitments'
              AND column_name = ANY(ARRAY['id', 'oem_number', 'make', 'model', 'model_code', 'hsn', 'tsn', 'year_from', 'year_to', 'engine', 'source', 'created_at'])
        )
        AND (
            SELECT COUNT(DISTINCT indexname) = 8
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND indexname = ANY(ARRAY['idx_oem_num_trgm', 'idx_oem_brand', 'idx_xref_oem', 'idx_xref_cross', 'idx_xref_oem_trgm', 'idx_fit_oem', 'idx_fit_hsn_tsn', 'idx_fit_make'])
        )
        AND EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'oem_numbers'
              AND indexdef LIKE 'CREATE UNIQUE INDEX%'
              AND POSITION('(oem_number, brand, part_category)' IN indexdef) > 0
        )
        AND EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'cross_references'
              AND indexdef LIKE 'CREATE UNIQUE INDEX%'
              -- The shared YQ schema additionally scopes this key by
              -- cross_brand. Its leading OE/cross pair is compatible with
              -- this read/write model and avoids weakening existing data.
              AND POSITION('(oem_number, cross_number' IN indexdef) > 0
        )
    ) AS valid
`;

const migration002Sql = `
    CREATE TABLE IF NOT EXISTS public.vehicles (
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

    ALTER TABLE public.vehicle_fitments ADD COLUMN IF NOT EXISTS vehicle_id INTEGER REFERENCES public.vehicles(id);
    ALTER TABLE public.vehicle_fitments ADD COLUMN IF NOT EXISTS engine_code VARCHAR(50);
    ALTER TABLE public.vehicle_fitments ADD COLUMN IF NOT EXISTS displacement_cc INTEGER;
    ALTER TABLE public.vehicle_fitments ADD COLUMN IF NOT EXISTS power_kw INTEGER;
    ALTER TABLE public.vehicle_fitments ADD COLUMN IF NOT EXISTS fuel_type VARCHAR(30);
    ALTER TABLE public.vehicle_fitments ADD COLUMN IF NOT EXISTS body_type VARCHAR(50);
    ALTER TABLE public.vehicle_fitments ADD COLUMN IF NOT EXISTS kba_number VARCHAR(20);
    ALTER TABLE public.oem_numbers ADD COLUMN IF NOT EXISTS cross_ref_count INTEGER DEFAULT 0;

    CREATE INDEX IF NOT EXISTS idx_vehicles_make_model ON public.vehicles(make, model);
    CREATE INDEX IF NOT EXISTS idx_vehicles_hsn_tsn ON public.vehicles(hsn, tsn);
    CREATE INDEX IF NOT EXISTS idx_vehicles_kba ON public.vehicles(kba_number);
    CREATE INDEX IF NOT EXISTS idx_vehicles_engine ON public.vehicles(engine_code);
    CREATE INDEX IF NOT EXISTS idx_fit_vehicle_id ON public.vehicle_fitments(vehicle_id);
    CREATE INDEX IF NOT EXISTS idx_fit_kba ON public.vehicle_fitments(kba_number);
`;

const migration002Invariant = `
    SELECT (
        to_regclass('public.vehicles') IS NOT NULL
        AND (
            SELECT COUNT(DISTINCT column_name) = 21
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'vehicles'
              AND column_name = ANY(ARRAY['id', 'make', 'model', 'model_code', 'variant', 'body_type', 'year_from', 'year_to', 'engine_code', 'engine_description', 'displacement_cc', 'power_kw', 'power_ps', 'fuel_type', 'transmission', 'drive_type', 'hsn', 'tsn', 'kba_number', 'source', 'created_at'])
        )
        AND (
            SELECT COUNT(DISTINCT column_name) = 7
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'vehicle_fitments'
              AND column_name = ANY(ARRAY['vehicle_id', 'engine_code', 'displacement_cc', 'power_kw', 'fuel_type', 'body_type', 'kba_number'])
        )
        AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'oem_numbers' AND column_name = 'cross_ref_count'
        )
        AND (
            SELECT COUNT(DISTINCT indexname) = 6
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND indexname = ANY(ARRAY['idx_vehicles_make_model', 'idx_vehicles_hsn_tsn', 'idx_vehicles_kba', 'idx_vehicles_engine', 'idx_fit_vehicle_id', 'idx_fit_kba'])
        )
        AND EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.vehicle_fitments'::regclass
              AND confrelid = 'public.vehicles'::regclass
              AND contype = 'f'
        )
        AND EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'vehicles'
              AND indexdef LIKE 'CREATE UNIQUE INDEX%'
              AND POSITION('(make, model, year_from, engine_code, hsn, tsn)' IN indexdef) > 0
        )
    ) AS valid
`;

export const OEM_MIGRATIONS: readonly OemMigration[] = Object.freeze([
    Object.freeze({ name: '001_oem_init', sql: migration001Sql, invariantSql: migration001Invariant }),
    Object.freeze({ name: '002_vehicle_master', sql: migration002Sql, invariantSql: migration002Invariant }),
]);

export function migrationChecksum(sql: string): string {
    return createHash('sha256').update(sql, 'utf8').digest('hex');
}

async function assertMigrationTableInvariant(client: PoolClient): Promise<void> {
    const result = await client.query(`
        SELECT (
            to_regclass('public.schema_migrations') IS NOT NULL
            AND EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'schema_migrations'
                  AND column_name = 'name' AND data_type = 'text' AND is_nullable = 'NO'
            )
            AND EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'schema_migrations'
                  AND column_name = 'checksum_sha256' AND data_type IN ('text', 'character', 'character varying')
            )
            AND EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conrelid = 'public.schema_migrations'::regclass
                  AND contype = 'p'
                  AND conkey = ARRAY[(
                      SELECT attnum
                      FROM pg_attribute
                      WHERE attrelid = 'public.schema_migrations'::regclass
                        AND attname = 'name'
                        AND NOT attisdropped
                  )]
            )
        ) AS valid
    `);
    if (result.rows[0]?.valid !== true) {
        throw new Error('schema_migrations does not satisfy the required schema invariant');
    }
}

async function assertMigrationInvariant(client: PoolClient, migration: OemMigration): Promise<void> {
    const result = await client.query(migration.invariantSql);
    if (result.rows[0]?.valid !== true) {
        throw new Error(`Schema invariant failed for migration ${migration.name}`);
    }
}

async function rollbackAndRethrow(client: PoolClient, error: unknown): Promise<never> {
    try {
        await client.query('ROLLBACK');
    } catch (rollbackError: unknown) {
        logger.error('[OEM-DB] Migration rollback failed', {
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
    }
    throw error;
}

export async function runOemMigrations(client: PoolClient): Promise<void> {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS public.schema_migrations (
                name TEXT PRIMARY KEY,
                checksum_sha256 TEXT,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await client.query('ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT');
        await assertMigrationTableInvariant(client);

        const names = OEM_MIGRATIONS.map(migration => migration.name);
        const appliedResult = await client.query(
            'SELECT name, checksum_sha256 FROM public.schema_migrations WHERE name = ANY($1::text[])',
            [names],
        );
        const applied = new Map<string, string | null>(
            appliedResult.rows.map(row => [String(row.name), row.checksum_sha256 ? String(row.checksum_sha256) : null]),
        );

        for (const migration of OEM_MIGRATIONS) {
            const expectedChecksum = migrationChecksum(migration.sql);
            const existingChecksum = applied.get(migration.name);
            let completionMessage: string | null = null;

            if (existingChecksum !== undefined && existingChecksum !== null && existingChecksum !== expectedChecksum) {
                throw new Error(
                    `Migration checksum mismatch for ${migration.name}: database=${existingChecksum}, code=${expectedChecksum}`,
                );
            }

            await client.query('BEGIN');
            try {
                if (existingChecksum === undefined) {
                    logger.info(`[OEM-DB] Applying migration: ${migration.name}`);
                    await client.query(migration.sql);
                    await assertMigrationInvariant(client, migration);
                    await client.query(
                        'INSERT INTO public.schema_migrations (name, checksum_sha256) VALUES ($1, $2)',
                        [migration.name, expectedChecksum],
                    );
                    completionMessage = `[OEM-DB] ✅ ${migration.name} applied`;
                } else {
                    // Historical releases recorded only the name. Adopt them only
                    // after proving the complete expected schema is present.
                    await assertMigrationInvariant(client, migration);
                    if (existingChecksum === null) {
                        await client.query(
                            'UPDATE public.schema_migrations SET checksum_sha256 = $2 WHERE name = $1 AND checksum_sha256 IS NULL',
                            [migration.name, expectedChecksum],
                        );
                        completionMessage = `[OEM-DB] ✅ ${migration.name} legacy record adopted after invariant verification`;
                    }
                }
                await client.query('COMMIT');
                if (completionMessage) logger.info(completionMessage);
            } catch (error: unknown) {
                await rollbackAndRethrow(client, error);
            }
        }
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
}
