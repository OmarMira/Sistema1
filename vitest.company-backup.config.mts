import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  envDir: false,
  cacheDir: 'tests/backup-company/.scratch/vite',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/backup-company/**/*.test.ts'],
    environment: 'node',
    setupFiles: [],
    globalSetup: [],
    cache: false,
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 5000,
  },
});
