import { defineConfig } from 'vitest/config';
import path from 'node:path';

// These suites mock persistence and providers; never run db-push/seed or load .env.
export default defineConfig({
  envDir: false,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './node_modules/next/dist/compiled/server-only/empty'),
    },
  },
  test: {
    globals: true,
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
    include: [
      'tests/api/suggest-role-refresh.test.ts',
      'tests/components/EntityOnboardingModal.test.tsx',
      'tests/components/batch-otro-classification.test.tsx',
    ],
    testTimeout: 15000,
  },
});
