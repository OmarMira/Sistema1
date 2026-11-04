import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  envDir: false,
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: ['tests/identity/registration-atomic.integration.test.ts'],
    environment: 'node',
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 25_000,
    hookTimeout: 25_000,
  },
});
