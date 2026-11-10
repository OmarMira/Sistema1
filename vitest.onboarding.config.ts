import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Opt-in component checks: no application globalSetup, database or PDF initialization.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    environment: 'jsdom',
    include: ['tests/components/onboarding-wizard.test.tsx', 'tests/components/page-gate.test.tsx'],
    fileParallelism: false,
    testTimeout: 10000,
  },
});
