import { defineConfig } from 'vitest/config';

// Deliberately independent of the application's db-push/seed setup.
export default defineConfig({
  envDir: false,
  test: {
    environment: 'node',
    include: ['tests/identity/*.test.ts'],
    exclude: ['tests/identity/*.integration.test.ts'],
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
  },
});
