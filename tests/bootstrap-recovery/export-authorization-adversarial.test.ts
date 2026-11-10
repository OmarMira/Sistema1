/**
 * T26 / S4, S15, S18, S19 — the portable EXPORT gate of a recovered installation.
 *
 * Two edges were never pinned:
 *
 *  1. S4/S15: recovery preserves a pre-existing local account (same email,
 *     different id) with its own role. Such an installation must not be able to
 *     export a portable backup while it has no eligible verified, active super
 *     administrator authorized for the company — no promotion is inferred from
 *     having performed a recovery.
 *  2. S18/S19: the export gate re-proves every archived attribution. A partial
 *     or rotated proof fails closed with ARCHIVE_ATTRIBUTION_MISMATCH, and the
 *     stored audit rows are never rewritten to make the export succeed.
 *
 * Only infrastructure is mocked (database rows, storage reader, password
 * verifier). Every decision is production code: `resolvePortableSourceOwner`,
 * `buildPortableRecoveryFile`, `assertPortableSourceIntegrity`,
 * `verifyAuditChain` and the container itself.
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditHistoryDigest, computeAuditHash } from '@/lib/journal-hash';
import { openPortableContainer } from '@/lib/backup-portable';

const state = vi.hoisted(() => ({
  users: [] as Array<Record<string, unknown>>,
  ownerRow: null as Record<string, unknown> | null,
  audits: [] as Array<Record<string, unknown>>,
  journals: [] as Array<Record<string, unknown>>,
  head: null as Record<string, unknown> | null,
  provenance: [] as Array<{ provenance: unknown }>,
  storedText: '' as string,
}));

vi.mock('@/lib/db', () => ({
  db: {
    user: {
      findMany: async () => state.users,
      findUnique: async () => state.ownerRow,
    },
    auditLog: {
      findMany: async () => state.audits.map((row) => ({ ...row })),
    },
    journalEntry: {
      findMany: async () => state.journals.map((row) => ({ ...row })),
    },
    journalChainHead: {
      findUnique: async () => state.head,
    },
    $queryRawUnsafe: async () => state.provenance,
  },
  withCompanyBackupTransaction: async () => {
    throw new Error('the export gate never opens a write transaction');
  },
}));
vi.mock('@/lib/backup-storage', () => ({
  readBackupText: () => ({ data: state.storedText, size: state.storedText.length }),
  readCatalog: () => [],
  writeCatalog: () => undefined,
  publishBackup: () => undefined,
  removeBackupFile: () => undefined,
  readCompanyConfig: () => null,
  validBackupFilename: () => true,
}));
vi.mock('@/lib/auth', () => ({
  hashPassword: async (password: string) => `mock:${password}`,
  verifyPassword: async (password: string, hash: string) => hash === `mock:${password}`,
}));

import { assertPortableSourceIntegrity, buildPortableRecoveryFile } from '@/lib/backup';
import { sealSnapshot } from '@/lib/backup-format';
import { COMPANY_ID, COMPANY_LEGAL_NAME, OWNER, SOURCE_PASSWORD, makeSnapshot } from './helpers';

const FILENAME = `${COMPANY_ID}_backup-2026-01-05.json`;
const LOCAL_ID = 'user-local-registered';
const CREATED_AT = '2026-01-05T10:00:00.000Z';

/** A candidate row exactly as `resolvePortableOwner` selects it. */
function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: OWNER.id,
    email: OWNER.email,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    platformRole: 'super_admin',
    isActive: true,
    emailVerifiedAt: new Date('2026-01-02T00:00:00.000Z'),
    legacyUser: false,
    companyMemberships: [{ companyId: COMPANY_ID }],
    ...overrides,
  };
}

/** The pre-existing local account the recovery reuses (S4): role stays `user`. */
function preservedLocalUser() {
  return candidate({
    id: LOCAL_ID,
    platformRole: 'user',
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
  });
}

/** Audit row sealed over its ORIGINAL attribution, as a legacy deletion leaves it. */
function sealedAudit() {
  const content = {
    id: 'audit-shared', companyId: COMPANY_ID, userId: OWNER.id, action: 'JOURNAL_POSTED',
    entity: 'JournalEntry', entityId: 'entry-1', details: null, previousHash: null,
  };
  return { ...content, createdAt: CREATED_AT, hash: computeAuditHash(content) };
}

/** Production-canonical archive record for the given evidence entries. */
function evidenceRecord(entries: Array<Record<string, unknown>>) {
  const canonical = (entry: Record<string, unknown>) => {
    const out: Record<string, unknown> = { id: entry.id, digest: entry.digest };
    if (entry.projectedUserId !== undefined) out.projectedUserId = entry.projectedUserId;
    if (entry.projectedCompanyId !== undefined) out.projectedCompanyId = entry.projectedCompanyId;
    return out;
  };
  return {
    provenance: {
      schema: 2,
      auditEvidence: entries,
      journalEvidence: [],
      historyDigest: crypto.createHash('sha256')
        .update(JSON.stringify({ audit: entries.map(canonical), journal: [] }))
        .digest('hex'),
    },
  };
}

async function exportPortable(password = SOURCE_PASSWORD, companyId = COMPANY_ID) {
  return buildPortableRecoveryFile({ companyId, filename: FILENAME, password });
}

beforeEach(() => {
  state.users = [];
  state.ownerRow = null;
  state.audits = [];
  state.journals = [];
  state.head = null;
  state.provenance = [];
  const snapshot = makeSnapshot();
  sealSnapshot(snapshot);
  state.storedText = JSON.stringify(snapshot);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('portable export requires an eligible verified super administrator (S4/S15)', () => {
  it('refuses an installation whose only account is the preserved regular user', async () => {
    state.users = [preservedLocalUser()];
    state.ownerRow = { passwordHash: `mock:${SOURCE_PASSWORD}` };

    await expect(exportPortable()).rejects.toThrow(/RECOVERY_OWNER_MISSING/);
    // Recovery never promotes that account: the stored role was not rewritten.
    expect(state.users[0].platformRole).toBe('user');
    expect(state.users).toHaveLength(1);
  });

  it('refuses an unverified, an inactive and a non-member super administrator', async () => {
    const ineligible = [
      candidate({ emailVerifiedAt: null, legacyUser: false }),
      candidate({ isActive: false }),
      candidate({ companyMemberships: [{ companyId: 'company-otra' }] }),
    ];
    for (const row of ineligible) {
      state.users = [row];
      state.ownerRow = { passwordHash: `mock:${SOURCE_PASSWORD}` };
      await expect(exportPortable(), JSON.stringify(row)).rejects.toThrow(/RECOVERY_OWNER_MISSING/);
    }
  });

  it('accepts the legacy grandfathered verification path (control)', async () => {
    state.users = [candidate({ emailVerifiedAt: null, legacyUser: true })];
    state.ownerRow = { passwordHash: `mock:${SOURCE_PASSWORD}` };

    const file = await exportPortable();
    expect(file).not.toBeNull();
    expect(file!.filename).toMatch(/_recovery\.json$/);
    const opened = openPortableContainer(Buffer.from(file!.data, 'base64').toString('utf8'), SOURCE_PASSWORD, {
      ownerUserId: OWNER.id,
      ownerEmail: OWNER.email,
      companyLegalName: COMPANY_LEGAL_NAME,
    });
    expect(opened.payload.owner).toMatchObject({
      ownerUserId: OWNER.id, ownerEmail: OWNER.email, emailVerifiedAt: null, legacyUser: true,
    });
  });
});

describe('the export gate re-proves archived attribution (S18/S19)', () => {
  it('fails closed with ARCHIVE_ATTRIBUTION_MISMATCH instead of rewriting the row', async () => {
    const source = sealedAudit();
    // What the legacy user + company foreign keys left behind: both references
    // are gone, the stored seal still covers the ORIGINAL payload.
    const retained = { ...source, companyId: null, userId: null };
    state.audits = [{ ...retained }];
    const digest = auditHistoryDigest(retained as never);

    // Only the company reference archived: one of the two erased references
    // cannot reproduce the signed payload, so the proof fails.
    state.provenance = [evidenceRecord([{
      id: retained.id, digest, projectedCompanyId: COMPANY_ID,
    }])];
    const before = JSON.stringify(state.audits);
    await expect(assertPortableSourceIntegrity(COMPANY_ID))
      .rejects.toThrow(/RECOVERY_SOURCE_CHAIN_INVALID.*ARCHIVE_ATTRIBUTION_MISMATCH/);
    expect(JSON.stringify(state.audits)).toBe(before);
  });

  it('rejects the COMPLETE archived proof once the installation key is rotated', async () => {
    const source = sealedAudit();
    const retained = { ...source, companyId: null, userId: null };
    state.audits = [{ ...retained }];
    state.provenance = [evidenceRecord([{
      id: retained.id,
      digest: auditHistoryDigest(retained as never),
      projectedCompanyId: COMPANY_ID,
      projectedUserId: OWNER.id,
    }])];
    const before = JSON.stringify(state.audits);

    // Control first: the COMPLETE proof verifies under the key that sealed the
    // row, so the case below cannot pass merely because the projection is
    // already incomplete.
    await expect(assertPortableSourceIntegrity(COMPANY_ID)).resolves.toBeUndefined();
    expect(JSON.stringify(state.audits)).toBe(before);

    // A rotated installation key must invalidate that same proof: the archived
    // label alone certifies nothing, the ORIGINAL seal has to verify with the
    // local key, and nothing may be rewritten to make the export succeed.
    vi.stubEnv('HMAC_SECRET', 'rotated-installation-key-for-this-probe');
    await expect(assertPortableSourceIntegrity(COMPANY_ID))
      .rejects.toThrow(/RECOVERY_SOURCE_CHAIN_INVALID.*ARCHIVE_ATTRIBUTION_MISMATCH/);
    expect(JSON.stringify(state.audits)).toBe(before);
  });

  it('certifies the same row when both erased references are archived (control)', async () => {
    const source = sealedAudit();
    const retained = { ...source, companyId: null, userId: null };
    state.audits = [{ ...retained }];
    state.provenance = [evidenceRecord([{
      id: retained.id,
      digest: auditHistoryDigest(retained as never),
      projectedCompanyId: COMPANY_ID,
      projectedUserId: OWNER.id,
    }])];
    await expect(assertPortableSourceIntegrity(COMPANY_ID)).resolves.toBeUndefined();
  });

  it('still refuses a foreign-signed row with no archived evidence at all', async () => {
    // Same shape, but nothing archived: the gate cannot certify it and must not
    // fall back to "probably fine".
    const source = sealedAudit();
    state.audits = [{ ...source, companyId: null, userId: null }];
    state.provenance = [];
    await expect(assertPortableSourceIntegrity(COMPANY_ID))
      .rejects.toThrow(/RECOVERY_SOURCE_CHAIN_INVALID/);
  });
});
