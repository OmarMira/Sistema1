/**
 * S16/S18/S19 continued (F3) — a RESTORED entry keeps its chain verdict when its
 * mutable workflow status changes later.
 *
 * Portable recovery archives, for every historical row, the canonical digest of
 * the row exactly as it arrived (including its stored HMAC link). `status` is
 * included in that digest, but `status` is LOCAL, MUTABLE state: voiding an
 * entry, a rollback or a reclassification legitimately rewrites it on the
 * destination. The archived evidence described the row BEFORE that workflow
 * action, so a status-only difference used to surface as `ARCHIVE_HASH_MISMATCH`
 * and blocked both `/api/audit/chain-verify` and every new portable export.
 *
 * Pinned here:
 *  (a) a restored entry voided after the recovery still verifies, and the
 *      portable export gate still certifies the installation;
 *  (b) the comparison stays status-ONLY: changing any immutable field (content,
 *      date, reference, stored hash/link, lines, tenant) is still
 *      ARCHIVE_HASH_MISMATCH, including when the status also changed;
 *  (c) stored rows are never rewritten to make verification pass.
 *
 * Fictional rows and a mocked client only: no database, no backup file.
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeEntryHashV2, journalHistoryDigest, type ChainRow } from '@/lib/journal-hash';

const state = vi.hoisted(() => ({
  journals: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
  head: null as Record<string, unknown> | null,
  provenance: [] as Array<{ provenance: unknown }>,
}));

/** Prisma returns exactly the requested columns (and nothing else). */
function project(
  row: Record<string, unknown>,
  select?: Record<string, unknown>,
): Record<string, unknown> {
  if (!select) return { ...row };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (key === 'lines' && Array.isArray(row.lines)) {
      const nested = (select.lines as { select?: Record<string, unknown> } | undefined)?.select;
      out.lines = (row.lines as Array<Record<string, unknown>>).map((line) => project(line, nested));
      continue;
    }
    if (key in row) out[key] = row[key];
  }
  return out;
}

vi.mock('@/lib/db', () => ({
  db: {
    journalEntry: {
      findMany: async (query?: {
        where?: { companyId?: string; OR?: Array<{ status?: string; id?: { in: string[] } }> };
        select?: Record<string, unknown>;
      }) => state.journals
        .filter((row) => !query?.where?.companyId || row.companyId === query.where.companyId)
        .filter((row) => !query?.where?.OR || query.where.OR.some((condition) =>
          condition.status !== undefined
            ? row.status === condition.status
            : condition.id?.in.includes(String(row.id))))
        .map((row) => project(row, query?.select)),
    },
    auditLog: {
      findMany: async (query?: { select?: Record<string, unknown> }) =>
        state.audits.map((row) => project(row, query?.select)),
    },
    journalChainHead: {
      findUnique: async () => state.head,
    },
    $queryRawUnsafe: async () => state.provenance,
  },
}));

import { verifyJournalChain } from '@/lib/journal-hash';
import { assertPortableSourceIntegrity } from '@/lib/backup';

const LOCAL_SECRET = 'destination-hmac-secret-synthetic';
const SOURCE_SECRET = 'source-hmac-secret-synthetic';
const COMPANY = 'company-recovery-test';
const CREATED_AT = '2026-01-05T10:00:00.000Z';

/** A restored entry: sealed by the SOURCE installation, retained verbatim. */
function restoredEntry(overrides: Partial<Record<string, unknown>> = {}): ChainRow {
  const lines = [{ glAccountId: 'gl-accounts-payable', debit: '0.00', credit: '150.00', description: 'compra' }];
  return {
    id: 'entry-restored-1',
    companyId: COMPANY,
    date: new Date(CREATED_AT),
    description: 'Asiento restaurado',
    reference: 'FAC-0001',
    status: 'posted',
    hash: crypto.createHmac('sha256', SOURCE_SECRET).update('entry:entry-restored-1').digest('hex'),
    previousHash: null,
    hashVersion: 'v2',
    lines,
    ...overrides,
  } as unknown as ChainRow;
}

/** Provenance record exactly as `buildRecoveryProvenance` writes it. */
function provenanceRecord(journal: ChainRow[]): { provenance: Record<string, unknown> } {
  const auditEvidence: Array<Record<string, unknown>> = [];
  const journalEvidence = journal
    .map((row) => ({ id: row.id, digest: journalHistoryDigest(row) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    provenance: {
      schema: 2,
      auditEvidence,
      journalEvidence,
      historyDigest: crypto.createHash('sha256')
        .update(JSON.stringify({ audit: auditEvidence, journal: journalEvidence }))
        .digest('hex'),
    },
  };
}

/** Seed the archived evidence of the row AS IT ARRIVED (status `posted`). */
function archiveRestoredEntry(overrides: Partial<Record<string, unknown>> = {}) {
  const archived = restoredEntry();
  const stored = restoredEntry(overrides);
  state.journals = [stored];
  state.audits = [];
  state.head = { lastHash: stored.hash, lastEntryId: stored.id };
  state.provenance = [provenanceRecord([archived])];
  return stored;
}

beforeEach(() => {
  vi.stubEnv('HMAC_SECRET', LOCAL_SECRET);
  state.journals = [];
  state.audits = [];
  state.head = null;
  state.provenance = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a restored entry whose workflow status changed still verifies (F3)', () => {
  it('certifies the entry before any status change (control)', async () => {
    archiveRestoredEntry();
    const verified = await verifyJournalChain(COMPANY);
    expect(verified.valid, verified.reasonCode).toBe(true);
    expect(verified.members).toBe(1);
  });

  it('certifies the restored entry after it was voided', async () => {
    archiveRestoredEntry({ status: 'void' });
    const verified = await verifyJournalChain(COMPANY);
    expect(verified.valid, verified.reasonCode).toBe(true);
    expect(verified.reasonCode).toBeUndefined();
  });

  it('keeps the portable export gate working after a restored entry was voided', async () => {
    archiveRestoredEntry({ status: 'void' });
    await expect(assertPortableSourceIntegrity(COMPANY)).resolves.toBeUndefined();
  });

  it('never rewrites the stored row to make the verdict pass', async () => {
    const stored = archiveRestoredEntry({ status: 'void' });
    const before = JSON.stringify(state.journals);
    const verified = await verifyJournalChain(COMPANY);
    expect(verified.valid).toBe(true);
    expect(JSON.stringify(state.journals)).toBe(before);
    // The stored seal is still the SOURCE one: nothing was re-signed locally.
    expect(state.journals[0].hash).toBe(stored.hash);
    expect(state.journals[0].hash).not.toBe(
      computeEntryHashV2({
        id: stored.id,
        companyId: stored.companyId,
        date: stored.date as Date,
        description: stored.description,
        reference: stored.reference,
        previousHash: stored.previousHash,
        lines: (stored as unknown as { lines: ReturnType<typeof restoredEntry>['lines'] }).lines,
      }),
    );
  });
});

describe('recovered unsealed journal rows remain verifiable without joining the chain', () => {
  function seedUnsealed(status = 'draft', withMember = true) {
    const row = restoredEntry({ id: 'entry-unsealed', status, hash: null, hashVersion: null });
    const member = restoredEntry();
    state.journals = withMember ? [member, row] : [row];
    state.head = withMember ? { lastHash: member.hash, lastEntryId: member.id } : null;
    state.provenance = [provenanceRecord(state.journals as unknown as ChainRow[])];
    return row;
  }

  it.each(['draft', 'pending_review', 'void'])('allows portable export with an archived unsealed %s', async (status) => {
    seedUnsealed(status);
    const before = JSON.stringify(state);
    const verified = await verifyJournalChain(COMPANY);
    expect(verified.valid, verified.reasonCode).toBe(true);
    expect(verified.members).toBe(1);
    expect(verified.totalChecked).toBe(1);
    await expect(assertPortableSourceIntegrity(COMPANY)).resolves.toBeUndefined();
    expect(JSON.stringify(state)).toBe(before);
  });

  it('verifies an archive containing only drafts, without inventing a chain head', async () => {
    seedUnsealed('draft', false);
    const before = JSON.stringify(state);
    const verified = await verifyJournalChain(COMPANY);
    expect(verified.valid, verified.reasonCode).toBe(true);
    expect(verified.members).toBe(0);
    await expect(assertPortableSourceIntegrity(COMPANY)).resolves.toBeUndefined();
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([true, false])('rejects deletion of an archived draft (with chain: %s)', async (withMember) => {
    seedUnsealed('draft', withMember);
    state.journals = state.journals.filter((row) => row.id !== 'entry-unsealed');
    const before = JSON.stringify(state);
    expect(await verifyJournalChain(COMPANY)).toMatchObject({
      valid: false, reasonCode: 'ARCHIVE_MEMBER_MISSING',
    });
    await expect(assertPortableSourceIntegrity(COMPANY))
      .rejects.toThrow(/RECOVERY_SOURCE_CHAIN_INVALID.*ARCHIVE_MEMBER_MISSING/);
    expect(JSON.stringify(state)).toBe(before);
  });

  it.each([true, false])('rejects altered archived draft contents (with chain: %s)', async (withMember) => {
    const row = seedUnsealed('draft', withMember);
    row.lines[0].credit = '999.00';
    const before = JSON.stringify(state);
    expect(await verifyJournalChain(COMPANY)).toMatchObject({
      valid: false, reasonCode: 'ARCHIVE_HASH_MISMATCH',
    });
    await expect(assertPortableSourceIntegrity(COMPANY))
      .rejects.toThrow(/RECOVERY_SOURCE_CHAIN_INVALID.*ARCHIVE_HASH_MISMATCH/);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('rejects an archived draft reference change without mutation', async () => {
    const row = seedUnsealed('draft', false);
    row.reference = 'different-reference';
    const before = JSON.stringify(state);
    expect(await verifyJournalChain(COMPANY)).toMatchObject({
      valid: false, reasonCode: 'ARCHIVE_HASH_MISMATCH',
    });
    await expect(assertPortableSourceIntegrity(COMPANY))
      .rejects.toThrow(/RECOVERY_SOURCE_CHAIN_INVALID.*ARCHIVE_HASH_MISMATCH/);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('does not excuse removing the seal from an archived sealed entry', async () => {
    archiveRestoredEntry({ status: 'void', hash: null });
    state.head = null;
    const before = JSON.stringify(state);
    expect(await verifyJournalChain(COMPANY)).toMatchObject({
      valid: false, reasonCode: 'ARCHIVE_HASH_MISMATCH',
    });
    await expect(assertPortableSourceIntegrity(COMPANY))
      .rejects.toThrow(/RECOVERY_SOURCE_CHAIN_INVALID.*ARCHIVE_HASH_MISMATCH/);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('keeps unarchived drafts outside the local chain', async () => {
    const row = restoredEntry({ status: 'draft', hash: null });
    state.journals = [row];
    const before = JSON.stringify(state);
    expect(await verifyJournalChain(COMPANY)).toMatchObject({ valid: true, members: 0 });
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('only status is tolerated: every immutable field is still compared (F3)', () => {
  const immutableEdits: Array<[string, Partial<Record<string, unknown>>, string]> = [
    ['description', { description: 'Asiento editado despues de recuperar' }, 'ARCHIVE_HASH_MISMATCH'],
    ['reference', { reference: 'FAC-9999' }, 'ARCHIVE_HASH_MISMATCH'],
    ['date', { date: new Date('2026-01-05T10:00:00.001Z') }, 'ARCHIVE_HASH_MISMATCH'],
    ['hash', { hash: 'b'.repeat(64) }, 'ARCHIVE_HASH_MISMATCH'],
    ['companyId', { companyId: 'company-other-tenant' }, 'ARCHIVE_MEMBER_MISSING'],
    [
      'lines',
      { lines: [{ glAccountId: 'gl-accounts-payable', debit: '0.00', credit: '999.00', description: 'compra' }] },
      'ARCHIVE_HASH_MISMATCH',
    ],
    // A rewritten LINK breaks the stored topology before the archive comparison
    // can run, so the row is refused for a structural reason instead. Either way
    // it is NOT certified: the status tolerance never turns a tampered row valid.
    ['previousHash', { previousHash: 'c'.repeat(64) }, 'structural'],
  ];

  it.each(immutableEdits)('rejects a stored %s change (%s)', async (_field, edit, expected) => {
    archiveRestoredEntry(edit);
    const verified = await verifyJournalChain(COMPANY);
    expect(verified.valid).toBe(false);
    if (expected === 'structural') {
      expect(verified.reasonCode).toBeTruthy();
      expect(verified.reasonCode).not.toBeUndefined();
    } else {
      expect(verified.reasonCode).toBe(expected);
    }
  });

  it('rejects an immutable change even when the status changed too', async () => {
    archiveRestoredEntry({ status: 'void', description: 'Asiento editado despues de recuperar' });
    const verified = await verifyJournalChain(COMPANY);
    expect(verified.valid).toBe(false);
    expect(verified.reasonCode).toBe('ARCHIVE_HASH_MISMATCH');
    // The export gate must fail closed for the same reason.
    await expect(assertPortableSourceIntegrity(COMPANY))
      .rejects.toThrow(/RECOVERY_SOURCE_CHAIN_INVALID.*ARCHIVE_HASH_MISMATCH/);
  });
});
