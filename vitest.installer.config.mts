import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Explicit filesystem-only checks: no application DB/PDF setup or dotenv.
export default defineConfig({
  envDir: false,
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['tests/installer/**/*.test.ts'],
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 10000,
  },
});
