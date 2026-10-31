import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

const consumers = [
  'src/instrumentation.ts',
  'src/lib/db.ts',
  'src/lib/init-runtime.ts',
  'src/lib/api-handler.ts',
  'src/lib/maintenance/cleanupSessions.ts',
  'src/lib/uploads/logo-service.ts',
  'src/lib/services/onboarding.service.ts',
  'src/internal/operation-controller/resources/file-resource.ts',
  'src/app/api/auth/logout/route.ts',
];

it.each(consumers)('%s references a maintenance module that exists for the Next resolver', consumer => {
  const text = fs.readFileSync(consumer, 'utf8');
  const imports = [...text.matchAll(/['"]([^'"\n]*backup-runtime-maintenance(?:\.[a-z]+)?)['"]/g)];
  expect(imports.length).toBeGreaterThan(0);
  for (const [, specifier] of imports) {
    const target = specifier.startsWith('@/')
      ? path.resolve('src', specifier.slice(2))
      : path.resolve(path.dirname(consumer), specifier);
    const candidates = path.extname(target) ? [target] : [target + '.ts', target + '.js', target + '.mjs'];
    expect(candidates.some(candidate => fs.existsSync(candidate)), `${consumer}: ${specifier}`).toBe(true);
  }
});
