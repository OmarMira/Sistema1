import { defineConfig } from 'vitest/config';
import path from 'node:path';
// Mock-only admin deletion checks: never load .env, database setup or seeds.
export default defineConfig({
    envDir: false,
    resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
    test: {
        include: ['tests/api/admin-user-deletion.test.ts', 'tests/components/admin-user-deletion.test.tsx'],
        environment: 'jsdom',
        setupFiles: [],
        globalSetup: [],
        fileParallelism: false,
    },
});
