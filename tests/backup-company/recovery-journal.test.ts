import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { createRecoveryJournal, readRecoveryJournal } from '@/lib/backup-recovery-journal';

it('persists exact preimages and absence without replacing an existing operation', () => {
  const root = path.resolve('tests/backup-company/.scratch/journal-' + crypto.randomUUID());
  const id = crypto.randomUUID();
  const input = { operationId: id, companyId: 'tenant', checksum: 'a'.repeat(64),
    files: [{ key: 'company-config', before: null, after: Buffer.from('Compañía Ñ').toString('base64') }] };
  createRecoveryJournal(root, input);
  expect(readRecoveryJournal(root, id)).toEqual(input);
  expect(() => createRecoveryJournal(root, input)).toThrow();
  expect(readRecoveryJournal(root, id)).toEqual(input);
});
it('rejects damaged journals and traversal before accessing another operation', () => {
  const root = path.resolve('tests/backup-company/.scratch/journal-' + crypto.randomUUID());
  const id = crypto.randomUUID();
  const input = { operationId: id, companyId: 'tenant', checksum: 'a'.repeat(64), files: [] };
  createRecoveryJournal(root, input);
  const target = path.join(root, id + '.json');
  const record = JSON.parse(fs.readFileSync(target, 'utf8'));
  record.payload.companyId = 'changed';
  fs.writeFileSync(target, JSON.stringify(record));
  expect(() => readRecoveryJournal(root, id)).toThrow();
  expect(() => readRecoveryJournal(root, '../outside')).toThrow();
});
