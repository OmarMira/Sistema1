import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Regression guard (T37 class 19): the AuditLog <-> User relation was removed
// (migration 20261109010000) so that deleting an account can never erase audit
// attribution again. A stale or regenerated schema/client that reintroduces the
// relation would silently reactivate the ON-DELETE-SET-NULL evidence loss and
// the stale-consumer failures (RESTORE_REFERENCE: AuditLog.userId). This test
// pins the SCHEMA shape; the consumer tests pin the code shape.
function modelBlock(schema: string, model: string): string {
  const match = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`model ${model} not found in schema.prisma`);
  return match[1];
}

it('AuditLog keeps historical scalar references with no live User relation (S18/T37)', () => {
  const schema = fs.readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const auditLog = modelBlock(schema, 'AuditLog');
  expect(auditLog).not.toMatch(/^\s*(user|User)\s*:?.*(User\b.*@relation|@relation.*User\b)/m);
  expect(auditLog).toMatch(/^\s*userId\s+String\?/m);
  expect(auditLog).not.toMatch(/^\s*companyId\s+String\??.*@relation/m);
  const user = modelBlock(schema, 'User');
  expect(user).not.toMatch(/^\s*auditLogs\s/m);
});
