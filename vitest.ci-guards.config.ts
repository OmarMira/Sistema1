import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  envDir: false,
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['tests/ci/*.test.ts'],
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
