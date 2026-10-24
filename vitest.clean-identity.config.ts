import { defineConfig } from 'vitest/config';
import path from 'node:path';

// No environment files, application DB, SMTP, setup scripts or seeds.
export default defineConfig({
  envDir: false,
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: ['tests/identity/clean-registration.test.ts'],
    environment: 'node',
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
  },
});
