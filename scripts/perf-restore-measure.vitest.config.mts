/**
 * Runner config for the portable company-restore MEASUREMENT harness.
 * Deliberately separate from vitest.config.ts:
 *  - no globalSetup (it would `prisma db push` the default database),
 *  - the harness is NOT named *.test.ts, so the normal suite never collects it,
 *  - this file refuses to start unless the target database is the disposable
 *    measurement cluster (127.0.0.1:55432/accountexpress_test) and the runtime
 *    data directory is a scratch directory outside the repository.
 *
 * Run (see tests/perf/restore-measure.perf.ts for the full command; the
 * `--reporter=verbose` flag is required because the default reporter hides
 * stdout when it is not attached to a terminal):
 *   DATABASE_URL=postgresql://postgres:testpw@127.0.0.1:55432/accountexpress_test?schema=public \
 *   ACCOUNTEXPRESS_DATA_DIR=<scratch outside repo> SESSION_SECRET=... HMAC_SECRET=... \
 *   npx vitest run --config scripts/perf-restore-measure.vitest.config.mts --reporter=verbose
 */
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = path.resolve(import.meta.dirname, '..');

function refuse(reason: string): never {
  throw new Error(`[PERF SAFETY] ${reason}`);
}

export function targetDatabase(): { port: string; database: string; host: string } {
  const raw = process.env.DATABASE_URL;
  if (!raw) refuse('DATABASE_URL is required (disposable 127.0.0.1:55432 test cluster).');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return refuse('DATABASE_URL is not a valid URL.');
  }
  const database = parsed.pathname.replace(/^\//, '');
  // Never the operator database (localhost:5432) and never a production host.
  if (parsed.port !== '55432' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || database !== 'accountexpress_test') {
    refuse(`refusing ${parsed.hostname}:${parsed.port}/${database}; the harness only runs on the disposable cluster 127.0.0.1:55432/accountexpress_test.`);
  }
  return { port: parsed.port, database, host: parsed.hostname };
}

export function scratchDataRoot(): string {
  const raw = process.env.ACCOUNTEXPRESS_DATA_DIR;
  if (!raw) refuse('ACCOUNTEXPRESS_DATA_DIR is required so no real db/backups or runtime config is touched.');
  const resolved = path.resolve(raw);
  if (!path.isAbsolute(raw)) refuse('ACCOUNTEXPRESS_DATA_DIR must be absolute.');
  const inside = (child: string, parent: string) =>
    child === parent || child.startsWith(parent + path.sep);
  if (inside(resolved, repoRoot) || inside(repoRoot, resolved)) {
    refuse('ACCOUNTEXPRESS_DATA_DIR must live outside the repository working tree.');
  }
  if (!path.basename(resolved).startsWith('s1-perf-restore')) {
    refuse('ACCOUNTEXPRESS_DATA_DIR must be a dedicated scratch directory named s1-perf-restore* (teardown deletes it).');
  }
  return resolved;
}

/** Env contract checked at config load, before any worker imports src/lib/db. */
targetDatabase();
scratchDataRoot();
for (const name of ['SESSION_SECRET', 'HMAC_SECRET']) {
  if (!process.env[name]) refuse(`${name} is required (synthetic value is fine; nothing real is read).`);
}

export default defineConfig({
  envDir: false,
  resolve: {
    alias: {
      '@': path.resolve(repoRoot, './src'),
      'server-only': path.resolve(repoRoot, './node_modules/next/dist/compiled/server-only/empty'),
    },
  },
  test: {
    include: ['tests/perf/**/*.perf.ts'],
    globals: true,
    environment: 'node',
    fileParallelism: false,
    // Measurement, not a bounded assertion: the restore may run up to the
    // production interactive-transaction timeout plus rollback settlement.
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
  },
});
