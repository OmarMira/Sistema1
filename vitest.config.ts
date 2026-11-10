import { defineConfig } from 'vitest/config';
import path from 'path';

// Vitest's test.env only applies to workers, not globalSetup.
// Set DATABASE_URL once here so globalSetup can read it from process.env.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://postgres:postgrespassword@localhost:5432/accountexpress_test?schema=public';
}

export default defineConfig({
  envDir: false,
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
    // Never pick up stale compiled copies of tests inside build output,
    // frozen review candidate views or other internal directories.
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/.git/**', '**/.worktrees/**',
      'tests/installer/*.test.cjs', 'design/**',
      // Dedicated harnesses with their own config: they refuse to run unless the
      // disposable database is named exactly `accountexpress_bootstraptest`, and
      // that guard must never be weakened to fit this suite's database.
      'tests/startup-migrations/**',
      'tests/portable-recovery-postgres/**',
      'tests/identity/challenge-concurrency.integration.test.ts',
      'tests/identity/independent-contract.integration.test.ts',
      'tests/identity/s7-acceptance.integration.test.ts',
      'tests/identity/clean-deletion.integration.test.ts',
      'tests/identity/registration-atomic.integration.test.ts',
    ],
  },
});
