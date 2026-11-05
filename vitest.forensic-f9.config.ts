import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  envDir: false,
  resolve: {
    alias: {
      '@/lib/db': path.resolve(__dirname, './tests/helpers/db-bootstraptest.ts'),
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    include: ['tests/forensic/hdr1c-memory-backup.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    fileParallelism: false,
    testTimeout: 15000,
  },
});
