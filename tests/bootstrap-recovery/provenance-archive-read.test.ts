import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditHistoryDigest, computeAuditHash, computeEntryHashV2, journalHistoryDigest, type ChainRow,
} from '@/lib/journal-hash';

/**
 * T12 (S9-S14) — synthetic diagnosis of the two failures reported together:
 *
 *   RECOVERY_SOURCE_CHAIN_INVALID: ... (HASH_MISMATCH)
 *   relation "BootstrapRecoveryProvenance" does not exist
 *
 * These tests use FICTIONAL rows and a mocked client: no ambient database, no
 * real backup, no credential. The mock reproduces ONE property the earlier
 * mocks did not: Prisma returns only the columns named in `select`. That is what
 * a real runtime does, and it is where the archive-aware audit path breaks.
 *
 * The rule under test is not "make verification pass": a genuinely corrupt or
 * foreign-signed chain must stay rejected. What must change is that an archive
 * the machine cannot READ is reported as unreadable instead of being silently
 * downgraded to a tamper verdict.
 */

const state = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  journals: [] as Array<Record<string, unknown>>,
  head: null as Record<string, unknown> | null,
  provenance: [] as Array<{ provenance: unknown }>,
  rawError: null as unknown,
}));

/** Prisma returns exactly the requested columns, and nothing else. */
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
    auditLog: {
      findMany: async (query?: { select?: Record<string, unknown> }) =>
        state.audits.map((row) => project(row, query?.select)),
    },
    journalEntry: {
      findMany: async (query?: { select?: Record<string, unknown> }) =>
        state.journals.map((row) => project(row, query?.select)),
    },
    journalChainHead: {
      findUnique: async () => state.head,
    },
    $queryRawUnsafe: async () => {
      if (state.rawError) throw state.rawError;
      return state.provenance;
    },
  },
}));

import { verifyAuditChain, verifyJournalChain } from '@/lib/journal-hash';
import { assertPortableSourceIntegrity } from '@/lib/backup';

const LOCAL_SECRET = 'destination-hmac-secret-synthetic';
const SOURCE_SECRET = 'source-hmac-secret-synthetic';
const COMPANY = 'company-recovery-test';
const CREATED_AT = '2026-01-05T10:00:00.000Z';

function sourceAuditRow(id = 'audit-source-1') {
  const row: Record<string, unknown> = {
    id,
    companyId: COMPANY,
    userId: null,
    action: 'JOURNAL_POSTED',
    entity: 'JournalEntry',
    entityId: 'entry-1',
    details: null,
    previousHash: null,
    createdAt: CREATED_AT,
  };
  row.hash = crypto.createHmac('sha256', SOURCE_SECRET).update([
    id, COMPANY, '', 'JOURNAL_POSTED', 'JournalEntry', 'entry-1', '', '',
  ].join('|')).digest('hex');
  return row;
}

function localAuditRow(id = 'audit-local-1') {
  const payload = {
    id,
    companyId: COMPANY,
    userId: null,
    action: 'BACKUP_CREATED',
    entity: 'Backup',
    entityId: 'backup-1',
    details: null,
    previousHash: null,
  };
  return { ...payload, createdAt: '2026-02-01T10:00:00.000Z', hash: computeAuditHash(payload) };
}

function sourceJournalRow(id = 'entry-source-1'): ChainRow {
  const lines = [{ glAccountId: 'gl-1', debit: '100.00', credit: '0.00', description: 'venta' }];
  return {
    id,
    companyId: COMPANY,
    date: new Date(CREATED_AT),
    description: 'Asiento de origen',
    reference: null,
    status: 'posted',
    hash: crypto.createHmac('sha256', SOURCE_SECRET).update(`entry:${id}`).digest('hex'),
    previousHash: null,
    hashVersion: 'v2',
    lines,
  };
}

function localJournalRow(id = 'entry-local-1'): ChainRow {
  const lines = [{ glAccountId: 'gl-1', debit: '250.00', credit: '0.00', description: 'venta local' }];
  const row = {
    id,
    companyId: COMPANY,
    date: new Date(CREATED_AT),
    description: 'Asiento local',
    reference: null,
    status: 'posted',
    hash: null as string | null,
    previousHash: null as string | null,
    hashVersion: 'v2',
    lines,
  };
  row.hash = computeEntryHashV2({
    id: row.id,
    companyId: row.companyId,
    date: row.date,
    description: row.description,
    reference: row.reference,
    previousHash: row.previousHash,
    lines,
  });
  return row as unknown as ChainRow;
}

/** A provenance record exactly as `buildRecoveryProvenance` writes it. */
function provenanceRecord(
  audit: Array<Record<string, unknown>>,
  journal: ChainRow[],
): { provenance: Record<string, unknown> } {
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

/** The reported production shape: PostgreSQL undefined_table for the migration. */
function missingTableError(): Error {
  const error = new Error('relation "BootstrapRecoveryProvenance" does not exist') as Error & {
    code?: string;
    meta?: { code?: string; message?: string };
  };
  error.code = 'P2010';
  error.meta = { code: '42P01', message: 'relation "BootstrapRecoveryProvenance" does not exist' };
  return error;
}

beforeEach(() => {
  vi.stubEnv('HMAC_SECRET', LOCAL_SECRET);
  state.audits = [];
  state.journals = [];
  state.head = null;
  state.provenance = [];
  state.rawError = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('archive-aware audit verification reads the columns its digest covers', () => {
  it('certifies an archived audit row with the source key', async () => {
    const archived = sourceAuditRow();
    state.audits = [archived];
    state.provenance = [provenanceRecord([archived], [])];

    const verified = await verifyAuditChain({ companyId: COMPANY });
    expect(verified.valid).toBe(true);
    expect(verified.reasonCode).toBeUndefined();
    expect(verified.members).toBe(1);
  });

  it('still rejects an archived audit row rewritten after the recovery', async () => {
    const archived = sourceAuditRow();
    state.audits = [{ ...archived, details: 'editado despues de recuperar' }];
    state.provenance = [provenanceRecord([archived], [])];

    const verified = await verifyAuditChain({ companyId: COMPANY });
    expect(verified.valid).toBe(false);
    expect(verified.reasonCode).toBe('ARCHIVE_HASH_MISMATCH');
  });

  it('leaves the stored rows untouched when it rejects', async () => {
    const archived = sourceAuditRow();
    const rewritten = { ...archived, action: 'EDITADO' };
    state.audits = [rewritten];
    state.provenance = [provenanceRecord([archived], [])];
    const before = JSON.stringify(state.audits);

    const verified = await verifyAuditChain({ companyId: COMPANY });
    expect(verified.valid).toBe(false);
    expect(JSON.stringify(state.audits)).toBe(before);
  });
});

describe('an unreadable recovery archive is reported, not disguised as tampering', () => {
  it('reports an unreadable audit archive instead of HASH_MISMATCH', async () => {
    const archived = sourceAuditRow();
    state.audits = [archived];
    state.provenance = [provenanceRecord([archived], [])];
    state.rawError = new Error('Connection terminated unexpectedly');

    const audit = await verifyAuditChain({ companyId: COMPANY });
    expect(audit.valid).toBe(false);
    expect(audit.reasonCode).toBe('ARCHIVE_UNAVAILABLE');
  });

  it('reports an unreadable journal archive instead of HASH_MISMATCH', async () => {
    const archived = sourceJournalRow();
    state.journals = [archived];
    state.head = { lastHash: archived.hash, lastEntryId: archived.id };
    state.provenance = [provenanceRecord([], [archived])];
    state.rawError = new Error('Connection terminated unexpectedly');

    const journal = await verifyJournalChain(COMPANY);
    expect(journal.valid).toBe(false);
    expect(journal.reasonCode).toBe('ARCHIVE_UNAVAILABLE');
  });

  it('fails closed when a provenance record does not match its own digest', async () => {
    const archived = sourceAuditRow();
    state.audits = [archived];
    const record = provenanceRecord([archived], []);
    (record.provenance as { historyDigest: string }).historyDigest = 'f'.repeat(64);
    state.provenance = [record];

    const verified = await verifyAuditChain({ companyId: COMPANY });
    expect(verified.valid).toBe(false);
    expect(verified.reasonCode).toBe('ARCHIVE_UNAVAILABLE');
  });
});

describe('a missing provenance table stays "no archive" (reported production shape)', () => {
  it('keeps strict local verification of a local audit chain', async () => {
    state.audits = [localAuditRow()];
    state.rawError = missingTableError();

    const verified = await verifyAuditChain({ companyId: COMPANY });
    expect(verified.valid).toBe(true);
    expect(verified.reasonCode).toBeUndefined();
  });

  it('still rejects a local audit row that does not match the local key', async () => {
    state.audits = [{ ...localAuditRow(), details: 'manipulado' }];
    state.rawError = missingTableError();

    const verified = await verifyAuditChain({ companyId: COMPANY });
    expect(verified.valid).toBe(false);
    expect(verified.reasonCode).toBe('HASH_MISMATCH');
  });

  it('keeps strict local verification of a local journal chain', async () => {
    const local = localJournalRow();
    state.journals = [local];
    state.head = { lastHash: local.hash, lastEntryId: local.id };
    state.rawError = missingTableError();

    expect((await verifyJournalChain(COMPANY)).valid).toBe(true);
  });

  it('cannot certify source-signed history without the archive (honest limit)', async () => {
    // A recovered installation whose migration was never applied: the archive
    // that alone can certify those rows is gone. Rejecting is the ONLY correct
    // answer; no key is invented and the rows are never re-signed.
    const archived = sourceJournalRow();
    state.journals = [archived];
    state.head = { lastHash: archived.hash, lastEntryId: archived.id };
    state.rawError = missingTableError();

    const journal = await verifyJournalChain(COMPANY);
    expect(journal.valid).toBe(false);
    expect(journal.reasonCode).toBe('HASH_MISMATCH');
  });
});

/**
 * The gate the reported POST /api/backup goes through. This is the question the
 * operator actually asked: does the missing table, by itself, block creation?
 */
describe('portable export gate vs the reported production shape', () => {
  it('lets a locally signed installation export while the archive table is absent', async () => {
    state.audits = [localAuditRow()];
    const local = localJournalRow();
    state.journals = [local];
    state.head = { lastHash: local.hash, lastEntryId: local.id };
    state.rawError = missingTableError();

    // No HASH_MISMATCH and no provenance error: creation is not blocked by the
    // absent table when the installation never recovered foreign history.
    await expect(assertPortableSourceIntegrity(COMPANY)).resolves.toBeUndefined();
  });

  it('names an unreadable archive instead of a tamper code', async () => {
    const archived = sourceJournalRow();
    state.journals = [archived];
    state.head = { lastHash: archived.hash, lastEntryId: archived.id };
    state.provenance = [provenanceRecord([], [archived])];
    state.rawError = new Error('Connection terminated unexpectedly');

    await expect(assertPortableSourceIntegrity(COMPANY))
      .rejects.toThrow(/RECOVERY_SOURCE_CHAIN_INVALID.*ARCHIVE_UNAVAILABLE/);
  });

  it('still refuses to certify a chain sealed by another key (fail closed)', async () => {
    state.audits = [localAuditRow()];
    const local = localJournalRow();
    // Same rows, but sealed under a different key than the one in use here.
    const foreign = { ...local, hash: 'a'.repeat(64) };
    state.journals = [foreign];
    state.head = { lastHash: foreign.hash, lastEntryId: foreign.id };
    state.rawError = missingTableError();

    await expect(assertPortableSourceIntegrity(COMPANY))
      .rejects.toThrow(/RECOVERY_SOURCE_CHAIN_INVALID/);
  });
});

describe('PRESERVE — journal archive path and archive-free verification', () => {
  it('certifies an archived journal entry and rejects a rewritten one', async () => {
    const archived = sourceJournalRow();
    state.journals = [archived];
    state.head = { lastHash: archived.hash, lastEntryId: archived.id };
    state.provenance = [provenanceRecord([], [archived])];
    expect((await verifyJournalChain(COMPANY)).valid).toBe(true);

    state.journals = [{ ...archived, description: 'reescrito' }];
    const tampered = await verifyJournalChain(COMPANY);
    expect(tampered.valid).toBe(false);
    expect(tampered.reasonCode).toBe('ARCHIVE_HASH_MISMATCH');
  });

  it('verifies a purely local installation with no recovery archive at all', async () => {
    state.audits = [localAuditRow()];
    const local = localJournalRow();
    state.journals = [local];
    state.head = { lastHash: local.hash, lastEntryId: local.id };

    expect((await verifyAuditChain({ companyId: COMPANY })).valid).toBe(true);
    const journal = await verifyJournalChain(COMPANY);
    expect(journal.valid).toBe(true);
    expect(journal.reasonCode).toBeUndefined();
  });
});
