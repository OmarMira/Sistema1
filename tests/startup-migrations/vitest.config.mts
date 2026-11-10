import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Isolated runner for the startup self-migration contract (S2/S9).
// `envDir: false` keeps the ambient .env — and therefore the operator's real
// database — out of this process. The caller supplies DATABASE_URL for the
// disposable `accountexpress_bootstraptest` database only; the test refuses any
// other database name. No setup/globalSetup file runs, and tool caches stay
// outside the worktree.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: repoRoot,
  envDir: false,
  cacheDir: path.join(os.tmpdir(), 'sistema1-startup-migrations', 'vite'),
  resolve: { alias: { '@': path.join(repoRoot, 'src') } },
  test: {
    include: ['tests/startup-migrations/**/*.test.ts'],
    environment: 'node',
    setupFiles: [],
    globalSetup: [],
    cache: false,
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
