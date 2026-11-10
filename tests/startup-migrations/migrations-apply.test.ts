import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, expect, test, vi } from 'vitest';

// S2/S9 — the installed system must apply its own pending migrations on boot.
//
// Isolation contract (setup.md / src/lib/db.ts guard): this suite may only ever
// touch the disposable `accountexpress_bootstraptest` database, and the runtime
// scratch (lock file + completion marker) lives outside the worktree.
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sistema1-startup-migrations-'));
process.env.ACCOUNTEXPRESS_DATA_DIR = dataRoot;
process.env.NODE_ENV = 'test';

const configuredUrl = process.env.DATABASE_URL;
const configuredDatabase = configuredUrl ? new URL(configuredUrl).pathname.replace(/^\//, '') : null;

if (configuredDatabase !== 'accountexpress_bootstraptest') {
  throw new Error(
    `[TEST SAFETY] DATABASE_URL must point at the disposable "accountexpress_bootstraptest" database ` +
      `(got "${configuredDatabase ?? 'null'}"). Refusing to run startup-migration checks elsewhere.`,
  );
}

const databaseUrl = configuredUrl as string;
const runtimeDir = path.join(dataRoot, 'config');
const LOCK_FILE = path.join(runtimeDir, 'startup-migrations.lock');
const STATE_FILE = path.join(runtimeDir, 'startup-migrations.state.json');
const RECOVERY_TABLES = [
  'BootstrapRecoveryChallenge',
  'BootstrapRecoveryLock',
  'BootstrapRecoveryProvenance',
] as const;

async function withClient<T>(run: (client: PrismaClient) => Promise<T>): Promise<T> {
  const client = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    return await run(client);
  } finally {
    await client.$disconnect();
  }
}

async function dropAndRecreatePublicSchema() {
  await withClient(async (client) => {
    await client.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await client.$executeRawUnsafe('CREATE SCHEMA public');
  });
}

async function inspectDatabase() {
  return withClient(async (client) => {
    const tables = await client.$queryRawUnsafe<Array<{ table_name: string }>>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = tables.map((row) => row.table_name);
    const counts: Record<string, number> = {};
    for (const name of RECOVERY_TABLES) {
      if (!names.includes(name)) {
        counts[name] = -1;
        continue;
      }
      const rows = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count FROM "${name}"`,
      );
      counts[name] = Number(rows[0]?.count ?? 0);
    }
    return { names, counts };
  });
}

function clearRuntimeMarkers() {
  fs.rmSync(LOCK_FILE, { force: true });
  fs.rmSync(STATE_FILE, { force: true });
}

// A fresh module instance models a fresh server process (the deployed code
// memoizes its promise at module scope).
async function freshStartupModule() {
  vi.resetModules();
  return import('../../src/lib/startup-migrations');
}

afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('applies every pending migration to an empty bootstraptest database', async () => {
  clearRuntimeMarkers();
  await dropAndRecreatePublicSchema();

  const before = await inspectDatabase();
  for (const table of RECOVERY_TABLES) {
    expect(before.names).not.toContain(table);
  }

  const module_ = await freshStartupModule();
  const result = await module_.ensureStartupMigrations();

  expect(result.status).toBe('applied');

  const after = await inspectDatabase();
  for (const table of RECOVERY_TABLES) {
    expect(after.names).toContain(table);
    expect(after.counts[table]).toBe(0);
  }
  // `migrate deploy` records what it applied; it does not reset anything.
  expect(after.names).toContain('_prisma_migrations');

  // At most once per process: the memoized promise is returned unchanged.
  const repeatStarted = Date.now();
  const repeat = await module_.ensureStartupMigrations();
  expect(repeat).toBe(result);
  expect(Date.now() - repeatStarted).toBeLessThan(500);
}, 180_000);

test('a later boot is a no-op that preserves non-migration tables and their rows', async () => {
  await withClient(async (client) => {
    await client.$executeRawUnsafe(
      'CREATE TABLE IF NOT EXISTS startup_migration_sentinel (id integer PRIMARY KEY, note text NOT NULL)',
    );
    await client.$executeRawUnsafe(
      "INSERT INTO startup_migration_sentinel (id, note) VALUES (1, 'kept') ON CONFLICT (id) DO NOTHING",
    );
  });

  const module_ = await freshStartupModule();
  const started = Date.now();
  const result = await module_.ensureStartupMigrations();

  expect(['applied', 'skipped-concurrent']).toContain(result.status);
  // Up-to-date databases must not pay a second full migration pass.
  expect(Date.now() - started).toBeLessThan(120_000);

  const after = await inspectDatabase();
  expect(after.names).toContain('startup_migration_sentinel');
  for (const table of RECOVERY_TABLES) {
    expect(after.counts[table]).toBe(0);
  }

  const sentinel = await withClient((client) =>
    client.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*)::bigint AS count FROM startup_migration_sentinel WHERE note = \'kept\'',
    ),
  );
  expect(Number(sentinel[0]?.count ?? 0)).toBe(1);
}, 180_000);

test('two concurrent boots serialize: one applies, the other skips', async () => {
  clearRuntimeMarkers();
  await dropAndRecreatePublicSchema();

  vi.resetModules();
  const first = await import('../../src/lib/startup-migrations');
  vi.resetModules();
  const second = await import('../../src/lib/startup-migrations');
  expect(first).not.toBe(second);

  const [firstResult, secondResult] = await Promise.all([
    first.ensureStartupMigrations(),
    second.ensureStartupMigrations(),
  ]);

  expect([firstResult.status, secondResult.status].sort()).toEqual(['applied', 'skipped-concurrent']);

  const after = await inspectDatabase();
  for (const table of RECOVERY_TABLES) {
    expect(after.names).toContain(table);
    expect(after.counts[table]).toBe(0);
  }
}, 180_000);
