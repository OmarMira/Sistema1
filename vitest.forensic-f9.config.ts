import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@/lib/db': path.resolve(__dirname, './tests/helpers/db-bootstraptest.ts'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    env: {
      DATABASE_URL: 'postgresql://postgres:postgrespassword@localhost:5432/accountexpress_bootstraptest?schema=public',
    },
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    fileParallelism: false,
    testTimeout: 15000,
  },
});
