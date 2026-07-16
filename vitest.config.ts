import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    env: {
      DATABASE_URL: 'postgresql://postgres:postgrespassword@localhost:5432/accountexpress_test?schema=public',
    },
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    fileParallelism: false,
  },
});
