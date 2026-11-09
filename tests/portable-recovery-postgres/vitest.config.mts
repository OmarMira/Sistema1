import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Isolated runner for the portable recovery PostgreSQL contract suite.
//
// `envDir: false` keeps any ambient .env (and therefore the owner's database,
// credentials and SMTP settings) out of the process, and there is no setup file
// and no globalSetup: the disposable database is provisioned by
// tests/portable-recovery-postgres/run.mjs, which builds it FROM MIGRATIONS and
// passes DATABASE_URL explicitly. This config refuses to run without that exact
// disposable database name, so it can never point at an ambient installation.
const database = (() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Use tests/portable-recovery-postgres/run.mjs: DATABASE_URL is not set');
  const name = new URL(url).pathname.replace(/^\//, '');
  if (name !== 'accountexpress_bootstraptest') {
    throw new Error(`Refusing to run: DATABASE_URL must name accountexpress_bootstraptest, not "${name}"`);
  }
  if (!/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\//.test(url)) {
    throw new Error('Refusing to run: DATABASE_URL must point at an ephemeral loopback port');
  }
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing to run: NODE_ENV must be test');
  if (!process.env.ACCOUNTEXPRESS_DATA_DIR) {
    throw new Error('Refusing to run: ACCOUNTEXPRESS_DATA_DIR (scratch runtime root) is required');
  }
  return name;
})();

export default defineConfig({
  envDir: false,
  cacheDir: path.join(os.tmpdir(), 'sistema1-portable-recovery-pg', 'vite'),
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
  test: {
    include: ['tests/portable-recovery-postgres/**/*.pg.test.ts'],
    environment: 'node',
    setupFiles: [],
    globalSetup: [],
    cache: false,
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: { PORTABLE_RECOVERY_PG_DATABASE: database },
  },
});
