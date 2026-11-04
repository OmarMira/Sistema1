import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: process.cwd(), cache: false });

describe('CI test lint coverage', () => {
  it('analyzes CI tests and rejects a real rule violation instead of ignoring the file', async () => {
    const filePath = 'tests/ci/eslint-probe.test.ts';
    expect(await eslint.isPathIgnored(filePath)).toBe(false);
    expect(await eslint.isPathIgnored('tests/ci/nested/probe.test.ts')).toBe(false);
    const results = await eslint.lintText("const fs = require('node:fs');\n", { filePath });
    expect(results).toHaveLength(1);
    expect(results[0].errorCount).toBe(1);
    expect(results[0].warningCount).toBe(0);
    expect(results[0].messages.map(({ ruleId, severity }) => ({ ruleId, severity })))
      .toEqual([{ ruleId: '@typescript-eslint/no-require-imports', severity: 2 }]);
  }, 120000);

  it('preserves application rules and the other existing exclusions', async () => {
    expect(await eslint.isPathIgnored('src/app/page.tsx')).toBe(false);
    const config = await eslint.calculateConfigForFile('src/app/page.tsx');
    expect(config.rules['local/no-server-import-in-client']).toEqual([2]);
    expect(config.rules['react-hooks/exhaustive-deps']).toEqual([0]);
    for (const filePath of [
      'tests/helpers/factories.ts',
      'tests/reconciliation-review.test.ts',
      'scripts/ci-test-isolated.mjs',
      '.next/server/app/page.js',
    ]) {
      expect(await eslint.isPathIgnored(filePath), filePath).toBe(true);
    }
  }, 120000);
});
