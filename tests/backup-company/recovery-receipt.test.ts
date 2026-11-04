import { expect, it } from 'vitest';
import { recoveryReceiptEvidence } from '@/lib/backup-recovery-receipt.mjs';

it('requires every receipt binding and refuses malformed evidence', () => {
  const journal = { operationId: '11111111-1111-4111-8111-111111111111', companyId: 'tenant', checksum: 'a'.repeat(64), files: [] };
  const receipt = { id: journal.operationId, companyId: 'tenant', action: 'COMPANY_RESTORE_COMMITTED', details: JSON.stringify({ checksum: journal.checksum }) };
  expect(recoveryReceiptEvidence(journal, receipt)).toBe('committed');
  expect(recoveryReceiptEvidence(journal, null)).toBe('absent');
  for (const change of [{ id: 'other' }, { companyId: 'other' }, { action: 'OTHER' }, { details: '{}' }, { details: '{' }]) {
    expect(recoveryReceiptEvidence(journal, { ...receipt, ...change })).toBe('unknown');
  }
});
