import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Never inherit the default runner's database bootstrap or a usable DB target.
process.env.DATABASE_URL = 'postgresql://blocked:blocked@127.0.0.1:1/never_connect';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, '../src') } },
  test: {
    name: 'pdf-import-offline',
    include: [
      'tests/services/bank-profile-service.test.ts',
      'tests/services/pdf-profile-recovery.test.ts',
      'tests/services/pdf-ai-errors.test.ts',
      'tests/services/import-ai-response-contract.test.ts',
      'tests/file-validation.test.ts',
      'tests/csv-parser.test.ts',
      'tests/ofx-parser.test.ts',
    ],
    globalSetup: [],
    setupFiles: [],
    environment: 'node',
    globals: true,
    isolate: true,
    fileParallelism: false,
  },
});
