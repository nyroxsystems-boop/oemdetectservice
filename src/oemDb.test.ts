import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { allowDegradedOemDatabase, buildOemPoolConfig, initOemDb } from './oemDb';
import { migrationChecksum, OEM_MIGRATIONS, runOemMigrations } from './oemMigrations';

interface QueryCall {
    text: string;
    values?: unknown[];
}

interface AppliedMigrationRow {
    name: string;
    checksum_sha256: string | null;
}

function createMigrationClient(options: {
    applied?: AppliedMigrationRow[];
    migrationInvariant?: boolean;
    metadataInvariant?: boolean;
} = {}): { client: PoolClient; calls: QueryCall[] } {
    const calls: QueryCall[] = [];
    const client = {
        async query(text: string, values?: unknown[]) {
            calls.push({ text, values });
            if (text.includes('SELECT name, checksum_sha256')) {
                return { rows: options.applied || [] };
            }
            if (text.includes("to_regclass('public.schema_migrations')")) {
                return { rows: [{ valid: options.metadataInvariant !== false }] };
            }
            if (text.includes(' AS valid')) {
                return { rows: [{ valid: options.migrationInvariant !== false }] };
            }
            return { rows: [] };
        },
    } as unknown as PoolClient;
    return { client, calls };
}

test('OEM PostgreSQL verifies TLS by default and supports a custom CA', () => {
    const config = buildOemPoolConfig(
        'postgresql://catalog:secret@db.example.com:5432/oem',
        { OEM_DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\\nCA\\n-----END CERTIFICATE-----' },
    );

    assert.deepEqual(config.ssl, {
        rejectUnauthorized: true,
        ca: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
    });
});

test('plaintext PostgreSQL requires an explicit mode and a private hostname', () => {
    const privateConfig = buildOemPoolConfig(
        'postgresql://catalog:secret@oem-db:5432/oem',
        { OEM_DATABASE_SSL_MODE: 'disable' },
    );
    assert.equal(privateConfig.ssl, false);

    assert.throws(
        () => buildOemPoolConfig(
            'postgresql://catalog:secret@db.example.com:5432/oem',
            { OEM_DATABASE_SSL_MODE: 'disable' },
        ),
        /private\/internal database hosts/,
    );
});

test('unsafe or ambiguous TLS configuration is rejected', () => {
    assert.throws(
        () => buildOemPoolConfig(
            'postgresql://catalog:secret@db.example.com:5432/oem?sslmode=require',
            {},
        ),
        /must not contain sslmode/,
    );
    assert.throws(
        () => buildOemPoolConfig(
            'postgresql://catalog:secret@db.example.com:5432/oem',
            { OEM_DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' },
        ),
        /is forbidden/,
    );
    assert.throws(
        () => buildOemPoolConfig(
            'postgresql://catalog:secret@db.example.com:5432/oem',
            { OEM_DATABASE_SSL_MODE: 'prefer' },
        ),
        /verify-full.*disable/,
    );
});

test('degraded startup is explicit and is never enabled in production', () => {
    assert.equal(allowDegradedOemDatabase({ NODE_ENV: 'development' }), false);
    assert.equal(allowDegradedOemDatabase({ NODE_ENV: 'development', OEM_DATABASE_ALLOW_DEGRADED: 'true' }), true);
    assert.equal(allowDegradedOemDatabase({ NODE_ENV: 'test', OEM_DATABASE_ALLOW_DEGRADED: 'true' }), true);
    assert.equal(allowDegradedOemDatabase({ NODE_ENV: 'staging', OEM_DATABASE_ALLOW_DEGRADED: 'true' }), false);
    assert.equal(allowDegradedOemDatabase({ NODE_ENV: 'Production', OEM_DATABASE_ALLOW_DEGRADED: 'true' }), false);
    assert.equal(allowDegradedOemDatabase({ NODE_ENV: 'production', OEM_DATABASE_ALLOW_DEGRADED: 'true' }), false);
});

test('configured database initialization fails closed except for explicit development fallback', async () => {
    const invalidDatabase = {
        OEM_DATABASE_URL: 'not-a-postgresql-url',
    };

    await assert.rejects(
        () => initOemDb({ ...invalidDatabase, NODE_ENV: 'production' }),
        /OEM PostgreSQL initialization failed/,
    );
    await assert.rejects(
        () => initOemDb({ ...invalidDatabase, NODE_ENV: 'development' }),
        /OEM PostgreSQL initialization failed/,
    );
    assert.equal(
        await initOemDb({
            ...invalidDatabase,
            NODE_ENV: 'development',
            OEM_DATABASE_ALLOW_DEGRADED: 'true',
        }),
        false,
    );
    await assert.rejects(
        () => initOemDb({ OEM_DATABASE_REQUIRED: 'true' }),
        /OEM_DATABASE_URL is required/,
    );
});

test('new migrations run transactionally under a lock and record SHA-256 checksums', async () => {
    const { client, calls } = createMigrationClient();
    await runOemMigrations(client);

    assert.match(calls[0].text, /pg_advisory_lock/);
    assert.match(calls.at(-1)?.text || '', /pg_advisory_unlock/);
    assert.equal(calls.filter(call => call.text === 'BEGIN').length, OEM_MIGRATIONS.length);
    assert.equal(calls.filter(call => call.text === 'COMMIT').length, OEM_MIGRATIONS.length);
    assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 0);

    const inserts = calls.filter(call => call.text.includes('INSERT INTO public.schema_migrations'));
    assert.equal(inserts.length, OEM_MIGRATIONS.length);
    for (const [index, call] of inserts.entries()) {
        assert.equal(call.values?.[0], OEM_MIGRATIONS[index].name);
        assert.equal(call.values?.[1], migrationChecksum(OEM_MIGRATIONS[index].sql));
        assert.match(String(call.values?.[1]), /^[a-f0-9]{64}$/);
    }
});

test('legacy migration records are adopted only after invariant verification', async () => {
    const { client, calls } = createMigrationClient({
        applied: OEM_MIGRATIONS.map(migration => ({ name: migration.name, checksum_sha256: null })),
    });
    await runOemMigrations(client);

    assert.equal(calls.filter(call => OEM_MIGRATIONS.some(migration => call.text === migration.sql)).length, 0);
    assert.equal(calls.filter(call => call.text.includes('UPDATE public.schema_migrations SET checksum_sha256')).length, OEM_MIGRATIONS.length);
    assert.equal(calls.filter(call => call.text === 'COMMIT').length, OEM_MIGRATIONS.length);
});

test('checksum drift fails closed and still releases the advisory lock', async () => {
    const { client, calls } = createMigrationClient({
        applied: [{ name: OEM_MIGRATIONS[0].name, checksum_sha256: '0'.repeat(64) }],
    });

    await assert.rejects(() => runOemMigrations(client), /Migration checksum mismatch/);
    assert.equal(calls.some(call => call.text === 'BEGIN'), false);
    assert.match(calls.at(-1)?.text || '', /pg_advisory_unlock/);
});

test('a failed schema invariant rolls back and fails closed', async () => {
    const { client, calls } = createMigrationClient({ migrationInvariant: false });

    await assert.rejects(() => runOemMigrations(client), /Schema invariant failed/);
    assert.equal(calls.filter(call => call.text === 'BEGIN').length, 1);
    assert.equal(calls.filter(call => call.text === 'ROLLBACK').length, 1);
    assert.equal(calls.some(call => call.text === 'COMMIT'), false);
    assert.match(calls.at(-1)?.text || '', /pg_advisory_unlock/);
});

test('an invalid migration metadata table fails before applying migrations', async () => {
    const { client, calls } = createMigrationClient({ metadataInvariant: false });

    await assert.rejects(() => runOemMigrations(client), /schema_migrations.*invariant/);
    assert.equal(calls.some(call => OEM_MIGRATIONS.some(migration => call.text === migration.sql)), false);
    assert.match(calls.at(-1)?.text || '', /pg_advisory_unlock/);
});
