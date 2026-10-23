import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Presentation checks use mocked HTTP only; never load .env or database setup.
export default defineConfig({
  envDir: false,
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: [
      'tests/components/reconciliation-clarity.test.tsx',
      'tests/api/reconciliation-book-balance.test.ts',
    ],
    environment: 'jsdom',
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
  },
});
