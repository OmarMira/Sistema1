import { defineConfig } from 'vitest/config';
import path from 'path';

// Vitest's test.env only applies to workers, not globalSetup.
// Set DATABASE_URL once here so globalSetup can read it from process.env.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres:postgrespassword@localhost:5432/accountexpress_test?schema=public';
}

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './node_modules/next/dist/compiled/server-only/empty'),
    },
  },
  test: {
    globalSetup: './tests/global-setup.ts',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    fileParallelism: false,
    testTimeout: 15000,
  },
});
