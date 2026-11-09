import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

// Isolated runner for the portable owner-verified bootstrap recovery workflow.
// `envDir: false` keeps the ambient .env (and therefore the ambient database)
// out of the process; no setup/globalSetup file runs, so nothing opens a real
// connection or reads a private backup. Scratch and tool caches live outside
// the worktree.
export default defineConfig({
  envDir: false,
  cacheDir: path.join(os.tmpdir(), 'sistema1-bootstrap-recovery', 'vite'),
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    // .tsx is included for the jsdom component contracts (create-backup UI).
    include: ['tests/bootstrap-recovery/**/*.test.{ts,tsx}'],
    environment: 'node',
    // Synthetic secrets only: no DATABASE_URL, no real credentials, no .env.
    env: {
      NODE_ENV: 'test',
      SESSION_SECRET: 'bootstrap-recovery-test-secret-not-for-production',
      HMAC_SECRET: 'bootstrap-recovery-test-hmac-not-for-production',
    },
    setupFiles: [],
    globalSetup: [],
    cache: false,
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 10000,
  },
});
