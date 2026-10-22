import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Registration regressions must never invoke the database push/seed hooks.
export default defineConfig({
  envDir: false,
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: ['tests/identity/registration-*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
  },
});
