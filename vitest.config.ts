import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './node_modules/next/dist/compiled/server-only/empty'),
    },
  },
  test: {
    env: {
      DATABASE_URL: 'postgresql://postgres:postgrespassword@localhost:5432/accountexpress_test?schema=public',
    },
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    fileParallelism: false,
    testTimeout: 15000,
  },
});
