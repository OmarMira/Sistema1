import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditHistoryDigest, buildChainVerdict, computeAuditHash, computeEntryHashV2,
  journalHistoryDigest, type ChainRow,
} from '@/lib/journal-hash';

const state = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  journals: [] as Array<Record<string, unknown>>,
  head: null as Record<string, unknown> | null,
  provenance: [] as Array<{ provenance: unknown }>,
  evidenceQueryFails: false,
}));

vi.mock('@/lib/db', () => ({
  db: {
    auditLog: {
      findMany: async () => state.audits.map((row) => ({ ...row })),
    },
    journalEntry: {
      findMany: async () => state.journals.map((row) => ({ ...row })),
    },
    journalChainHead: {
      findUnique: async () => state.head,
    },
    $queryRawUnsafe: async () => {
      if (state.evidenceQueryFails) throw new Error('relation "BootstrapRecoveryProvenance" does not exist');
      return state.provenance;
    },
  },
}));

import { verifyAuditChain, verifyJournalChain } from '@/lib/journal-hash';

const LOCAL_SECRET = 'destination-hmac-secret';
const SOURCE_SECRET = 'source-hmac-secret';
const CREATED_AT = '2026-01-05T10:00:00.000Z';

function auditChain(secret: string, id = 'audit-1') {
  const row = {
    id, companyId: 'company-recovery-test', userId: null, action: 'JOURNAL_POSTED',
    entity: 'JournalEntry', entityId: 'entry-1', details: null,
    hash: '', previousHash: null as string | null, createdAt: CREATED_AT,
  };
  row.hash = crypto.createHmac('sha256', secret).update([
    id, row.companyId, '', row.action, row.entity, 'entry-1', '', '',
  ].join('|')).digest('hex');
  return row;
}

function localSuccessor(previousHash: string, id = 'audit-local') {
  const row = {
    id, companyId: 'company-recovery-test', userId: null, action: 'BACKUP_CREATED',
    entity: 'Backup', entityId: id, details: null, hash: '', previousHash,
    createdAt: '2026-02-01T10:00:00.000Z',
  };
  row.hash = computeAuditHash({ ...row, previousHash });
  return row;
}

function journalChain(secret: string, id = 'entry-1'): ChainRow {
  const lines = [{ glAccountId: 'gl-1', debit: '100.00', credit: '0.00', description: 'sale' }];
  return {
    id, companyId: 'company-recovery-test', date: new Date(CREATED_AT),
    description: 'Asiento de origen', reference: null, status: 'posted',
    hash: crypto.createHmac('sha256', secret).update(`entry:${id}`).digest('hex'),
    previousHash: null, hashVersion: 'v2', lines,
  };
}

function provenanceRecord(audit: Array<Record<string, unknown>>, journal: Array<ChainRow>) {
  const auditEvidence = audit
    .map((row) => ({ id: String(row.id), digest: auditHistoryDigest(row as never) }))
    .sort((left, right) => left.id.localeCompare(right.id));
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

beforeEach(() => {
  vi.stubEnv('HMAC_SECRET', LOCAL_SECRET);
  state.audits = [];
  state.journals = [];
  state.head = null;
  state.provenance = [];
  state.evidenceQueryFails = false;
});

describe('provenance-aware audit verification', () => {
  it('verifies archived history under a different source key', async () => {
    state.audits = [auditChain(SOURCE_SECRET)];
    expect((await verifyAuditChain({ companyId: 'company-recovery-test' })).valid).toBe(false);

    state.provenance = [provenanceRecord(state.audits, [])];
    const verified = await verifyAuditChain({ companyId: 'company-recovery-test' });
    expect(verified.valid).toBe(true);
    expect(verified.reasonCode).toBeUndefined();
  });

  it('detects a rewritten or deleted archived row instead of exempting it', async () => {
    const archived = auditChain(SOURCE_SECRET);
    state.audits = [archived];
    state.provenance = [provenanceRecord([archived], [])];

    state.audits = [{ ...archived, details: 'edited after the recovery' }];
    const rewritten = await verifyAuditChain({ companyId: 'company-recovery-test' });
    expect(rewritten.valid).toBe(false);
    expect(rewritten.reasonCode).toBe('ARCHIVE_HASH_MISMATCH');

    state.audits = [];
    const deleted = await verifyAuditChain({ companyId: 'company-recovery-test' });
    expect(deleted.valid).toBe(false);
    expect(deleted.reasonCode).toBe('ARCHIVE_MEMBER_MISSING');
  });

  it('still verifies locally written rows after the archived tail', async () => {
    const archived = auditChain(SOURCE_SECRET);
    const local = localSuccessor(String(archived.hash));
    state.audits = [archived, local];
    state.provenance = [provenanceRecord([archived], [])];
    const verified = await verifyAuditChain({ companyId: 'company-recovery-test' });
    expect(verified.valid).toBe(true);
    expect(verified.members).toBe(2);
  });

  it('fails closed on a provenance record that does not match its own digest', async () => {
    const archived = auditChain(SOURCE_SECRET);
    state.audits = [archived];
    const record = provenanceRecord([archived], []);
    (record.provenance as { historyDigest: string }).historyDigest = 'f'.repeat(64);
    state.provenance = [record];
    const verified = await verifyAuditChain({ companyId: 'company-recovery-test' });
    expect(verified.valid).toBe(false);
    // T12: the record itself is unusable, so the archive is reported as
    // unreadable instead of blaming the stored row with a phantom tamper code.
    // The verdict stays a rejection: no row is exempted and nothing is accepted.
    expect(verified.reasonCode).toBe('ARCHIVE_UNAVAILABLE');
  });

  it('keeps strict local verification when the archive table is unavailable', async () => {
    const archived = auditChain(SOURCE_SECRET);
    state.audits = [archived];
    state.evidenceQueryFails = true;
    const verified = await verifyAuditChain({ companyId: 'company-recovery-test' });
    expect(verified.valid).toBe(false);
    expect(verified.reasonCode).toBe('HASH_MISMATCH');
  });
});

/**
 * T20 / S19 — an archived attribution is a LIVE proof, not a stored opinion, and
 * a row whose company AND user references were erased is proven with both or not
 * at all. These rows are fictional; no database is opened.
 */
function sealedAudit(companyId: string | null, userId: string | null) {
  const content = {
    id: 'audit-shared', companyId, userId, action: 'JOURNAL_POSTED',
    entity: 'JournalEntry', entityId: 'entry-1', details: null, previousHash: null,
  };
  return { ...content, createdAt: CREATED_AT, hash: computeAuditHash(content) };
}

/**
 * Archive record carrying exactly the evidence entries given. The self-digest is
 * computed in the PRODUCTION canonical field order (id, digest, then the optional
 * references), which is also the order PostgreSQL JSONB returns, so the test
 * describes the real serialized shape instead of an incidental key order.
 */
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

describe('archived attribution is re-proved on every audit verification', () => {
  it('accepts both erased references together and refuses a partial or rotated proof', async () => {
    const source = sealedAudit('company-recovery-test', 'user-owner');
    // What the legacy company + user foreign keys left behind: references gone,
    // seal untouched. The stored row is never rewritten.
    const retained = { ...source, companyId: null, userId: null };
    const digest = auditHistoryDigest(retained as never);
    state.audits = [{ ...retained }];

    // Both references archived: the original seal is re-computed and verified.
    state.provenance = [evidenceRecord([{
      id: retained.id, digest, projectedCompanyId: 'company-recovery-test', projectedUserId: 'user-owner',
    }])];
    const verified = await verifyAuditChain({});
    expect(verified.valid).toBe(true);
    expect(verified.firstBreak).toBeNull();

    // Only the company reference archived: reconstructing one of the two cannot
    // reproduce the signed payload, so the verdict must fail.
    state.provenance = [evidenceRecord([{
      id: retained.id, digest, projectedCompanyId: 'company-recovery-test',
    }])];
    const partial = await verifyAuditChain({});
    expect(partial.valid).toBe(false);
    expect(partial.reasonCode).toBe('ARCHIVE_ATTRIBUTION_MISMATCH');
    // The failure names the archived proof, never the reference itself.
    expect(JSON.stringify(partial.firstBreak)).not.toContain('user-owner');
    expect(JSON.stringify(partial.firstBreak)).not.toContain('company-recovery-test');

    // A rotated installation key cannot silently accept the stored label either.
    vi.stubEnv('HMAC_SECRET', 'rotated-installation-key');
    const rotated = await verifyAuditChain({});
    expect(rotated.valid).toBe(false);
    expect(rotated.reasonCode).toBe('ARCHIVE_ATTRIBUTION_MISMATCH');
  });

  it('certifies a company-only erased reference for a row that still names its author', async () => {
    const source = sealedAudit('company-recovery-test', 'user-owner');
    const retained = { ...source, companyId: null };
    state.audits = [{ ...retained }];
    state.provenance = [evidenceRecord([{
      id: retained.id,
      digest: auditHistoryDigest(retained as never),
      projectedCompanyId: 'company-recovery-test',
    }])];
    const verified = await verifyAuditChain({ companyId: 'company-recovery-test' });
    expect(verified.valid, JSON.stringify(verified.firstBreak)).toBe(true);
  });

  it('keeps records written before projectedCompanyId existed verifiable', async () => {
    // Exact legacy shape: {id, digest} with no optional field materialized.
    const archived = auditChain(SOURCE_SECRET);
    state.audits = [archived];
    state.provenance = [evidenceRecord([{ id: archived.id, digest: auditHistoryDigest(archived as never) }])];
    const verified = await verifyAuditChain({});
    expect(verified.valid, JSON.stringify(verified.firstBreak)).toBe(true);
  });
});

describe('provenance-aware journal verification', () => {
  it('verifies an archived journal entry and detects tampering', async () => {
    const archived = journalChain(SOURCE_SECRET);
    const tail = { lastHash: archived.hash, lastEntryId: archived.id };
    state.journals = [archived];
    state.head = tail;
    state.provenance = [provenanceRecord([], [archived])];
    const verified = await verifyJournalChain('company-recovery-test');
    expect(verified.valid).toBe(true);

    state.journals = [{ ...archived, description: 'rewritten' }];
    const tampered = await verifyJournalChain('company-recovery-test');
    expect(tampered.valid).toBe(false);
    expect(tampered.reasonCode).toBe('ARCHIVE_HASH_MISMATCH');
  });

  it('rejects a forged topology even with archived evidence', async () => {
    const archived = journalChain(SOURCE_SECRET);
    const forged = { ...journalChain(SOURCE_SECRET, 'entry-2'), previousHash: null };
    state.journals = [archived, forged];
    state.head = { lastHash: forged.hash, lastEntryId: forged.id };
    state.provenance = [provenanceRecord([], [archived, forged])];
    const verdict = buildChainVerdict('company-recovery-test', state.journals as unknown as ChainRow[], null);
    expect(verdict.valid).toBe(false);
    expect(verdict.reasonCode).toBe('CHAIN_ROOT_COUNT');
    const verified = await verifyJournalChain('company-recovery-test');
    expect(verified.valid).toBe(false);
  });

  it('keeps local (non-portable) verification unchanged without an archive', async () => {
    const draft = journalChain(LOCAL_SECRET);
    const local = {
      ...draft,
      hash: computeEntryHashV2({
        id: draft.id, companyId: draft.companyId, date: draft.date,
        description: draft.description, reference: draft.reference,
        previousHash: draft.previousHash, lines: draft.lines as never,
      }),
    };
    state.journals = [local];
    state.head = { lastHash: local.hash, lastEntryId: local.id };
    expect((await verifyJournalChain('company-recovery-test')).valid).toBe(true);
  });
});
