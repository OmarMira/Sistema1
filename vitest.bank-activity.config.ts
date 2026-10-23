import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Isolated bank-display checks: no .env, database setup, migrations or seed.
export default defineConfig({
  envDir: false,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  test: {
    include: ['tests/api/bank-activity.test.ts', 'tests/lib/financial-dashboard-monthly.test.ts'],
    environment: 'jsdom',
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false
  }
});
