import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  test: {
    environment: 'node',
    include: [
      'tests/identity/challenge-concurrency.integration.test.ts',
      'tests/identity/independent-contract.integration.test.ts',
      'tests/identity/s7-acceptance.integration.test.ts',
    ],
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
