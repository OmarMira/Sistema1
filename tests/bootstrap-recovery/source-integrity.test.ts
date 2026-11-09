import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The portable file archives source chain values instead of re-signing them, so
 * the SOURCE installation must certify its own journal/audit chains with its own
 * keys before exporting. A broken chain aborts the export (fail closed) rather
 * than certifying unverifiable history.
 */
const chain = vi.hoisted(() => ({
  journal: { valid: true, reasonCode: undefined as string | undefined },
  audit: { valid: true, reasonCode: undefined as string | undefined },
  journalCalls: [] as string[],
  auditCalls: [] as unknown[],
}));

vi.mock('@/lib/db', () => ({
  db: {},
  withCompanyBackupTransaction: async () => {
    throw new Error('not used by the integrity gate');
  },
}));

vi.mock('@/lib/journal-hash', () => ({
  buildChainVerdict: () => ({ valid: true }),
  computeAuditHash: () => '',
  verifyJournalChain: async (companyId: string) => {
    chain.journalCalls.push(companyId);
    return {
      ...chain.journal, totalChecked: 0, firstBreak: null, scope: 'global-audit-chain',
      members: 0, legacyRows: 0,
    };
  },
  verifyAuditChain: async (scope: unknown) => {
    chain.auditCalls.push(scope);
    return {
      ...chain.audit, totalChecked: 0, firstBreak: null, scope: 'global-audit-chain',
      members: 0, legacyRows: 0,
    };
  },
}));

import { assertPortableSourceIntegrity } from '@/lib/backup';

beforeEach(() => {
  chain.journal = { valid: true, reasonCode: undefined };
  chain.audit = { valid: true, reasonCode: undefined };
  chain.journalCalls.length = 0;
  chain.auditCalls.length = 0;
});

describe('portable export source integrity', () => {
  it('certifies both chains with the source keys for the exported company', async () => {
    await expect(assertPortableSourceIntegrity('company-1')).resolves.toBeUndefined();
    expect(chain.journalCalls).toEqual(['company-1']);
    expect(chain.auditCalls).toEqual([{ companyId: 'company-1' }]);
  });

  it('refuses to certify a broken journal chain', async () => {
    chain.journal = { valid: false, reasonCode: 'HASH_MISMATCH' };
    await expect(assertPortableSourceIntegrity('company-1'))
      .rejects.toThrow(/RECOVERY_SOURCE_CHAIN_INVALID.*HASH_MISMATCH/);
    // The audit chain is not even consulted: the export stops at the first gap.
    expect(chain.auditCalls).toEqual([]);
  });

  it('refuses to certify a broken audit chain', async () => {
    chain.audit = { valid: false, reasonCode: 'ARCHIVE_HASH_MISMATCH' };
    await expect(assertPortableSourceIntegrity('company-1'))
      .rejects.toThrow(/RECOVERY_SOURCE_CHAIN_INVALID.*ARCHIVE_HASH_MISMATCH/);
  });
});
