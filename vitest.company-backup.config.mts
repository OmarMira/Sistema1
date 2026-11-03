import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  envDir: false,
  cacheDir: 'tests/backup-company/.scratch/vite',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/backup-company/**/*.test.ts'],
    environment: 'node',
    // envDir is disabled so no ambient .env (and no ambient database) leaks in;
    // backup files are sealed at rest, so this runner needs its own test-only key.
    env: { SESSION_SECRET: 'company-backup-test-secret-not-for-production' },
    setupFiles: [],
    globalSetup: [],
    cache: false,
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 5000,
  },
});
