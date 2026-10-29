import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Standalone packaging verification for T5 relay + wizard integration.
export default defineConfig({
  envDir: false,
  css: { postcss: { plugins: [] } },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: [
      'tests/installer/relay-transport.test.ts',
      'tests/installer/installation-wizard.test.tsx',
    ],
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30000,
  },
});
