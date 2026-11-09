/**
 * T15 — portable owner-verified bootstrap recovery against REAL PostgreSQL.
 *
 * This suite is the executable contract for the two reported blockers:
 *
 *  A. Source-owner authorization must work on a brand-new installation that has
 *     NO local account (the reported RECOVERY_OWNER_UNAVAILABLE 403 before any
 *     token). The owner is proven by the authenticated backup credential and the
 *     single-use token is mailed to the owner address sealed in the file.
 *  B. An installation with ZERO companies but RETAINED audit history (a deleted
 *     company's rows) must be recoverable: every retained audit row survives
 *     BYTE-IDENTICAL, is never re-signed, and the installation-wide audit chain
 *     still verifies afterwards because the recovered source history is certified
 *     by the authenticated recovery archive instead of by a local key it never
 *     had.
 *
 * Everything here is synthetic: a disposable PostgreSQL 16 container built from
 * prisma/migrations (see run.mjs), random credentials, an in-memory mail
 * transport (the token is held in memory and never printed), a scratch runtime
 * directory outside the worktree. No .env, no ambient database, no SMTP/relay,
 * no real backup and no owner credential is read.
 *
 * Run: node tests/portable-recovery-postgres/run.mjs
 */
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { createPortableBackup, assertPortableSourceIntegrity } from '@/lib/backup';
import { appendEntryToJournalChain } from '@/lib/journal-chain';
import { createAuditLogWithRetry } from '@/lib/audit';
import { computeAuditHash, auditHistoryDigest, auditHistoryDigestOf, verifyAuditChain, verifyJournalChain } from '@/lib/journal-hash';
import { restoreCompanyBackupCoordinated } from '@/lib/backup-restore';
import { validateRestoreSource } from '@/lib/backup-validation';
import { openPortableContainer } from '@/lib/backup-portable';
import {
  createMemoryRecoveryChallengeStore, createPostgresRecoveryChallengeStore,
  completePortableRecovery, requestPortableRecoveryChallenge, RECOVERY_POLICY,
  type PortableRecoveryDeps, type RecoveryRawClient,
} from '@/lib/backup-recovery-auth';
import { createMemoryRecoveryLockStore, createPostgresRecoveryLockStore } from '@/lib/backup-recovery-lock';
import { createSession, getSessionCookieName } from '@/lib/sessions';
import {
  createPortableDestinationRestore, createPostgresProvenanceRecorder, loadRecoveryEvidence,
  RecoveryProvenanceError,
  type PortableDestinationClient, type ProvenanceRawClient,
} from '@/lib/backup-recovery-provenance';
import {
  createTestCompany, createTestCompanyMember, createTestGlAccount,
  createTestJournalEntry, createTestUser,
} from '../helpers/factories';

const RECOVERY_PASSWORD = 'Recuperacion-Origen-2026';
const OWNER_EMAIL = 'owner.recovery.t15@example.test';
const LEGAL_NAME = 'Compania Portable T15 S.A.';

const DATABASE_URL = process.env.DATABASE_URL ?? '';

/**
 * The ONLY stub in the HTTP-handler suite: the outgoing mail transport. It keeps
 * the delivered token in memory (never printed, never a provider) so the real
 * workflow can be driven end to end. Nothing else is mocked: the database, the
 * challenge/lock stores, the authorizer, the restore, the validators and the
 * chain proof are the production code on real PostgreSQL.
 */
const httpMail = vi.hoisted(() => ({ sent: [] as Array<{ type?: string; to: string; token: string }> }));
vi.mock('@/lib/backup-recovery-mail', async (importOriginal) => {
  // Keep the real delivery helper (it validates recipient/token and calls the
  // transport) and replace ONLY the transport factory, i.e. the outbound channel.
  const actual = await importOriginal<typeof import('@/lib/backup-recovery-mail')>();
  return {
    ...actual,
    createRecoveryMailTransport: () => ({
      async send(message: { type?: string; to: string; token: string }) {
        httpMail.sent.push({ type: message.type, to: message.to, token: message.token });
      },
    }),
  };
});

/** The isolated database is the only one this suite may ever truncate. */
async function wipeDatabase() {
  const name = DATABASE_URL ? new URL(DATABASE_URL).pathname.replace(/^\//, '') : '';
  if (name !== 'accountexpress_bootstraptest') {
    throw new Error(`wipeDatabase() REFUSED for database "${name}"`);
  }
  const tables = await db.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (tables.length === 0) throw new Error('The disposable fixture has no tables: migrations were not applied');
  await db.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.map((table) => `"${table.tablename}"`).join(', ')} CASCADE`,
  );
}

type SourceAuditRow = {
  id: string; companyId: string | null; userId: string | null; action: string;
  entity: string; entityId: string | null; details: string | null;
  hash: string | null; previousHash: string | null; createdAt: Date;
};

interface SourceBackup {
  fileText: string;
  companyId: string;
  ownerId: string;
  auditIds: string[];
  /**
   * The source installation's own audit row, as stored (T31): lets a case build a
   * destination row that carries the SOURCE seal over other local references.
   */
  auditRow: SourceAuditRow;
  /**
   * T34: an UNSEALED source audit row (`hash === null`, `previousHash === null`),
   * when the case asks for one — the legacy shape whose export copies the event
   * verbatim and whose destination copy carries no seal to re-prove either.
   */
  hashlessAudit: SourceAuditRow | null;
}

/**
 * Build a REAL portable backup from a seeded source installation, exactly like
 * the operator's export path, then leave the database empty.
 *
 * The source installation signs its journal/audit chains with the SOURCE key
 * (`HMAC_SECRET` at capture time). The destination later runs with a different
 * key, which is what makes the archive certification observable.
 *
 * `auditUserId` (T31, default: the source owner) lets a case export a backup whose
 * audit row carries an ERASED actor reference — the shape a legacy
 * `ON DELETE SET NULL` leaves when the account was deleted BEFORE the export, so
 * the seal covers the null-actor payload.
 *
 * `hashlessAudit` (T34) additionally seeds ONE UNSEALED audit row (`hash: null`) of
 * the same company: unsealed legacy rows are exported verbatim and are never
 * re-signed, so a destination that retains the same event has no seal to re-prove
 * either. The sealed row stays, so the source chain remains verifiable.
 */
async function createSourceBackup(
  hmacSecret: string,
  options: { auditUserId?: string | null; hashlessAudit?: boolean } = {},
): Promise<SourceBackup> {
  await wipeDatabase();
  const owner = await createTestUser(OWNER_EMAIL);
  const company = await createTestCompany(LEGAL_NAME);
  await createTestCompanyMember(owner.id, company.id);
  const cash = await createTestGlAccount({
    companyId: company.id, code: '1010', name: 'Caja', accountType: 'asset', normalBalance: 'debit',
  });
  const revenue = await createTestGlAccount({
    companyId: company.id, code: '4010', name: 'Ventas', accountType: 'revenue', normalBalance: 'credit',
  });
  const entry = await createTestJournalEntry(company.id, {
    date: '2025-04-10',
    description: 'Venta de origen',
    lines: [
      { glAccountId: cash.id, debit: 1250.5, credit: 0 },
      { glAccountId: revenue.id, debit: 0, credit: 1250.5 },
    ],
  });

  const saved = process.env.HMAC_SECRET;
  process.env.HMAC_SECRET = hmacSecret;
  try {
    // Only a chain-sealed posted entry is restorable; the seal comes from the
    // same production primitive the journal POST route uses.
    await db.$transaction((tx) => appendEntryToJournalChain(tx, { companyId: company.id, entryId: entry.id }));
    const sourceAudit = await createAuditLogWithRetry({
      companyId: company.id,
      userId: options.auditUserId === undefined ? owner.id : options.auditUserId,
      action: 'JOURNAL_POSTED', entity: 'JournalEntry', entityId: entry.id,
    });
    // T34: a legacy row this installation never sealed. Created AFTER the sealed one,
    // so the source chain keeps exactly one certified root and stays exportable.
    const hashlessAudit = options.hashlessAudit === true
      ? await db.auditLog.create({
          data: {
            companyId: company.id,
            userId: owner.id,
            action: 'JOURNAL_POSTED',
            entity: 'JournalEntry',
            entityId: entry.id,
            details: 'unsealed-legacy-row',
            previousHash: null,
            hash: null,
            createdAt: new Date('2026-01-04T10:00:00.000Z'),
          },
        })
      : null;
    await db.user.update({
      where: { id: owner.id },
      data: {
        passwordHash: await hashPassword(RECOVERY_PASSWORD),
        emailVerifiedAt: new Date('2026-01-02T00:00:00.000Z'),
        platformRole: 'super_admin',
      },
    });
    const portable = await createPortableBackup({
      companyId: company.id, createdByUserId: owner.id, password: RECOVERY_PASSWORD,
    });
    return {
      fileText: Buffer.from(portable.data, 'base64').toString('utf8'),
      companyId: company.id,
      ownerId: owner.id,
      auditIds: [sourceAudit.id],
      auditRow: sourceAudit as unknown as SourceAuditRow,
      hashlessAudit: hashlessAudit as unknown as SourceAuditRow | null,
    };
  } finally {
    if (saved === undefined) delete process.env.HMAC_SECRET;
    else process.env.HMAC_SECRET = saved;
  }
}

interface Harness {
  mail: Array<{ type?: string; to: string; token: string }>;
  store: ReturnType<typeof createMemoryRecoveryChallengeStore>;
  clock: { now: Date };
  deps: PortableRecoveryDeps;
}

/** Workflow wired to the REAL PostgreSQL adapters and the REAL restore path. */
function harness(options: { durableChallengeStore?: boolean; mail?: boolean } = {}): Harness {
  const store = options.durableChallengeStore
    ? createPostgresRecoveryChallengeStore(db as unknown as RecoveryRawClient)
    : createMemoryRecoveryChallengeStore();
  const clock = { now: new Date('2026-03-01T09:00:00.000Z') };
  const mail: Harness['mail'] = [];
  const deps: PortableRecoveryDeps = {
    now: () => clock.now,
    challenges: store,
    lock: createPostgresRecoveryLockStore(db as unknown as RecoveryRawClient),
    // In-memory transport only: the token never leaves this process.
    mail: options.mail === false ? null : {
      async send(message) { mail.push(message as unknown as Harness['mail'][number]); },
    },
    installationState: async () => ({
      companies: await db.company.count(),
      audits: await db.auditLog.count(),
    }),
    restore: createPortableDestinationRestore({
      client: db as unknown as PortableDestinationClient,
      provenance: createPostgresProvenanceRecorder(db as unknown as ProvenanceRawClient),
      hashPassword,
      verifyPassword,
      now: () => clock.now,
      readAuditArchive: async () => {
        try {
          const archive = await loadRecoveryEvidence('audit', null);
          return archive.size > 0 ? archive : undefined;
        } catch (error) {
          if (error instanceof RecoveryProvenanceError && error.code === 'RECOVERY_PROVENANCE_ABSENT') return undefined;
          throw error;
        }
      },
      coordinatedRestore: (companyId, text, mode, identityMap) =>
        restoreCompanyBackupCoordinated(companyId, text, mode, identityMap),
    }),
  };
  return { mail, store: store as unknown as Harness['store'], clock, deps };
}

function request(h: Harness, fileText: string, overrides: Partial<{
  password: string; companyLegalName: string; ownerEmail: string;
}> = {}) {
  return requestPortableRecoveryChallenge(h.deps, {
    fileText,
    password: overrides.password ?? RECOVERY_PASSWORD,
    companyLegalName: overrides.companyLegalName ?? LEGAL_NAME,
    ownerEmail: overrides.ownerEmail ?? OWNER_EMAIL,
  });
}

function complete(h: Harness, fileText: string, token: string, overrides: Partial<{
  password: string; companyLegalName: string; ownerEmail: string;
}> = {}) {
  return completePortableRecovery(h.deps, {
    fileText,
    password: overrides.password ?? RECOVERY_PASSWORD,
    companyLegalName: overrides.companyLegalName ?? LEGAL_NAME,
    ownerEmail: overrides.ownerEmail ?? OWNER_EMAIL,
    token,
  });
}

async function auditSnapshot(): Promise<Record<string, string>> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string; row: string }>>(
    `SELECT id, row_to_json(a)::text AS row FROM "AuditLog" a ORDER BY id`,
  );
  return Object.fromEntries(rows.map((entry) => [entry.id, entry.row]));
}

/** Insert ONE locally signed audit row (a row this installation itself wrote). */
async function insertLocalAudit(input: {
  id: string; companyId: string | null; action: string; previousHash: string | null;
  createdAt: string; secret: string;
}) {
  const row = {
    id: input.id,
    companyId: input.companyId,
    userId: null,
    action: input.action,
    entity: 'Company',
    entityId: null,
    details: null,
    previousHash: input.previousHash,
  };
  const saved = process.env.HMAC_SECRET;
  process.env.HMAC_SECRET = input.secret;
  try {
    const hash = computeAuditHash(row);
    await db.auditLog.create({
      data: { ...row, hash, createdAt: new Date(input.createdAt) },
    });
    return hash;
  } finally {
    if (saved === undefined) delete process.env.HMAC_SECRET;
    else process.env.HMAC_SECRET = saved;
  }
}

/** Mirrors the semantics of `DELETE /api/admin/companies/[id]`: every company
 * child row is removed inside one transaction, the Company row is deleted last,
 * and AuditLog rows are NEVER deleted — they are installation-wide evidence that
 * outlives its company on purpose (S19(c)).
 */
async function deleteCompanyLikeAdminPath(companyId: string) {
  await db.$transaction(async (tx) => {
    await tx.knowledgeAudit.deleteMany({ where: { companyKnowledge: { companyId } } });
    await tx.pendingApproval.deleteMany({ where: { companyId } });
    await tx.companyKnowledge.deleteMany({ where: { companyId } });
    await tx.bankTransaction.deleteMany({ where: { statement: { companyId } } });
    await tx.journalEntry.deleteMany({ where: { companyId } });
    await tx.ruleExecutionAudit.deleteMany({ where: { companyId } });
    await tx.bankRule.deleteMany({ where: { companyId } });
    await tx.bankStatement.deleteMany({ where: { companyId } });
    await tx.bankAccount.deleteMany({ where: { companyId } });
    await tx.entityContext.deleteMany({ where: { companyId } });
    await tx.fiscalPeriod.deleteMany({ where: { companyId } });
    await tx.glAccount.deleteMany({ where: { companyId } });
    await tx.reconciliationPeriod.deleteMany({ where: { companyId } });
    await tx.companyMember.deleteMany({ where: { companyId } });
    await tx.systemMemory.deleteMany({ where: { companyId } });
    await tx.company.delete({ where: { id: companyId } });
  });
}

async function provenanceCount(): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "BootstrapRecoveryProvenance"`,
  );
  return rows[0].n;
}

/** Archived audit evidence of one company (stored digest + attribution). */
async function provenanceEvidence(companyId: string) {
  const rows = await db.$queryRawUnsafe<Array<{
    provenance: { auditEvidence: Array<{ id: string; digest: string; projectedUserId?: string }> };
  }>>(`SELECT provenance FROM "BootstrapRecoveryProvenance" WHERE "companyId" = $1`, companyId);
  return rows[0]?.provenance.auditEvidence ?? [];
}

/**
 * Reproduce the exact pre-migration state in the DISPOSABLE database only: put
 * the SET NULL referential action back, let the real legacy deletion erase the
 * reference, then restore the installed schema (this task's additive migration).
 */
async function deleteOwnerUnderLegacyConstraint(ownerId: string) {
  await db.$executeRawUnsafe(
    `ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey"
       FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL`);
  try {
    await db.user.delete({ where: { id: ownerId } });
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_userId_fkey"`);
  }
}

const DESTINATION_KEY = 'destination-installation-key-t15-not-production';
const SOURCE_KEY = 'source-installation-key-t15-not-production';

beforeAll(async () => {
  const identity = await db.$queryRawUnsafe<Array<{ database: string; version: string }>>(
    `SELECT current_database() AS database, current_setting('server_version') AS version`,
  );
  expect(identity[0].database).toBe('accountexpress_bootstraptest');
  expect(identity[0].version.startsWith('16.')).toBe(true);
  process.env.HMAC_SECRET = DESTINATION_KEY;
});

afterAll(async () => {
  await db.$disconnect().catch(() => {});
});

describe('A. recovery on a brand-new installation (no local account)', () => {
  let source: SourceBackup;

  beforeAll(async () => {
    source = await createSourceBackup(SOURCE_KEY);
    await wipeDatabase();
  });

  it('sends the token to the owner email of the authenticated backup and restores everything', async () => {
    expect(await db.user.count()).toBe(0);
    expect(await db.company.count()).toBe(0);

    const h = harness();
    const requested = await request(h, source.fileText);
    expect(requested.status).toBe('challenge_sent');
    expect(h.mail).toHaveLength(1);
    expect(h.mail[0].to).toBe(OWNER_EMAIL);
    // The token exists only in memory and is never part of the API payload.
    expect(h.mail[0].token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(requested)).not.toContain(h.mail[0].token);

    const completed = await complete(h, source.fileText, h.mail[0].token);
    expect(completed.status, JSON.stringify(completed)).toBe('restored');
    expect(JSON.stringify(completed)).not.toContain(h.mail[0].token);
    expect(JSON.stringify(completed)).not.toContain(RECOVERY_PASSWORD);

    // Accounting data really landed in PostgreSQL.
    expect(await db.company.count()).toBe(1);
    expect(await db.glAccount.count()).toBe(2);
    expect(await db.journalEntry.count()).toBe(1);
    expect(await db.journalLine.count()).toBe(2);
    expect(await db.companyMember.count()).toBe(1);
    const owner = await db.user.findUnique({ where: { id: source.ownerId } });
    expect(owner).toMatchObject({ email: OWNER_EMAIL, platformRole: 'super_admin' });

    // Source history kept its SOURCE hashes: nothing was re-signed.
    for (const id of source.auditIds) {
      const row = await db.auditLog.findUnique({ where: { id } });
      expect(row).not.toBeNull();
      const recomputed = computeAuditHash({
        id: row!.id, companyId: row!.companyId, userId: row!.userId, action: row!.action,
        entity: row!.entity, entityId: row!.entityId, details: row!.details,
        previousHash: row!.previousHash,
      });
      expect(row!.hash).not.toBe(recomputed);
    }

    // Authenticated provenance was archived for exactly this file.
    const provenance = await db.$queryRawUnsafe<Array<{
      fileDigest: string; payloadDigest: string; provenance: { trustBoundary: string; auditEvidence: unknown[] };
    }>>(`SELECT "credentialDigest" AS "fileDigest","sourceDigest" AS "payloadDigest",provenance
          FROM "BootstrapRecoveryProvenance" WHERE "companyId" = $1`, source.companyId);
    expect(provenance).toHaveLength(1);
    expect(provenance[0].fileDigest).toBe(crypto.createHash('sha256').update(source.fileText, 'utf8').digest('hex'));
    expect(provenance[0].payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(provenance[0].provenance.trustBoundary).toMatch(/never re-signed/i);
    expect(provenance[0].provenance.auditEvidence).toHaveLength(1);

    // Post-restore chain verification: the source rows are certified by the
    // archive, so verification is green even though this machine's key differs.
    const journal = await verifyJournalChain(source.companyId);
    expect(journal.valid).toBe(true);
    const audit = await verifyAuditChain({ companyId: source.companyId });
    expect(audit.valid).toBe(true);
    expect(audit.firstBreak).toBeNull();
  });

  it('refuses a replayed token and any second recovery', async () => {
    const before = await auditSnapshot();
    const h = harness();
    const requested = await request(h, source.fileText);
    expect(requested).toMatchObject({ status: 409, code: 'DB_NOT_EMPTY' });
    expect(h.mail).toHaveLength(0);
    expect(await auditSnapshot()).toEqual(before);

    // Even a token minted before the first restore cannot be replayed.
    const stale = harness();
    stale.clock.now = new Date('2026-03-01T09:00:00.000Z');
    const result = await complete(stale, source.fileText, 'a'.repeat(64));
    expect(result).toMatchObject({ status: 409, code: 'DB_NOT_EMPTY' });
  });
});

describe('B. recovery with retained audit history (zero companies)', () => {
  let source: SourceBackup;
  const retainedIds = ['retained-audit-1', 'retained-audit-2', 'retained-audit-3'];

  beforeAll(async () => {
    source = await createSourceBackup(SOURCE_KEY);
    await wipeDatabase();
  });

  it('preserves every retained audit row byte-identical and keeps the installation verifiable', async () => {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    // A company that was deleted, but whose audit rows outlive it (the schema
    // keeps them on purpose), plus one installation-wide row.
    const first = await insertLocalAudit({
      id: retainedIds[0], companyId: 'company-deleted-t15', action: 'COMPANY_CREATED',
      previousHash: null, createdAt: '2026-01-03T10:00:00.000Z', secret: DESTINATION_KEY,
    });
    const second = await insertLocalAudit({
      id: retainedIds[1], companyId: 'company-deleted-t15', action: 'COMPANY_UPDATED',
      previousHash: first, createdAt: '2026-01-03T10:00:01.000Z', secret: DESTINATION_KEY,
    });
    await insertLocalAudit({
      id: retainedIds[2], companyId: null, action: 'GLOBAL_MAINTENANCE',
      previousHash: second, createdAt: '2026-01-03T10:00:02.000Z', secret: DESTINATION_KEY,
    });

    expect(await db.company.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(3);
    const before = await auditSnapshot();

    const h = harness();
    const requested = await request(h, source.fileText);
    expect(requested.status).toBe('challenge_sent');
    const completed = await complete(h, source.fileText, h.mail[0].token);
    expect(completed.status, JSON.stringify(completed)).toBe('restored');

    // Byte-identical retention: exact stored JSON, hash and previousHash intact.
    const after = await auditSnapshot();
    for (const id of retainedIds) {
      expect(after[id]).toBe(before[id]);
    }
    // Nothing re-signed them under another key either.
    const retainedRow = await db.auditLog.findUnique({ where: { id: retainedIds[0] } });
    expect(retainedRow?.hash).toBe(
      await (async () => {
        process.env.HMAC_SECRET = DESTINATION_KEY;
        return computeAuditHash({
          id: retainedIds[0], companyId: 'company-deleted-t15', userId: null,
          action: 'COMPANY_CREATED', entity: 'Company', entityId: null, details: null, previousHash: null,
        });
      })(),
    );

    // Both partitions exist: retained destination history AND the source history.
    expect(await db.company.count()).toBe(1);
    expect(await db.auditLog.count()).toBeGreaterThan(4);

    // Two certified lineages verify because the recovery archive exists; every
    // member is still checked (archive digest or local HMAC).
    const journal = await verifyJournalChain(source.companyId);
    expect(journal.valid).toBe(true);
    const audit = await verifyAuditChain({});
    expect(audit.firstBreak).toBeNull();
    expect(audit.valid).toBe(true);
    // Members = hashed rows: the 3 retained rows plus the 1 recovered source row.
    // The local COMPANY_RESTORE_COMMITTED receipt is an unsealed operational row
    // (legacyRows), exactly as before this change.
    expect(audit.members).toBe(4);
    expect(audit.legacyRows).toBeGreaterThanOrEqual(1);

    // The recovered rows carry the source signatures, so they are NOT locally
    // recomputable: the archive is what certifies them.
    for (const id of source.auditIds) {
      const row = await db.auditLog.findUnique({ where: { id } });
      expect(row?.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(computeAuditHash({
        id: row!.id, companyId: row!.companyId, userId: row!.userId, action: row!.action,
        entity: row!.entity, entityId: row!.entityId, details: row!.details,
        previousHash: row!.previousHash,
      })).not.toBe(row!.hash);
    }
  });

  it('leaves retained history untouched when the recovery is refused', async () => {
    const before = await auditSnapshot();
    const h = harness();
    const wrong = await request(h, source.fileText, { password: 'contrasena-incorrecta' });
    expect(wrong).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
    expect(await auditSnapshot()).toEqual(before);
    expect(await db.company.count()).toBe(1); // the earlier test's company, untouched
  });
});

describe('C. negative outcomes leave accounting, identities and audit unchanged', () => {
  let source: SourceBackup;

  beforeAll(async () => {
    source = await createSourceBackup(SOURCE_KEY);
    await wipeDatabase();
  });

  it('refuses a wrong password, email or company name before any mail', async () => {
    const before = await auditSnapshot();
    for (const overrides of [
      { password: 'contrasena-incorrecta-1' },
      { ownerEmail: 'otra-persona@example.test' },
      { companyLegalName: 'Otra Empresa S.A.' },
    ]) {
      const h = harness();
      const result = await request(h, source.fileText, overrides);
      expect(result).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
      expect(h.mail).toHaveLength(0);
    }
    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
    expect(await auditSnapshot()).toEqual(before);
  });

  it('refuses a tampered file (AEAD authentication) and a legacy version', async () => {
    const header = JSON.parse(source.fileText) as Record<string, unknown>;
    const ciphertext = header.ciphertext as string;
    const tampered = JSON.stringify({
      ...header,
      ciphertext: `${ciphertext.slice(0, 20)}${ciphertext[20] === 'A' ? 'B' : 'A'}${ciphertext.slice(21)}`,
    });
    const h = harness();
    expect(await request(h, tampered)).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
    expect(h.mail).toHaveLength(0);

    const legacy = { ...header, version: 1 };
    delete (legacy as Record<string, unknown>).binding;
    const older = await request(harness(), JSON.stringify(legacy));
    expect(older).toMatchObject({ status: 400, code: 'RECOVERY_FORMAT_UNSUPPORTED' });
    expect(await db.company.count()).toBe(0);
  });

  it('blocks recovery when no mail channel is available, consuming the draft', async () => {
    const h = harness({ mail: false, durableChallengeStore: true });
    const requested = await request(h, source.fileText);
    expect(requested).toMatchObject({ status: 503, code: 'RECOVERY_MAIL_UNAVAILABLE' });
    // The undelivered draft is unusable: no token can be consumed for this file.
    const reuse = await complete(h, source.fileText, 'b'.repeat(64));
    expect(reuse).toMatchObject({ status: 400, code: 'RECOVERY_TOKEN_INVALID' });
    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
  });

  it('refuses an invalid, expired and replayed token without mutating data', async () => {
    const before = await auditSnapshot();
    const h = harness({ durableChallengeStore: true });
    expect(await request(h, source.fileText)).toMatchObject({ status: 'challenge_sent' });
    const token = h.mail[0].token;

    const wrong = await complete(h, source.fileText, 'c'.repeat(64));
    expect(wrong).toMatchObject({ status: 400, code: 'RECOVERY_TOKEN_INVALID' });
    expect(await db.company.count()).toBe(0);

    h.clock.now = new Date(h.clock.now.getTime() + RECOVERY_POLICY.tokenMs + 1000);
    const expired = await complete(h, source.fileText, token);
    expect(expired).toMatchObject({ status: 400, code: 'RECOVERY_TOKEN_EXPIRED' });
    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
    expect(await auditSnapshot()).toEqual(before);
  });

  it('refuses an installation that already has an unrelated company', async () => {
    const unrelated = await createTestCompany('Empresa No Relacionada S.A.');
    const companyRow = await db.company.findUnique({ where: { id: unrelated.id } });
    const before = await auditSnapshot();

    const h = harness();
    const result = await request(h, source.fileText);
    expect(result).toMatchObject({ status: 409, code: 'DB_NOT_EMPTY' });
    expect(h.mail).toHaveLength(0);
    expect(await db.company.count()).toBe(1);
    expect(await db.company.findUnique({ where: { id: unrelated.id } })).toEqual(companyRow);
    expect(await auditSnapshot()).toEqual(before);
    expect(await db.user.count()).toBe(0);
  });

  it('bounds password attempts per file through the PostgreSQL adapter', async () => {
    const store = createPostgresRecoveryChallengeStore(db as unknown as RecoveryRawClient);
    const digest = crypto.randomBytes(32).toString('hex');
    const now = new Date('2026-03-02T00:00:00.000Z');
    const admitted: boolean[] = [];
    for (let attempt = 0; attempt < RECOVERY_POLICY.attempts + 2; attempt += 1) {
      admitted.push(await store.admitPasswordAttempt({ fileDigest: digest, now }));
    }
    expect(admitted).toEqual([true, true, true, true, true, false, false]);
    // The attempt budget writes the PREFIXED subject `bootstrap-recovery:<hex>`
    // into IdentityRateLimit: that is the 23514 regression the widening
    // migration (20261107210000) fixed, so an existing row proves the widened
    // check is installed.
    const limited = await db.$queryRawUnsafe<Array<{ subject: string }>>(
      `SELECT subject FROM "IdentityRateLimit" WHERE subject = $1`, `bootstrap-recovery:${digest}`,
    );
    expect(limited).toHaveLength(1);

    // Security events keep the BARE hex subject (their own constraint) and the
    // uuid cast the auth store installs (42804 regression).
    const bare = crypto.createHash('sha256').update(digest).digest('hex');
    await store.recordEvent('challenge_rejected', bare, now);
    const events = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "IdentitySecurityEvent" WHERE action = 'challenge_rejected' AND subject = $1`,
      bare,
    );
    expect(events[0].n).toBe(1);
  });

  it('enforces single use atomically in PostgreSQL (CAS)', async () => {
    const store = createPostgresRecoveryChallengeStore(db as unknown as RecoveryRawClient);
    const now = new Date('2026-03-02T01:00:00.000Z');
    const fileDigest = crypto.randomBytes(32).toString('hex');
    const digest = crypto.randomBytes(32).toString('hex');
    await store.issue({
      fileDigest, ownerUserId: 'owner-cas', companyId: 'company-cas', tokenDigest: digest,
      expiresAt: new Date(now.getTime() + 60_000), now,
    });
    const first = await store.consume({ fileDigest, ownerUserId: 'owner-cas', tokenDigest: digest, now });
    const second = await store.consume({ fileDigest, ownerUserId: 'owner-cas', tokenDigest: digest, now });
    expect(first).toBe('ok');
    expect(second).toBe('used');
    const foreign = await store.consume({
      fileDigest, ownerUserId: 'other-owner', tokenDigest: digest,
      now: new Date(now.getTime() + 120_000),
    });
    expect(foreign).toBe('mismatch');
  });
});

describe('D. the strict local audit chain contract is not relaxed', () => {
  it('rejects a second lineage when this installation has no recovery archive', async () => {
    await wipeDatabase();
    process.env.HMAC_SECRET = DESTINATION_KEY;
    // Two independent locally signed lineages, exactly what a spliced history
    // looks like. Without a recorded portable recovery there is no evidence that
    // allows a second root, so the verdict must stay invalid.
    const rootOne = await insertLocalAudit({
      id: 'lineage-one-1', companyId: 'company-one', action: 'COMPANY_CREATED',
      previousHash: null, createdAt: '2026-01-04T10:00:00.000Z', secret: DESTINATION_KEY,
    });
    await insertLocalAudit({
      id: 'lineage-one-2', companyId: 'company-one', action: 'COMPANY_UPDATED',
      previousHash: rootOne, createdAt: '2026-01-04T10:00:01.000Z', secret: DESTINATION_KEY,
    });
    await insertLocalAudit({
      id: 'lineage-two-1', companyId: 'company-two', action: 'COMPANY_CREATED',
      previousHash: null, createdAt: '2026-01-04T10:00:02.000Z', secret: DESTINATION_KEY,
    });
    const provenance = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "BootstrapRecoveryProvenance"`,
    );
    expect(provenance[0].n).toBe(0);

    const audit = await verifyAuditChain({});
    expect(audit.valid).toBe(false);
    expect(audit.reasonCode).toBe('CHAIN_ROOT_COUNT');
  });
});

describe('E. PostgreSQL adapters used by the workflow', () => {
  it('keeps the recovery lease exclusive without touching any owner database', async () => {
    const lock = createPostgresRecoveryLockStore(db as unknown as RecoveryRawClient);
    const memory = createMemoryRecoveryLockStore();
    const now = new Date('2026-03-02T02:00:00.000Z');
    expect(await lock.acquire({ holder: 'holder-one', now, ttlMs: 60_000 })).toBe(true);
    expect(await lock.acquire({ holder: 'holder-two', now, ttlMs: 60_000 })).toBe(false);
    await lock.release({ holder: 'holder-one', now });
    expect(await lock.acquire({ holder: 'holder-two', now, ttlMs: 60_000 })).toBe(true);
    await lock.release({ holder: 'holder-two', now });
    // The in-memory twin keeps the same contract (used by the unit suites).
    expect(await memory.acquire({ holder: 'a', now, ttlMs: 60_000 })).toBe(true);
    expect(memory.describe()).not.toBeNull();
  });
});

/**
 * T17 / S16 — the reported blocker. A REAL portable backup is created from this
 * installation, the company is deleted exactly like the admin path (audit rows
 * outlive it), and the same file is restored INTO THE SAME DATABASE. The retained
 * source audit rows overlap the snapshot by id; they must be reused (one copy per
 * event), never duplicated and never rewritten.
 */
describe('F. same installation: retained source audit rows overlap the snapshot', () => {
  let source: SourceBackup;
  let retainedBefore: Record<string, string>;

  beforeAll(async () => {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    source = await createSourceBackup(DESTINATION_KEY);
    retainedBefore = await auditSnapshot();
  });

  it('reuses the retained audit event instead of duplicating it', async () => {
    expect(source.auditIds).toHaveLength(1);
    await deleteCompanyLikeAdminPath(source.companyId);

    // The deletion leaves zero companies and keeps the source's audit rows
    // byte-identical — exactly the state the operator's installation reported.
    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(1);
    expect(await auditSnapshot()).toEqual(retainedBefore);

    const h = harness();
    const requested = await request(h, source.fileText);
    expect(requested.status).toBe('challenge_sent');
    const completed = await complete(h, source.fileText, h.mail[0].token);
    expect(completed.status, JSON.stringify(completed)).toBe('restored');

    // Accounting history is back.
    expect(await db.company.count()).toBe(1);
    expect(await db.glAccount.count()).toBe(2);
    expect(await db.journalEntry.count()).toBe(1);
    expect(await db.journalLine.count()).toBe(2);
    expect(await db.companyMember.count()).toBe(1);

    // One copy per event: the shared ids were REUSED, not re-inserted, and every
    // retained row is byte-identical to what survived the deletion.
    const after = await auditSnapshot();
    for (const id of Object.keys(retainedBefore)) {
      expect(after[id]).toBe(retainedBefore[id]);
    }
    for (const id of source.auditIds) {
      const rows = await db.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM "AuditLog" WHERE id = $1`, id,
      );
      expect(rows[0].n).toBe(1);
    }
    // Only the new local commit receipt was added.
    expect(Object.keys(after).sort()).toEqual([...Object.keys(retainedBefore), completed.operationId].sort());

    // The archive certifies exactly the rows that are STORED (the reused event
    // keeps its authenticated content, so its digest is the retained digest).
    const provenance = await db.$queryRawUnsafe<Array<{
      companyId: string; provenance: { auditEvidence: Array<{ id: string; digest: string }>; identityMap: Record<string, string> };
    }>>(`SELECT "companyId", provenance FROM "BootstrapRecoveryProvenance"`);
    expect(provenance).toHaveLength(1);
    const evidence = new Map(provenance[0].provenance.auditEvidence.map((entry) => [entry.id, entry.digest]));
    expect([...evidence.keys()].sort()).toEqual([...source.auditIds].sort());
    for (const id of source.auditIds) {
      const stored = await db.auditLog.findUnique({ where: { id } });
      expect(evidence.get(id)).toBe(auditHistoryDigest(stored as never));
    }
    expect(provenance[0].provenance.identityMap).toEqual({});

    // Both installation-wide verdicts stay valid after the recovery.
    const journal = await verifyJournalChain(source.companyId);
    expect(journal.valid).toBe(true);
    const audit = await verifyAuditChain({ companyId: source.companyId });
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
    expect(audit.firstBreak).toBeNull();
    expect(audit.members).toBe(1);
  });
});

/**
 * Same installation, but the retained row is NOT the authenticated event: an id
 * match with different canonical content must stay a refusal (data unchanged).
 */
describe('G. same installation: a same-id row that is not the authenticated event', () => {
  it('refuses the collision and leaves retained history untouched', async () => {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    const source = await createSourceBackup(DESTINATION_KEY);
    await deleteCompanyLikeAdminPath(source.companyId);
    // A different event under the source id (rewritten details): the retained
    // content no longer equals the authenticated snapshot in every field.
    await db.$executeRawUnsafe(
      `UPDATE "AuditLog" SET details = 'rewritten before recovery' WHERE id = $1`, source.auditIds[0],
    );
    const before = await auditSnapshot();
    expect(await db.company.count()).toBe(0);
    const provenanceBefore = await provenanceCount();

    const h = harness();
    expect((await request(h, source.fileText)).status).toBe('challenge_sent');
    const completed = await complete(h, source.fileText, h.mail[0].token);
    expect(completed).toMatchObject({ status: 400, code: 'RECOVERY_RESTORE_REFUSED' });
    expect(JSON.stringify(completed)).toMatch(/RESTORE_ID_CONFLICT/);

    // Fail closed: no company shell survived, no duplicate history, no archive.
    expect(await db.company.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(Object.keys(before).length);
    expect(await auditSnapshot()).toEqual(before);
    expect(await provenanceCount()).toBe(provenanceBefore);
    // The token stays spent; recovery must be re-authorized.
    expect(h.store.describe().challenges[0].usedAt).not.toBeNull();
  });
});

/**
 * T19 / S18 — account deletion, reproduced on the real PostgreSQL adapter.
 *
 * Two distinct states are proven, because they are not the same fact:
 *
 *  (1) FUTURE INVARIANT. `20261109010000_immutable_audit_user_reference` drops
 *      `AuditLog_userId_fkey` (ON DELETE SET NULL), following the same precedent as
 *      the already-dropped company reference. Deleting the account then leaves the
 *      signed `userId` untouched, so the stored HMAC still verifies locally.
 *
 *  (2) LEGACY DRIFT ALREADY STORED. Under the old constraint the reference was
 *      erased while the seal kept covering the original payload. That row is still
 *      the authenticated event, and the recovery certifies it by re-computing the
 *      ORIGINAL signature with the authenticated source attribution — never by
 *      re-signing, deleting or relabelling anything.
 */
describe('H. account deletion and retained audit attribution', () => {
  const LEGACY_CONSTRAINT = 'AuditLog_userId_fkey';

  it('keeps the signed attribution when the account is deleted after the migration', async () => {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    // The additive migration really removed the referential action from the
    // installed schema: this is the future-proof half of S18.
    const constraint = await db.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conname = $1`, LEGACY_CONSTRAINT);
    expect(constraint).toHaveLength(0);

    const source = await createSourceBackup(DESTINATION_KEY);
    const rowBefore = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(rowBefore?.userId).toBe(source.ownerId);

    await deleteCompanyLikeAdminPath(source.companyId);
    await db.user.delete({ where: { id: source.ownerId } });

    // Attribution is immutable evidence now: the account delete does not touch it.
    const rowAfter = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(rowAfter?.userId).toBe(source.ownerId);
    expect(rowAfter?.hash).toBe(rowBefore?.hash);
    expect(computeAuditHash({ ...rowAfter! })).toBe(rowAfter!.hash);

    // Recovery still works, and it needs no projection: the event is verbatim.
    const before = await auditSnapshot();
    const h = harness();
    expect((await request(h, source.fileText)).status).toBe('challenge_sent');
    const completed = await complete(h, source.fileText, h.mail[0].token);
    expect(completed.status, JSON.stringify(completed)).toBe('restored');

    expect(await db.company.count()).toBe(1);
    const after = await auditSnapshot();
    for (const id of Object.keys(before)) expect(after[id]).toBe(before[id]);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), completed.operationId].sort());

    const stored = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(await provenanceEvidence(source.companyId)).toEqual([
      { id: source.auditIds[0], digest: auditHistoryDigest(stored as never) },
    ]);

    expect((await verifyJournalChain(source.companyId)).valid).toBe(true);
    const audit = await verifyAuditChain({ companyId: source.companyId });
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
    expect(audit.firstBreak).toBeNull();
  });

  it('restores a real backup after the owner was deleted under the legacy constraint', async () => {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    const source = await createSourceBackup(DESTINATION_KEY);
    const rowBefore = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(rowBefore?.userId).toBe(source.ownerId);

    await deleteCompanyLikeAdminPath(source.companyId);
    await deleteOwnerUnderLegacyConstraint(source.ownerId);

    const drifted = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(drifted?.userId).toBeNull();
    expect(drifted?.hash).toBe(rowBefore?.hash);
    // Real pre-existing drift: the seal no longer matches the row as it stands...
    expect(computeAuditHash({ ...drifted! })).not.toBe(drifted!.hash);
    // ...but it still verifies with the authenticated source attribution.
    expect(computeAuditHash({ ...drifted!, userId: source.ownerId })).toBe(drifted!.hash);
    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(0);

    const before = await auditSnapshot();
    const h = harness();
    expect((await request(h, source.fileText)).status).toBe('challenge_sent');
    const completed = await complete(h, source.fileText, h.mail[0].token);
    expect(completed.status, JSON.stringify(completed)).toBe('restored');

    // The original accounting data, identity and membership are back.
    expect(await db.company.count()).toBe(1);
    expect(await db.glAccount.count()).toBe(2);
    expect(await db.journalEntry.count()).toBe(1);
    expect(await db.journalLine.count()).toBe(2);
    expect(await db.user.findUnique({ where: { id: source.ownerId } })).toMatchObject({ email: OWNER_EMAIL });
    expect(await db.companyMember.count()).toBe(1);

    // Every retained row survives BYTE-IDENTICAL, one copy per event, and only the
    // local commit receipt is new: nothing was re-signed or relabelled.
    const after = await auditSnapshot();
    for (const id of Object.keys(before)) expect(after[id]).toBe(before[id]);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), completed.operationId].sort());
    const copies = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "AuditLog" WHERE id = $1`, source.auditIds[0]);
    expect(copies[0].n).toBe(1);

    // The archive keeps the ACTUAL stored digest AND the verified attribution; the
    // stored row is never relabelled as if the null had been signed.
    const stored = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(stored?.userId).toBeNull();
    expect(await provenanceEvidence(source.companyId)).toEqual([
      { id: source.auditIds[0], digest: auditHistoryDigest(stored as never), projectedUserId: source.ownerId },
    ]);

    // Both installation-wide chains verify afterwards.
    expect((await verifyJournalChain(source.companyId)).valid).toBe(true);
    const audit = await verifyAuditChain({ companyId: source.companyId });
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
    expect(audit.firstBreak).toBeNull();
    expect(audit.members).toBe(1);
  });

  it('refuses a nulled reference whose content was rewritten, mutating nothing', async () => {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    const source = await createSourceBackup(DESTINATION_KEY);
    await deleteCompanyLikeAdminPath(source.companyId);
    await deleteOwnerUnderLegacyConstraint(source.ownerId);
    // A different event under the same id: the nulled reference cannot explain it.
    await db.$executeRawUnsafe(
      `UPDATE "AuditLog" SET details = 'rewritten after the deletion' WHERE id = $1`, source.auditIds[0]);

    const before = await auditSnapshot();
    const provenanceBefore = await provenanceCount();
    const h = harness();
    expect((await request(h, source.fileText)).status).toBe('challenge_sent');
    const completed = await complete(h, source.fileText, h.mail[0].token);
    expect(completed).toMatchObject({ status: 400, code: 'RECOVERY_RESTORE_REFUSED' });
    expect(JSON.stringify(completed)).toMatch(/RESTORE_ID_CONFLICT/);

    expect(await auditSnapshot()).toEqual(before);
    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
    expect(await db.companyMember.count()).toBe(0);
    expect(await provenanceCount()).toBe(provenanceBefore);
    // The token stays spent; recovery must be re-authorized.
    expect(h.store.describe().challenges[0].usedAt).not.toBeNull();
  });
});

let postBootstrapRestoreHandler: typeof import('@/app/api/bootstrap/restore/route')['POST'] | undefined;

/** Invoke the PRODUCTION handler as a function: no server, no socket, no port. */
async function postBootstrapRestore(body: Record<string, unknown>) {
  if (!postBootstrapRestoreHandler) {
    ({ POST: postBootstrapRestoreHandler } = await import('@/app/api/bootstrap/restore/route'));
  }
  const request = new NextRequest('http://127.0.0.1/api/bootstrap/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Static route: the handler still receives a (promise) params bag.
  return postBootstrapRestoreHandler(request, { params: Promise.resolve({}) });
}

function challengeBody(fileText: string) {
  return { text: fileText, password: RECOVERY_PASSWORD, companyName: LEGAL_NAME, ownerEmail: OWNER_EMAIL };
}

/**
 * I. T19 / S2-S6 — the PRODUCTION HTTP handler, invoked directly.
 *
 * `POST /api/bootstrap/restore` is imported from its real module and called with a
 * synthetic `Request` (an exported function invocation, not a network call: no
 * server, no port, nothing listening). Only the outgoing mail transport is
 * stubbed, so the token is captured in memory. The database, the challenge and
 * lock stores, the source authorizer, `validateRestoreDestination`, the
 * coordinated restore, the provenance archive and both chain verifiers are the
 * production code running against the disposable PostgreSQL instance.
 */
describe('I. the public HTTP handler (POST /api/bootstrap/restore)', () => {
  it('answers 200 for the challenge and 200 for the restore after the owner was deleted', async () => {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    httpMail.sent.length = 0;
    const source = await createSourceBackup(DESTINATION_KEY);
    const rowBefore = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });

    await deleteCompanyLikeAdminPath(source.companyId);
    // Legacy drift: the account is deleted while the old SET NULL constraint is
    // still installed, so the stored row loses its reference (not its seal).
    await deleteOwnerUnderLegacyConstraint(source.ownerId);
    const drifted = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(drifted?.userId).toBeNull();
    expect(drifted?.hash).toBe(rowBefore?.hash);
    const before = await auditSnapshot();

    // Stage 1 — authorize and mail the single-use token.
    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status).toBe(200);
    expect(challenge.headers.get('x-frame-options')).toBe('DENY');
    const challengeJson = await challenge.json() as { stage?: string; message?: string };
    expect(challengeJson.stage).toBe('challenge_sent');
    expect(httpMail.sent).toHaveLength(1);
    expect(httpMail.sent[0]).toMatchObject({ type: 'recovery', to: OWNER_EMAIL });
    expect(httpMail.sent[0].token).toMatch(/^[a-f0-9]{64}$/);
    // The token never travels in the response body.
    expect(JSON.stringify(challengeJson)).not.toContain(httpMail.sent[0].token);

    // Stage 2 — consume the token and restore.
    const completion = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    expect(completion.status).toBe(200);
    const completionJson = await completion.json() as {
      success?: boolean; stage?: string; operationId?: string;
      user?: { email?: string; role?: string } | null;
      companies?: Array<{ id?: string; legalName?: string }>;
    };
    expect(completionJson.success).toBe(true);
    expect(completionJson.stage).toBe('restored');
    expect(completionJson.user).toMatchObject({ email: OWNER_EMAIL, role: 'super_admin' });
    expect(completionJson.companies).toEqual([
      expect.objectContaining({ id: source.companyId, legalName: LEGAL_NAME }),
    ]);
    expect(completionJson.operationId).toBeTruthy();
    // The restored owner gets the same session contract as the login route.
    expect(completion.headers.get('set-cookie')).toContain('session=');
    expect(await db.session.count()).toBeGreaterThanOrEqual(1);
    // No secret is echoed back.
    expect(JSON.stringify(completionJson)).not.toContain(httpMail.sent[0].token);
    expect(JSON.stringify(completionJson)).not.toContain(RECOVERY_PASSWORD);

    // Data, identity and membership are back; retained evidence is untouched.
    expect(await db.company.count()).toBe(1);
    expect(await db.glAccount.count()).toBe(2);
    expect(await db.journalEntry.count()).toBe(1);
    expect(await db.journalLine.count()).toBe(2);
    expect(await db.companyMember.count()).toBe(1);
    expect(await db.user.findUnique({ where: { id: source.ownerId } })).toMatchObject({ email: OWNER_EMAIL });

    const after = await auditSnapshot();
    for (const id of Object.keys(before)) expect(after[id]).toBe(before[id]);
    const copies = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "AuditLog" WHERE id = $1`, source.auditIds[0]);
    expect(copies[0].n).toBe(1);
    // Archive: actual stored digest + the verified original attribution.
    const stored = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(await provenanceEvidence(source.companyId)).toEqual([
      { id: source.auditIds[0], digest: auditHistoryDigest(stored as never), projectedUserId: source.ownerId },
    ]);

    expect((await verifyJournalChain(source.companyId)).valid).toBe(true);
    const audit = await verifyAuditChain({ companyId: source.companyId });
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
    expect(audit.firstBreak).toBeNull();
  });

  it('after the migration, deleting the account no longer touches the sealed reference', async () => {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    httpMail.sent.length = 0;
    const source = await createSourceBackup(DESTINATION_KEY);
    const rowBefore = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });

    await deleteCompanyLikeAdminPath(source.companyId);
    // No constraint re-creation here: this is the installed schema after T19.
    await db.user.delete({ where: { id: source.ownerId } });
    const kept = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(kept?.userId).toBe(source.ownerId);
    expect(kept?.hash).toBe(rowBefore?.hash);
    expect(computeAuditHash({ ...kept! })).toBe(kept!.hash);
    const before = await auditSnapshot();

    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status).toBe(200);
    expect(httpMail.sent).toHaveLength(1);
    const completion = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    expect(completion.status).toBe(200);
    expect((await completion.json() as { stage?: string }).stage).toBe('restored');

    expect(await db.company.count()).toBe(1);
    const after = await auditSnapshot();
    for (const id of Object.keys(before)) expect(after[id]).toBe(before[id]);
    // Verbatim event: no projection is needed or recorded.
    const stored = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(await provenanceEvidence(source.companyId)).toEqual([
      { id: source.auditIds[0], digest: auditHistoryDigest(stored as never) },
    ]);
    const audit = await verifyAuditChain({ companyId: source.companyId });
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
  });

  it('refuses a changed file at challenge and at completion without mutating or consuming the token', async () => {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    httpMail.sent.length = 0;
    const source = await createSourceBackup(DESTINATION_KEY);
    await deleteCompanyLikeAdminPath(source.companyId);
    await deleteOwnerUnderLegacyConstraint(source.ownerId);

    const header = JSON.parse(source.fileText) as Record<string, unknown>;
    const ciphertext = header.ciphertext as string;
    const tamperedText = JSON.stringify({
      ...header,
      ciphertext: `${ciphertext.slice(0, 20)}${ciphertext[20] === 'A' ? 'B' : 'A'}${ciphertext.slice(21)}`,
    });
    const before = await auditSnapshot();
    const provenanceBefore = await provenanceCount();

    const refusedChallenge = await postBootstrapRestore(challengeBody(tamperedText));
    expect(refusedChallenge.status).toBe(400);
    expect((await refusedChallenge.json() as { code?: string }).code).toBe('RECOVERY_PASSWORD_MISMATCH');
    expect(httpMail.sent).toHaveLength(0);

    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status).toBe(200);
    expect(httpMail.sent).toHaveLength(1);
    const token = httpMail.sent[0].token;

    // Same token, different bytes: the AEAD binding is re-checked at completion.
    const refusedCompletion = await postBootstrapRestore({ ...challengeBody(tamperedText), token });
    expect(refusedCompletion.status).toBe(400);
    expect((await refusedCompletion.json() as { code?: string }).code).toBe('RECOVERY_PASSWORD_MISMATCH');
    // Nothing was created, certified or rewritten by the refused attempts.
    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
    expect(await db.companyMember.count()).toBe(0);
    expect(await auditSnapshot()).toEqual(before);
    expect(await provenanceCount()).toBe(provenanceBefore);

    // The rejected attempt did not consume the token: the authorized file still
    // completes with the SAME token.
    const completion = await postBootstrapRestore({ ...challengeBody(source.fileText), token });
    expect(completion.status).toBe(200);
    expect((await completion.json() as { stage?: string }).stage).toBe('restored');
    expect(await db.company.count()).toBe(1);
    const audit = await verifyAuditChain({ companyId: source.companyId });
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
  });
});

/**
 * K. T20 / S19 — the SECOND legacy reference, and both at once.
 *
 * `AuditLog_companyId_fkey` was `ON DELETE SET NULL` until migration 20261105000000,
 * so a company deleted on an older installation erased `companyId` on the audit
 * rows that outlive it. Those rows are UNOWNED, which made the generic foreign-id
 * gate refuse the recovery BEFORE the authenticated planner could certify them —
 * the reported `RESTORE_ID_CONFLICT: AuditLog` after migration 32.
 *
 * Reproduced here on the disposable database only: the pre-migration constraint is
 * installed temporarily, the real deletion runs (the same semantics the admin path
 * had), and the constraint is dropped again in `finally` so the fixture returns to
 * the installed schema. Nothing about the original installation is read or written.
 */
describe('K. legacy FK-nulled company attribution (real handler)', () => {
  /** Delete a company under the pre-migration ON DELETE SET NULL constraint. */
  async function deleteCompanyUnderLegacyConstraint(companyId: string) {
    await db.$executeRawUnsafe(
      `ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_companyId_fkey"
         FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL`);
    try {
      await deleteCompanyLikeAdminPath(companyId);
    } finally {
      await db.$executeRawUnsafe(
        `ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_companyId_fkey"`);
    }
  }

  it('restores after the company was deleted under the legacy company FK (NULL company)', async () => {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    httpMail.sent.length = 0;
    const source = await createSourceBackup(DESTINATION_KEY);
    const rowBefore = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(rowBefore?.companyId).toBe(source.companyId);

    await deleteCompanyUnderLegacyConstraint(source.companyId);

    const drifted = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    // The legacy referential action erased the company scope; the seal and the
    // account attribution are untouched, and the row is now UNOWNED.
    expect(drifted?.companyId).toBeNull();
    expect(drifted?.userId).toBe(source.ownerId);
    expect(drifted?.hash).toBe(rowBefore?.hash);
    expect(computeAuditHash({ ...drifted! })).not.toBe(drifted!.hash);
    expect(await db.company.count()).toBe(0);
    const before = await auditSnapshot();

    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status, JSON.stringify(await challenge.clone().json())).toBe(200);
    expect(httpMail.sent).toHaveLength(1);
    const completion = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    const completionJson = await completion.json() as { stage?: string; code?: string };
    expect(completion.status, JSON.stringify(completionJson)).toBe(200);
    expect(completionJson.stage).toBe('restored');

    // Accounting data, company and membership are back; one copy per event.
    expect(await db.company.count()).toBe(1);
    expect(await db.glAccount.count()).toBe(2);
    expect(await db.journalEntry.count()).toBe(1);
    expect(await db.companyMember.count()).toBe(1);
    const after = await auditSnapshot();
    for (const id of Object.keys(before)) expect(after[id]).toBe(before[id]);
    const copies = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "AuditLog" WHERE id = $1`, source.auditIds[0]);
    expect(copies[0].n).toBe(1);

    // Archive: the ACTUAL stored digest plus the proven original company scope.
    const stored = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(stored?.companyId).toBeNull();
    expect(await provenanceEvidence(source.companyId)).toEqual([{
      id: source.auditIds[0],
      digest: auditHistoryDigest(stored as never),
      projectedCompanyId: source.companyId,
    }]);

    // Both installation-wide verdicts, global AND company-scoped: a scoped query
    // must not omit the raw-NULL archived row (the row is never rewritten).
    const global = await verifyAuditChain({});
    expect(global.valid, JSON.stringify(global.firstBreak)).toBe(true);
    expect(global.members).toBe(1);
    const scoped = await verifyAuditChain({ companyId: source.companyId });
    expect(scoped.valid, JSON.stringify(scoped.firstBreak)).toBe(true);
    expect(scoped.members).toBe(1);
    expect(scoped.firstBreak).toBeNull();
    expect((await verifyJournalChain(source.companyId)).valid).toBe(true);

    // The archive attribution is re-proved on EVERY verification with the local
    // key, so a rotated key refuses instead of trusting the stored label...
    process.env.HMAC_SECRET = 'rotated-installation-key-t20-not-production';
    try {
      const rotated = await verifyAuditChain({});
      expect(rotated.valid).toBe(false);
      expect(rotated.reasonCode).toBe('ARCHIVE_ATTRIBUTION_MISMATCH');
    } finally {
      process.env.HMAC_SECRET = DESTINATION_KEY;
    }
    // ...and a rewritten stored byte fails the archive digest instead.
    await db.$executeRawUnsafe(
      `UPDATE "AuditLog" SET details = 'rewritten after the recovery' WHERE id = $1`, source.auditIds[0]);
    const rewritten = await verifyAuditChain({});
    expect(rewritten.valid).toBe(false);
    expect(rewritten.reasonCode).toBe('ARCHIVE_HASH_MISMATCH');
    // Restored byte-for-byte, the evidence is valid again.
    await db.$executeRawUnsafe(
      `UPDATE "AuditLog" SET details = NULL WHERE id = $1`, source.auditIds[0]);
    const restoredAgain = await verifyAuditChain({});
    expect(restoredAgain.valid, JSON.stringify(restoredAgain.firstBreak)).toBe(true);
  });

  it('restores when the COMPANY and the USER references were both erased', async () => {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    httpMail.sent.length = 0;
    const source = await createSourceBackup(DESTINATION_KEY);
    const rowBefore = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });

    await deleteCompanyUnderLegacyConstraint(source.companyId);
    await deleteOwnerUnderLegacyConstraint(source.ownerId);

    const drifted = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(drifted?.companyId).toBeNull();
    expect(drifted?.userId).toBeNull();
    expect(drifted?.hash).toBe(rowBefore?.hash);
    // Neither reference alone can reproduce the original payload.
    expect(computeAuditHash({ ...drifted!, companyId: source.companyId })).not.toBe(drifted!.hash);
    expect(computeAuditHash({ ...drifted!, userId: source.ownerId })).not.toBe(drifted!.hash);
    expect(computeAuditHash({
      ...drifted!, companyId: source.companyId, userId: source.ownerId,
    })).toBe(drifted!.hash);
    const before = await auditSnapshot();

    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status).toBe(200);
    expect(httpMail.sent).toHaveLength(1);
    const completion = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    const completionJson = await completion.json() as { stage?: string; code?: string };
    expect(completion.status, JSON.stringify(completionJson)).toBe(200);

    expect(await db.company.count()).toBe(1);
    expect(await db.companyMember.count()).toBe(1);
    expect(await db.user.findUnique({ where: { id: source.ownerId } })).toMatchObject({ email: OWNER_EMAIL });
    const after = await auditSnapshot();
    for (const id of Object.keys(before)) expect(after[id]).toBe(before[id]);

    // One archive entry carrying BOTH proven references, and the stored digest of
    // the row as it actually is (NULL / NULL).
    const stored = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(await provenanceEvidence(source.companyId)).toEqual([{
      id: source.auditIds[0],
      digest: auditHistoryDigest(stored as never),
      projectedCompanyId: source.companyId,
      projectedUserId: source.ownerId,
    }]);

    const global = await verifyAuditChain({});
    expect(global.valid, JSON.stringify(global.firstBreak)).toBe(true);
    const scoped = await verifyAuditChain({ companyId: source.companyId });
    expect(scoped.valid, JSON.stringify(scoped.firstBreak)).toBe(true);
    expect(scoped.firstBreak).toBeNull();
    expect((await verifyJournalChain(source.companyId)).valid).toBe(true);
  });

  it('refuses changed content on a NULL-company row, naming only fields', async () => {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    httpMail.sent.length = 0;
    const source = await createSourceBackup(DESTINATION_KEY);
    await deleteCompanyUnderLegacyConstraint(source.companyId);
    // A different event under the same id: no reference projection can explain it.
    await db.$executeRawUnsafe(
      `UPDATE "AuditLog" SET details = 'rewritten before recovery' WHERE id = $1`, source.auditIds[0]);

    const before = await auditSnapshot();
    const provenanceBefore = await provenanceCount();
    // The company deletion under the legacy FK keeps the account: a refused
    // attempt must not delete it either.
    const usersBefore = await db.user.count();
    expect(usersBefore).toBe(1);
    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status).toBe(200);
    const completion = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    expect(completion.status).toBe(400);
    const body = await completion.json() as { code?: string; error?: string };
    expect(body.code).toBe('RECOVERY_RESTORE_REFUSED');
    // Safe diagnostic: fixed field names only, no ids/content/hashes.
    expect(body.error).toContain('RESTORE_ID_CONFLICT');
    expect(body.error).toContain('fields:');
    expect(body.error).toContain('details');
    for (const secret of [source.auditIds[0], source.companyId, source.ownerId, OWNER_EMAIL,
      RECOVERY_PASSWORD, httpMail.sent[0].token, 'rewritten before recovery']) {
      expect(body.error).not.toContain(secret);
    }

    // Nothing was created, certified, rewritten or consumed.
    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(usersBefore);
    expect(await db.companyMember.count()).toBe(0);
    expect(await auditSnapshot()).toEqual(before);
    expect(await provenanceCount()).toBe(provenanceBefore);
    // Token semantics are unchanged: this refusal happens AFTER the atomic single
    // use, so the same token is spent (never silently reusable) and the retry is
    // refused without touching anything either.
    const retry = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    expect(retry.status).toBe(400);
    expect((await retry.json() as { code?: string }).code).toBe('RECOVERY_TOKEN_USED');
    expect(await db.company.count()).toBe(0);
    expect(await auditSnapshot()).toEqual(before);
    expect(await provenanceCount()).toBe(provenanceBefore);
  });
});

/**
 * L. T23 / S4, S21 — THE SAME PERSON WITH A DIFFERENT LOCAL ACCOUNT ID.
 *
 * The operationally reported case, reproduced with generic synthetic data: the
 * portable file is created on THIS installation (so the source key is the local
 * one), the company and the source account are deleted AFTER the migration that
 * made the audit references immutable, and a verified local owner with the SAME
 * email but a DIFFERENT id is registered before recovering.
 *
 * The retained audit rows are byte-identical to the authenticated snapshot and
 * still carry the ORIGINAL actor reference, which the generated identity map
 * must never rewrite: that mapping only describes how an ABSENT row would be
 * stored. Recovery must therefore reuse the retained rows verbatim (one copy per
 * event, no re-sign, no relabel), keep the local account's own id, credentials
 * and role, and never recreate or promote the source account.
 */
describe('L. same email with a different local account id (real handler)', () => {
  /** The local owner: same email, generated different id, own password hash. */
  async function createLocalOwner(password = RECOVERY_PASSWORD, role: 'user' | 'super_admin' = 'user') {
    return db.user.create({
      data: {
        email: OWNER_EMAIL,
        passwordHash: await hashPassword(password),
        firstName: '',
        lastName: '',
        platformRole: role,
        emailVerifiedAt: new Date('2026-02-01T00:00:00.000Z'),
        legacyUser: false,
      },
    });
  }

  /** Source backup, company + source account deleted, local owner registered. */
  async function prepareReportedState(
    options: { password?: string; role?: 'user' | 'super_admin' } = {},
  ) {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    const source = await createSourceBackup(DESTINATION_KEY);
    const rowBefore = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(rowBefore?.userId).toBe(source.ownerId);
    const sourceOwner = await db.user.findUnique({ where: { id: source.ownerId } });
    expect(sourceOwner?.passwordHash).toBeTruthy();

    await deleteCompanyLikeAdminPath(source.companyId);
    // The installed schema no longer erases the evidence reference on delete.
    await db.user.delete({ where: { id: source.ownerId } });

    const kept = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(kept?.userId).toBe(source.ownerId);
    expect(kept?.companyId).toBe(source.companyId);
    expect(kept?.hash).toBe(rowBefore?.hash);
    expect(computeAuditHash({ ...kept! })).toBe(kept!.hash);

    const local = await createLocalOwner(options.password ?? RECOVERY_PASSWORD, options.role ?? 'user');
    expect(local.id).not.toBe(source.ownerId);
    // Same proof, different hash: the local account keeps its own credentials.
    expect(local.passwordHash).not.toBe(sourceOwner?.passwordHash);
    expect(await db.company.count()).toBe(0);
    return { source, local };
  }

  it('restores verbatim retained history and keeps the local account untouched', async () => {
    httpMail.sent.length = 0;
    const { source, local } = await prepareReportedState();
    const before = await auditSnapshot();
    expect(await db.user.count()).toBe(1);

    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status, JSON.stringify(await challenge.clone().json())).toBe(200);
    expect(httpMail.sent).toHaveLength(1);
    expect(httpMail.sent[0]).toMatchObject({ type: 'recovery', to: OWNER_EMAIL });

    const completion = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    const body = await completion.json() as {
      success?: boolean; stage?: string; code?: string; error?: string; operationId?: string;
      user?: { id?: string; email?: string; role?: string } | null;
      companies?: Array<{ id?: string; legalName?: string; role?: string | null }>;
    };
    // The reported false conflict: `content`/`fields: none` for retained history
    // that IS the authenticated event.
    expect(completion.status, JSON.stringify(body)).toBe(200);
    expect(body.stage).toBe('restored');
    expect(body.success).toBe(true);

    // Same person, own identity: the LOCAL account is the session, never the
    // source account, and its credentials/role are unchanged.
    expect(body.user).toMatchObject({ id: local.id, email: OWNER_EMAIL, role: 'user' });
    expect(body.companies).toEqual([
      expect.objectContaining({ id: source.companyId, legalName: LEGAL_NAME, role: 'company_admin' }),
    ]);
    expect(completion.headers.get('set-cookie')).toContain('session=');
    expect(JSON.stringify(body)).not.toContain(httpMail.sent[0].token);
    expect(JSON.stringify(body)).not.toContain(RECOVERY_PASSWORD);
    expect(await db.session.count({ where: { userId: local.id } })).toBe(1);
    expect(await db.session.count({ where: { userId: source.ownerId } })).toBe(0);

    // The source account is neither recreated nor promoted.
    expect(await db.user.count()).toBe(1);
    expect(await db.user.findUnique({ where: { id: source.ownerId } })).toBeNull();
    expect(await db.user.findUnique({ where: { id: local.id } })).toMatchObject({
      email: OWNER_EMAIL,
      passwordHash: local.passwordHash,
      platformRole: 'user',
      emailVerifiedAt: local.emailVerifiedAt,
    });

    // The company comes back with its ORIGINAL identifier and accounting data.
    expect(await db.company.findMany({ select: { id: true, legalName: true } }))
      .toEqual([{ id: source.companyId, legalName: LEGAL_NAME }]);
    expect(await db.glAccount.count()).toBe(2);
    expect(await db.journalEntry.count()).toBe(1);
    expect(await db.journalLine.count()).toBe(2);
    expect(await db.companyMember.findMany({ select: { userId: true, companyId: true } }))
      .toEqual([{ userId: local.id, companyId: source.companyId }]);

    // Every retained audit row survives BYTE-IDENTICAL, one copy per event: the
    // original actor attribution stays exactly as signed (the source actor ids
    // remain the historical actor even though no such live account exists).
    const after = await auditSnapshot();
    for (const id of Object.keys(before)) expect(after[id]).toBe(before[id]);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), body.operationId!].sort());
    const copies = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "AuditLog" WHERE id = $1`, source.auditIds[0]);
    expect(copies[0].n).toBe(1);
    const stored = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(stored?.userId).toBe(source.ownerId);

    // Archive: the ACTUAL stored digest, with no projection (nothing was erased
    // and nothing was rewritten), plus the recorded identity mapping.
    expect(await provenanceEvidence(source.companyId)).toEqual([
      { id: source.auditIds[0], digest: auditHistoryDigest(stored as never) },
    ]);
    const provenance = await db.$queryRawUnsafe<Array<{ identityMap: Record<string, string> }>>(
      `SELECT provenance -> 'identityMap' AS "identityMap" FROM "BootstrapRecoveryProvenance" WHERE "companyId" = $1`,
      source.companyId,
    );
    expect(provenance[0].identityMap).toEqual({ [source.ownerId]: local.id });

    // Installation-wide AND company-scoped verification stay valid.
    const global = await verifyAuditChain({});
    expect(global.valid, JSON.stringify(global.firstBreak)).toBe(true);
    expect(global.members).toBe(1);
    const scoped = await verifyAuditChain({ companyId: source.companyId });
    expect(scoped.valid, JSON.stringify(scoped.firstBreak)).toBe(true);
    expect(scoped.firstBreak).toBeNull();
    expect(scoped.members).toBe(1);
    expect((await verifyJournalChain(source.companyId)).valid).toBe(true);
  });

  /**
   * COMPATIBILITY PROBE — the very next EXPORT of this company.
   *
   * A recovery must not leave the installation unable to back itself up again, and
   * the new file must stay restorable. The portable export runs with the LOCAL
   * owner's password (the account that exists now, a DIFFERENT id from the source
   * owner) and seals that owner, while the retained audit row keeps the ORIGINAL
   * actor reference that the migrations made immutable EVIDENCE rather than a
   * foreign key. Nothing is rewritten to bridge the two: the actor stays as signed,
   * the local account is never re-signed into history and no deleted account is
   * resurrected.
   *
   * The local account here is the installation's verified, active super
   * administrator (the account authorized to export a portable file); the previous
   * case keeps proving that a plain `user` account is NOT promoted by a recovery.
   */
  it('exports a new portable backup and reopens it with the historical actor intact', async () => {
    httpMail.sent.length = 0;
    process.env.HMAC_SECRET = DESTINATION_KEY;
    const { source, local } = await prepareReportedState({ role: 'super_admin' });

    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status).toBe(200);
    const completion = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    const body = await completion.json() as { stage?: string; user?: { id?: string; role?: string } };
    expect(completion.status, JSON.stringify(body)).toBe(200);
    expect(body.stage).toBe('restored');
    // The local account remains the session and keeps its own role.
    expect(body.user).toMatchObject({ id: local.id, role: 'super_admin' });
    expect(await db.user.count()).toBe(1);
    expect(await db.user.findUnique({ where: { id: source.ownerId } })).toBeNull();

    const historicalBefore = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(historicalBefore?.userId).toBe(source.ownerId);

    // REAL production export helper, with the LOCAL owner's password.
    const exported = await createPortableBackup({
      companyId: source.companyId, createdByUserId: local.id, password: RECOVERY_PASSWORD,
    });
    // The historical row is untouched by the export itself.
    const historicalAfter = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(historicalAfter).toEqual(historicalBefore);

    const exportedText = Buffer.from(exported.data, 'base64').toString('utf8');
    // Reopened with the SAME production reader the recovery flow uses.
    const reopenedFile = openPortableContainer(exportedText, RECOVERY_PASSWORD, {
      ownerEmail: OWNER_EMAIL, companyLegalName: LEGAL_NAME,
    });
    // The owner sealed in the new file is the LOCAL account, never the historical
    // actor of retained evidence.
    expect(reopenedFile.payload.owner.ownerUserId).toBe(local.id);
    expect(reopenedFile.payload.owner.ownerEmail).toBe(OWNER_EMAIL);

    // The snapshot this export produced must be a valid PORTABLE SOURCE. This is the
    // reader a later recovery runs, so a historical actor/company reference that the
    // installed schema deliberately keeps must not make our own certified backup
    // unrestorable.
    const reopened = validateRestoreSource(source.companyId, JSON.stringify(reopenedFile.payload.snapshot), {
      recovery: 'portable', authenticatedDigest: reopenedFile.fileDigest,
    });
    const exportedAudit = reopened.tables.AuditLog.find((row) => row.id === source.auditIds[0]);
    // Byte-identical evidence: same actor, seal, link and instant.
    expect(exportedAudit).toBeDefined();
    expect(auditHistoryDigestOf(exportedAudit as never))
      .toBe(auditHistoryDigest(historicalBefore as never));
    expect(exportedAudit?.userId).toBe(source.ownerId);
    // Only the local account travels as a user: the deleted actor is not recreated.
    expect(reopened.tables.User.map((row) => row.id)).toEqual([local.id]);
    // The new file still carries the restored accounting data.
    expect(reopened.tables.JournalEntry).toHaveLength(1);
    expect(reopened.tables.GlAccount).toHaveLength(2);

    // And the installation still certifies both installation-wide chains.
    const audit = await verifyAuditChain({ companyId: source.companyId });
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
    expect((await verifyJournalChain(source.companyId)).valid).toBe(true);
  });

  it('refuses a retained row that is not the authenticated event, mutating nothing', async () => {
    httpMail.sent.length = 0;
    const { source, local } = await prepareReportedState();
    // A different event under the same id: no identity mapping can explain it.
    await db.$executeRawUnsafe(
      `UPDATE "AuditLog" SET details = 'rewritten before recovery' WHERE id = $1`, source.auditIds[0]);

    const before = await auditSnapshot();
    const provenanceBefore = await provenanceCount();
    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status).toBe(200);
    const completion = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    expect(completion.status).toBe(400);
    const body = await completion.json() as { code?: string; error?: string };
    expect(body.code).toBe('RECOVERY_RESTORE_REFUSED');
    expect(body.error).toContain('RESTORE_ID_CONFLICT');
    // Safe diagnostic: the field that actually differs, never `none`.
    expect(body.error).toContain('fields: details');
    expect(body.error).not.toContain('fields: none');
    for (const secret of [source.auditIds[0], source.companyId, source.ownerId, local.id,
      OWNER_EMAIL, RECOVERY_PASSWORD, httpMail.sent[0].token, 'rewritten before recovery']) {
      expect(body.error).not.toContain(secret);
    }

    // Nothing created, certified, rewritten or deleted.
    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(1);
    expect(await db.companyMember.count()).toBe(0);
    expect(await auditSnapshot()).toEqual(before);
    expect(await provenanceCount()).toBe(provenanceBefore);
    // Single use is preserved: the refusal happened after the atomic consumption.
    const retry = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    expect(retry.status).toBe(400);
    expect((await retry.json() as { code?: string }).code).toBe('RECOVERY_TOKEN_USED');
    expect(await db.company.count()).toBe(0);
    expect(await auditSnapshot()).toEqual(before);
  });

  it('still refuses a same-email local owner whose password does not match', async () => {
    httpMail.sent.length = 0;
    // The local account proves nothing with a different password: the same email
    // alone is NEVER an identity match.
    const { source, local } = await prepareReportedState({ password: 'different-local-password-2026' });
    const before = await auditSnapshot();

    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status).toBe(200);
    const completion = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    expect(completion.status).toBe(409);
    expect((await completion.json() as { code?: string }).code).toBe('RECOVERY_LOCAL_ACCOUNT_LOGIN_REQUIRED');

    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(1);
    expect(await db.user.findUnique({ where: { id: local.id } })).toMatchObject({
      passwordHash: local.passwordHash, platformRole: 'user',
    });
    expect(await auditSnapshot()).toEqual(before);
    expect(await provenanceCount()).toBe(0);
  });
});

/**
 * F4 — a SECOND recovery on an installation that was already recovered once.
 *
 * The reported blocker: after a successful recovery the operator deletes the
 * restored company (its audit rows are retained evidence) and recovers again — on
 * the same machine or after rotating the installation key. The replacement then
 * always refused, because the COORDINATED RESTORE validates its own SAFETY
 * snapshot with the STRICT local-key contract. That snapshot legitimately carries
 * retained audit rows sealed by the SOURCE installation (or by a previous
 * destination key), which this key can never recompute — so the safety copy was
 * judged un-restorable and the second recovery failed closed forever.
 *
 * The safety snapshot is produced IN PROCESS by the same transaction, so its
 * validator must use the same portable historical-evidence semantics as the
 * source reader. Pinned here:
 *  - two consecutive recoveries succeed (the second one after a key rotation);
 *  - retained audit evidence stays BYTE-IDENTICAL through both;
 *  - both chains still verify afterwards and the source rows are never re-signed.
 */
describe('M. a second recovery after a first one and a key rotation (F4)', () => {
  const ROTATED_DESTINATION_KEY = 'rotated-destination-key-after-first-recovery';

  it('recovers again and keeps every retained audit row byte-identical', async () => {
    const source = await createSourceBackup(SOURCE_KEY);
    await wipeDatabase();

    // 1. First recovery: this installation never held the source key.
    const first = harness();
    expect((await request(first, source.fileText)).status).toBe('challenge_sent');
    const firstDone = await complete(first, source.fileText, first.mail[0].token);
    expect(firstDone.status, JSON.stringify(firstDone)).toBe('restored');
    expect(await db.company.count()).toBe(1);

    // 2. The company is deleted exactly like the admin path does: business rows
    //    go, the signed audit evidence outlives its company on purpose.
    await deleteCompanyLikeAdminPath(source.companyId);
    expect(await db.company.count()).toBe(0);
    const retained = await auditSnapshot();
    expect(Object.keys(retained).length).toBeGreaterThan(0);

    // 3. The installation key is rotated between the two recoveries.
    process.env.HMAC_SECRET = ROTATED_DESTINATION_KEY;
    try {
      const second = harness();
      const challenged = await request(second, source.fileText);
      expect(challenged.status, JSON.stringify(challenged)).toBe('challenge_sent');
      const done = await complete(second, source.fileText, second.mail[0].token);
      expect(done.status, JSON.stringify(done)).toBe('restored');

      // Retained evidence is untouched: exact stored JSON, including its hash.
      const after = await auditSnapshot();
      for (const [id, row] of Object.entries(retained)) expect(after[id]).toBe(row);

      // The accounting data really came back.
      const company = await db.company.findUnique({ where: { id: source.companyId } });
      expect(company).not.toBeNull();
      expect(await db.glAccount.count()).toBe(2);
      expect(await db.journalEntry.count()).toBe(1);
      expect(await db.journalLine.count()).toBe(2);

      // Both chains verify: the recovered rows are certified by the archive and
      // never re-signed under the rotated key.
      const journal = await verifyJournalChain(source.companyId);
      expect(journal.valid, journal.reasonCode).toBe(true);
      const audit = await verifyAuditChain({});
      expect(audit.valid, audit.reasonCode).toBe(true);
      for (const id of source.auditIds) {
        const row = await db.auditLog.findUnique({ where: { id } });
        expect(row).not.toBeNull();
        expect(computeAuditHash({
          id: row!.id, companyId: row!.companyId, userId: row!.userId, action: row!.action,
          entity: row!.entity, entityId: row!.entityId, details: row!.details,
          previousHash: row!.previousHash,
        })).not.toBe(row!.hash);
      }
      // Two provenance records now exist: one per authenticated file.
      expect(await provenanceCount()).toBe(2);
    } finally {
      process.env.HMAC_SECRET = DESTINATION_KEY;
    }
  });
});

/**
 * F1 — a MULTI-USER backup on a brand-new machine (reported blocker JD-A-001).
 *
 * The source installation of a small company often has a member account next to
 * the owner. `validateRestoreDestination` requires every source `User` row to
 * exist in the destination with the same id+email (correct for a local
 * replacement), and portable recovery only ever recreated the owner, so such a
 * file was refused with `RESTORE_MISSING_IDENTITY` on a fresh machine: the
 * operator could not recover their own accounting because another person's
 * account travelled in the file.
 *
 * The prepare transaction now reconciles every source identity. Pinned here on
 * real PostgreSQL, through the real validators and the real restore path:
 *  - both accounts exist after the recovery;
 *  - the owner keeps global authority (proven by password + email token) while a
 *    recreated member comes back with the NON-elevated `user` role;
 *  - the recreated member has no usable credential (the backup never carries one)
 *    and is not email-verified by mere restoration;
 *  - its tenant role comes from the restored membership row, and both memberships
 *    are present;
 *  - the retained source audit row keeps the source attribution and seal.
 */
describe('N. a multi-user backup recovers on a brand-new installation (F1)', () => {
  const MEMBER_EMAIL = 'member.recovery.t27@example.test';

  it('recreates the owner and the member account with their expected roles', async () => {
    await wipeDatabase();
    const owner = await createTestUser(OWNER_EMAIL);
    const member = await createTestUser(MEMBER_EMAIL);
    const company = await createTestCompany(LEGAL_NAME);
    await createTestCompanyMember(owner.id, company.id);
    await createTestCompanyMember(member.id, company.id);
    const cash = await createTestGlAccount({
      companyId: company.id, code: '1010', name: 'Caja', accountType: 'asset', normalBalance: 'debit',
    });
    const revenue = await createTestGlAccount({
      companyId: company.id, code: '4010', name: 'Ventas', accountType: 'revenue', normalBalance: 'credit',
    });
    const entry = await createTestJournalEntry(company.id, {
      date: '2025-05-02',
      description: 'Venta con dos usuarios',
      lines: [
        { glAccountId: cash.id, debit: 640.25, credit: 0 },
        { glAccountId: revenue.id, debit: 0, credit: 640.25 },
      ],
    });

    const saved = process.env.HMAC_SECRET;
    process.env.HMAC_SECRET = SOURCE_KEY;
    let fileText: string;
    let sourceAuditId: string;
    try {
      await db.$transaction((tx) => appendEntryToJournalChain(tx, { companyId: company.id, entryId: entry.id }));
      const audit = await createAuditLogWithRetry({
        companyId: company.id, userId: member.id, action: 'JOURNAL_POSTED',
        entity: 'JournalEntry', entityId: entry.id,
      });
      sourceAuditId = audit.id;
      await db.user.update({
        where: { id: owner.id },
        data: {
          passwordHash: await hashPassword(RECOVERY_PASSWORD),
          emailVerifiedAt: new Date('2026-01-02T00:00:00.000Z'),
          platformRole: 'super_admin',
        },
      });
      const portable = await createPortableBackup({
        companyId: company.id, createdByUserId: owner.id, password: RECOVERY_PASSWORD,
      });
      fileText = Buffer.from(portable.data, 'base64').toString('utf8');
    } finally {
      if (saved === undefined) delete process.env.HMAC_SECRET;
      else process.env.HMAC_SECRET = saved;
    }

    // The source machine is gone: a truly empty installation.
    await wipeDatabase();
    expect(await db.user.count()).toBe(0);

    const h = harness();
    expect((await request(h, fileText)).status).toBe('challenge_sent');
    const completed = await complete(h, fileText, h.mail[0].token);
    expect(completed.status, JSON.stringify(completed)).toBe('restored');

    // BOTH accounts exist, with the expected global roles.
    const users = await db.user.findMany({ orderBy: { createdAt: 'asc' } });
    expect(users).toHaveLength(2);
    const restoredOwner = users.find((user) => user.id === owner.id);
    const restoredMember = users.find((user) => user.id === member.id);
    expect(restoredOwner).toMatchObject({ email: OWNER_EMAIL, platformRole: 'super_admin' });
    expect(restoredMember).toMatchObject({ email: MEMBER_EMAIL, platformRole: 'user' });

    // The recreated account has NO usable credential from the backup and is not
    // silently treated as email-verified by the act of restoring.
    expect(restoredMember!.emailVerifiedAt).toBeNull();
    expect(restoredMember!.legacyUser).toBe(false);
    expect(await verifyPassword(RECOVERY_PASSWORD, restoredMember!.passwordHash)).toBe(false);
    expect(restoredMember!.passwordHash).not.toBe(restoredOwner!.passwordHash);
    // The owner's own credential is the one the operator proved.
    expect(await verifyPassword(RECOVERY_PASSWORD, restoredOwner!.passwordHash)).toBe(true);

    // Both memberships came back with their tenant roles.
    expect(await db.companyMember.count()).toBe(2);
    for (const userId of [owner.id, member.id]) {
      expect(await db.companyMember.findUnique({
        where: { userId_companyId: { userId, companyId: company.id } },
      })).not.toBeNull();
    }

    // Accounting data landed and the retained source audit row keeps its seal and
    // its ORIGINAL attribution (same ids, nothing remapped or re-signed).
    expect(await db.glAccount.count()).toBe(2);
    expect(await db.journalEntry.count()).toBe(1);
    const retained = await db.auditLog.findUnique({ where: { id: sourceAuditId } });
    expect(retained).toMatchObject({ companyId: company.id, userId: member.id });
    expect(computeAuditHash({
      id: retained!.id, companyId: retained!.companyId, userId: retained!.userId,
      action: retained!.action, entity: retained!.entity, entityId: retained!.entityId,
      details: retained!.details, previousHash: retained!.previousHash,
    })).not.toBe(retained!.hash);
  });
});

/**
 * T28 / S21 (L62) — THE OPERATOR'S REAL SHAPE, ON REAL POSTGRESQL.
 *
 * The real installation failed completion with
 *   `RESTORE_ID_CONFLICT: AuditLog [mismatch: content; fields: userId]`
 * after a successful challenge: the retained, locally certified audit row
 * referenced a HISTORICAL LOCAL account id that was neither the authenticated
 * source actor nor the current identity-map target.
 *
 * That state is produced here ONLY through production paths — no row is
 * hand-crafted, no identifier is real:
 *  1. a real portable export sealed by THIS installation's key;
 *  2. a first recovery that maps the source owner onto a LOCAL account, so the
 *     audit row is stored under that LOCAL actor while keeping the ORIGINAL source
 *     seal (a mapping never re-signs history);
 *  3. company deletion (audit rows are retained evidence) plus local account
 *     churn: the mapped account is removed and a NEW local owner with the same
 *     email registers before the second recovery.
 *
 * Pinned: the second recovery succeeds, the retained row stays BYTE-IDENTICAL and
 * is stored exactly once, both chains verify, and the archive records the STORED
 * digest with no invented attribution. A row that is locally re-sealed for the
 * stored actor is NOT the authenticated event and stays fail-closed.
 */
describe('O. the retained audit actor is a historical local account id (S21/T28)', () => {
  /** A local owner: same email as the source owner, its own id and credential. */
  async function createLocalOwner() {
    return db.user.create({
      data: {
        email: OWNER_EMAIL,
        passwordHash: await hashPassword(RECOVERY_PASSWORD),
        firstName: '',
        lastName: '',
        platformRole: 'user',
        emailVerifiedAt: new Date('2026-02-01T00:00:00.000Z'),
        legacyUser: false,
      },
    });
  }

  /** Latest recovered audit evidence of one company (stored digests). */
  async function latestAuditEvidence(companyId: string) {
    const rows = await db.$queryRawUnsafe<Array<{
      provenance: {
        auditEvidence: Array<{
          id: string; digest: string; projectedUserId?: string;
          sealLess?: true; outsidePayload?: true;
        }>;
      };
    }>>(
      `SELECT provenance FROM "BootstrapRecoveryProvenance" WHERE "companyId" = $1
        ORDER BY "createdAt" DESC LIMIT 1`, companyId);
    return rows[0]?.provenance.auditEvidence ?? [];
  }

  async function prepareHistoricalActorState() {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    const source = await createSourceBackup(DESTINATION_KEY);
    await wipeDatabase();

    // 1. First recovery: the source owner is mapped onto the LOCAL account.
    const previousLocal = await createLocalOwner();
    const first = harness();
    expect((await request(first, source.fileText)).status).toBe('challenge_sent');
    const firstDone = await complete(first, source.fileText, first.mail[0].token);
    expect(firstDone.status, JSON.stringify(firstDone)).toBe('restored');

    const stored = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    // Stored under the LOCAL actor, sealed with the SOURCE one: the mapping moved
    // the reference and never re-signed the event.
    expect(stored?.userId).toBe(previousLocal.id);
    expect(stored?.userId).not.toBe(source.ownerId);
    expect(computeAuditHash({ ...stored!, userId: source.ownerId })).toBe(stored!.hash);
    expect(computeAuditHash({ ...stored! })).not.toBe(stored!.hash);

    // 2. Company deleted exactly like the admin path: audit evidence survives.
    await deleteCompanyLikeAdminPath(source.companyId);
    // 3. Local account churn: the mapped account is gone, a new local owner
    //    registers with the same email before the second attempt.
    await db.user.delete({ where: { id: previousLocal.id } });
    const currentLocal = await createLocalOwner();
    expect(currentLocal.id).not.toBe(previousLocal.id);
    expect(currentLocal.id).not.toBe(source.ownerId);
    expect(await db.company.count()).toBe(0);
    return { source, historicalLocalId: previousLocal.id, currentLocal };
  }

  it('reuses the retained row byte-identically and finishes the recovery', async () => {
    httpMail.sent.length = 0;
    const { source, historicalLocalId, currentLocal } = await prepareHistoricalActorState();
    const before = await auditSnapshot();

    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status, JSON.stringify(await challenge.clone().json())).toBe(200);
    expect(httpMail.sent).toHaveLength(1);
    const completion = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    const body = await completion.json() as {
      success?: boolean; stage?: string; code?: string; error?: string; operationId?: string;
      user?: { id?: string; email?: string } | null;
      companies?: Array<{ id?: string }>;
    };
    // The reported refusal is gone: the userId-only difference resolves.
    expect(completion.status, JSON.stringify(body)).toBe(200);
    expect(body.stage).toBe('restored');
    expect(body.success).toBe(true);
    // The CURRENT local account is the session (the historical one is not reused).
    expect(body.user).toMatchObject({ id: currentLocal.id, email: OWNER_EMAIL });

    // ONE copy of the event, byte-identical: nothing re-inserted, rewritten or
    // re-signed, and the historical actor stays exactly as stored.
    const after = await auditSnapshot();
    for (const [id, row] of Object.entries(before)) expect(after[id]).toBe(row);
    expect(Object.keys(after).sort()).toEqual([...Object.keys(before), body.operationId!].sort());
    const copies = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "AuditLog" WHERE id = $1`, source.auditIds[0]);
    expect(copies[0].n).toBe(1);
    const retained = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(retained?.userId).toBe(historicalLocalId);
    expect(retained?.userId).not.toBe(currentLocal.id);
    expect(retained?.hash).toBe(JSON.parse(before[source.auditIds[0]]).hash);

    // Evidence: the STORED digest, with no fabricated attribution label, and the
    // mapping recorded is today's target (history is never relabelled).
    //
    // T36 re-pin, stated reason: the archive now covers EVERY preserved row, so the
    // FIRST recovery's unsealed `COMPANY_RESTORE_COMMITTED` receipt is archived as
    // well — it is a payload-absent row (no file ever carries another run's
    // operational receipt), marked explicitly instead of being left uncertifiable.
    const evidence = await latestAuditEvidence(source.companyId);
    expect(evidence.filter((entry) => entry.id === source.auditIds[0])).toEqual([
      { id: source.auditIds[0], digest: auditHistoryDigest(retained as never) },
    ]);
    const receipts = evidence.filter((entry) => entry.id !== source.auditIds[0]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ outsidePayload: true, sealLess: true });
    const receiptRow = await db.auditLog.findUnique({ where: { id: receipts[0].id } });
    expect(receipts[0].digest).toBe(auditHistoryDigestOf(receiptRow as never));
    const provenance = await db.$queryRawUnsafe<Array<{ identityMap: Record<string, string> }>>(
      `SELECT provenance -> 'identityMap' AS "identityMap" FROM "BootstrapRecoveryProvenance"
        WHERE "companyId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, source.companyId);
    expect(provenance[0].identityMap).toEqual({ [source.ownerId]: currentLocal.id });

    // The accounting data came back and both installation chains still verify.
    expect(await db.company.findMany({ select: { id: true, legalName: true } }))
      .toEqual([{ id: source.companyId, legalName: LEGAL_NAME }]);
    expect(await db.journalEntry.count()).toBe(1);
    expect(await db.glAccount.count()).toBe(2);
    const audit = await verifyAuditChain({});
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
    expect((await verifyJournalChain(source.companyId)).valid).toBe(true);
  });

  it('refuses a retained row locally re-sealed for its stored actor, mutating nothing', async () => {
    httpMail.sent.length = 0;
    const { source } = await prepareHistoricalActorState();
    const stored = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    // A seal this installation CAN recompute over the stored (historical) actor:
    // valid local history, but NOT the authenticated event's seal, so the
    // userId-only allowance must not apply.
    const reSigned = computeAuditHash({ ...stored! });
    await db.$executeRawUnsafe(
      `UPDATE "AuditLog" SET hash = $1 WHERE id = $2`, reSigned, source.auditIds[0]);
    const before = await auditSnapshot();
    const provenanceBefore = await provenanceCount();

    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status).toBe(200);
    const completion = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    expect(completion.status).toBe(400);
    const body = await completion.json() as { code?: string; error?: string };
    expect(body.code).toBe('RECOVERY_RESTORE_REFUSED');
    expect(body.error).toContain('RESTORE_ID_CONFLICT');
    // The seal is the field that actually failed, next to the actor reference.
    expect(body.error).toContain('fields: hash,userId');
    for (const secret of [source.auditIds[0], source.companyId, source.ownerId,
      OWNER_EMAIL, RECOVERY_PASSWORD, httpMail.sent[0].token, reSigned]) {
      expect(body.error).not.toContain(secret);
    }

    // Nothing created, rewritten or certified.
    expect(await db.company.count()).toBe(0);
    expect(await auditSnapshot()).toEqual(before);
    expect(await provenanceCount()).toBe(provenanceBefore);
  });
});

/**
 * P. THE ERASED REFERENCE IS ON THE SOURCE SIDE (S21/T31, L67).
 *
 * The operator's real installation refused completion with
 * `RESTORE_ID_CONFLICT: AuditLog [mismatch: content; fields: userId]` while already
 * running the T29/T30 code. Under that code the only shape reaching that refusal is
 * the mirror of the accepted erased-reference projection: the AUTHENTICATED backup
 * event itself carries `userId: null` (the legacy `ON DELETE SET NULL` erased the
 * actor BEFORE the export, so the seal covers the null-actor payload) while the
 * destination retains the same event under its own LIVE local account id, every
 * other canonical field — including the stored seal, link and timestamp — identical.
 *
 * Pinned against REAL PostgreSQL: the recovery completes, admission and the
 * post-commit evidence proof agree, the retained row stays BYTE-IDENTICAL (the
 * source's null reference is never written into history), both chains verify, and a
 * row RE-SEALED over its stored local actor stays fail-closed.
 */
describe('P. the BACKUP itself carries an erased actor reference (S21/T31)', () => {
  /**
   * Export a real backup whose audit row lost its actor reference, then put the
   * destination in the reported state: one LIVE local account plus the same event
   * retained under it, unowned (legacy company deletion) and zero companies.
   */
  async function prepareErasedActorState() {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    const source = await createSourceBackup(DESTINATION_KEY, { auditUserId: null });
    expect(source.auditRow.userId).toBeNull();
    await wipeDatabase();
    const liveLocal = await createTestUser('recovery.live.actor@example.test');
    await db.auditLog.create({
      data: { ...source.auditRow, companyId: null, userId: liveLocal.id },
    });
    expect(await db.company.count()).toBe(0);
    return { source, liveLocal };
  }

  it('reuses the retained live local actor byte-identically and finishes the recovery', async () => {
    httpMail.sent.length = 0;
    const { source, liveLocal } = await prepareErasedActorState();
    const before = await auditSnapshot();

    const h = harness();
    const requested = await request(h, source.fileText);
    expect(requested.status, JSON.stringify(requested)).toBe('challenge_sent');
    expect(h.mail).toHaveLength(1);
    const completed = await complete(h, source.fileText, h.mail[0].token);
    expect(completed.status, JSON.stringify(completed)).toBe('restored');
    expect(JSON.stringify(completed)).not.toContain(h.mail[0].token);

    // ONE copy of the event, byte-identical: nothing re-inserted, rewritten,
    // projected or re-signed, and the historical local actor stays as stored.
    const after = await auditSnapshot();
    for (const [id, row] of Object.entries(before)) expect(after[id]).toBe(row);
    const operationId = (completed as { operationId?: string }).operationId;
    expect(Object.keys(after).sort())
      .toEqual([...Object.keys(before), operationId!].sort());
    const copies = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "AuditLog" WHERE id = $1`, source.auditIds[0]);
    expect(copies[0].n).toBe(1);
    const retained = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(retained?.userId).toBe(liveLocal.id);
    expect(retained?.companyId).toBeNull();
    expect(retained?.hash).toBe(source.auditRow.hash);
    // The seal is the NULL-ACTOR one: it verifies over the authenticated source event
    // (null actor + the company the row belonged to) and cannot be reproduced over
    // the stored live local actor or the erased company column.
    expect(computeAuditHash({ ...retained!, companyId: source.companyId, userId: null }))
      .toBe(retained!.hash);
    expect(computeAuditHash({ ...retained! })).not.toBe(retained!.hash);

    // Evidence: the STORED digest, with no fabricated attribution label, and the
    // live local actor is not relabelled into the restored history.
    expect(await provenanceEvidence(source.companyId)).toEqual([
      { id: source.auditIds[0], digest: auditHistoryDigest(retained as never) },
    ]);

    // The accounting data came back and both installation chains still verify.
    expect(await db.company.findMany({ select: { id: true, legalName: true } }))
      .toEqual([{ id: source.companyId, legalName: LEGAL_NAME }]);
    expect(await db.journalEntry.count()).toBe(1);
    const audit = await verifyAuditChain({});
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
    expect((await verifyJournalChain(source.companyId)).valid).toBe(true);
  });

  it('refuses a retained row RE-SEALED over its stored local actor, mutating nothing', async () => {
    httpMail.sent.length = 0;
    const { source, liveLocal } = await prepareErasedActorState();
    // A seal this installation CAN recompute over the stored (live local) actor:
    // valid local history, but NOT the authenticated event's seal, so the mirror
    // allowance must not apply.
    const reSigned = computeAuditHash({
      ...source.auditRow, companyId: null, userId: liveLocal.id,
    });
    await db.$executeRawUnsafe(
      `UPDATE "AuditLog" SET hash = $1 WHERE id = $2`, reSigned, source.auditIds[0]);
    const before = await auditSnapshot();
    const provenanceBefore = await provenanceCount();

    const h = harness();
    expect((await request(h, source.fileText)).status).toBe('challenge_sent');
    const completed = await complete(h, source.fileText, h.mail[0].token);
    expect(completed.status, JSON.stringify(completed)).toBe(400);
    const body = completed as unknown as { code: string; message: string };
    expect(body.code).toBe('RECOVERY_RESTORE_REFUSED');
    expect(body.message).toContain('RESTORE_ID_CONFLICT');
    // The seal and the actor reference are the fields that actually failed.
    expect(body.message).toContain('fields: hash,userId');
    for (const secret of [
      source.auditIds[0], source.companyId, source.ownerId, liveLocal.id,
      OWNER_EMAIL, RECOVERY_PASSWORD, h.mail[0].token, reSigned,
    ]) {
      expect(body.message).not.toContain(secret);
    }

    // Nothing created, rewritten or certified.
    expect(await db.company.count()).toBe(0);
    expect(await auditSnapshot()).toEqual(before);
    expect(await provenanceCount()).toBe(provenanceBefore);
  });
});

/**
 * Q. BOTH COPIES OF THE EVENT ARE UNSEALED (S2/S18/S21/T34, L72).
 *
 * The operator's real installation still refuses completion with
 * `RESTORE_ID_CONFLICT: AuditLog [mismatch: content; fields: userId]`. The trace
 * proved the only reachable emitter is the hash-less branch of the attribution
 * proof: the conflicting events are the UNSEALED audit rows (this database really
 * holds 3 of them), the export copies them verbatim, and their only canonical
 * difference is the actor reference the legacy `ON DELETE SET NULL` erased on the
 * destination row (retained `NULL`, source live).
 *
 * Pinned against REAL PostgreSQL: the recovery completes, the unsealed retained row
 * stays BYTE-IDENTICAL (still unsealed, actor still erased, stored exactly once), the
 * archive freezes those stored bytes together with the erased reference, and a
 * content change in the same pair stays fail-closed with nothing mutated.
 */
describe('Q. the BACKUP and the retained row are both hash-less (S2/S21/T34)', () => {
  /**
   * Export a real backup that carries an UNSEALED audit row, then put the destination
   * in the measured state: the same event retained with its actor reference erased
   * (byte-identical otherwise) and zero companies.
   */
  async function prepareHashlessPairState() {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    const source = await createSourceBackup(DESTINATION_KEY, { hashlessAudit: true });
    const unsealed = source.hashlessAudit;
    expect(unsealed).not.toBeNull();
    expect(unsealed!.hash).toBeNull();
    await wipeDatabase();
    const retained = await db.auditLog.create({
      data: { ...unsealed!, userId: null },
    });
    expect(retained.hash).toBeNull();
    expect(retained.userId).toBeNull();
    expect(await db.company.count()).toBe(0);
    return { source, retained };
  }

  it('reuses the unsealed retained row byte-identically and records the erased reference', async () => {
    httpMail.sent.length = 0;
    const { source, retained } = await prepareHashlessPairState();
    const before = await auditSnapshot();

    const h = harness();
    expect((await request(h, source.fileText)).status).toBe('challenge_sent');
    const completed = await complete(h, source.fileText, h.mail[0].token);
    expect(completed.status, JSON.stringify(completed)).toBe('restored');
    expect(JSON.stringify(completed)).not.toContain(h.mail[0].token);

    // ONE copy of the event, byte-identical: still unsealed, actor still erased.
    const after = await auditSnapshot();
    expect(after[retained.id]).toBe(before[retained.id]);
    expect(JSON.parse(after[retained.id]).hash).toBeNull();
    expect(JSON.parse(after[retained.id]).userId).toBeNull();
    const copies = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "AuditLog" WHERE id = $1`, retained.id);
    expect(copies[0].n).toBe(1);

    // Evidence: the STORED bytes plus the erased reference — never a signature the
    // row does not have.
    const evidence = await provenanceEvidence(source.companyId);
    expect(evidence.find((entry) => entry.id === retained.id)).toEqual({
      id: retained.id,
      digest: auditHistoryDigest(retained as never),
      projectedUserId: source.ownerId,
      sealLess: true,
    });

    // The accounting data came back and the installation still verifies.
    expect(await db.company.count()).toBe(1);
    expect(await db.journalEntry.count()).toBe(1);
    const audit = await verifyAuditChain({});
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
  });

  it('refuses an unsealed pair whose content differs, mutating nothing', async () => {
    httpMail.sent.length = 0;
    const { source, retained } = await prepareHashlessPairState();
    // A rewrite of the unsealed evidence: same id, same missing seal, different
    // content. Nothing describes this row as the authenticated event any more.
    await db.$executeRawUnsafe(
      `UPDATE "AuditLog" SET details = $1 WHERE id = $2`, 'rewritten before recovery', retained.id);
    const before = await auditSnapshot();
    const provenanceBefore = await provenanceCount();

    const h = harness();
    expect((await request(h, source.fileText)).status).toBe('challenge_sent');
    const completed = await complete(h, source.fileText, h.mail[0].token);
    expect(completed.status, JSON.stringify(completed)).toBe(400);
    const body = completed as unknown as { code: string; message: string };
    expect(body.code).toBe('RECOVERY_RESTORE_REFUSED');
    expect(body.message).toContain('RESTORE_ID_CONFLICT');
    expect(body.message).toContain('fields: details');
    for (const secret of [
      retained.id, source.auditIds[0], source.companyId, source.ownerId,
      OWNER_EMAIL, RECOVERY_PASSWORD, h.mail[0].token, 'rewritten before recovery',
    ]) {
      expect(body.message).not.toContain(secret);
    }

    // Nothing created, rewritten or certified.
    expect(await db.company.count()).toBe(0);
    expect(await auditSnapshot()).toEqual(before);
    expect(await provenanceCount()).toBe(provenanceBefore);
  });
});

/**
 * T36 / S2 — THE MEASURED SHAPE OF A REAL DESTINATION, on real PostgreSQL.
 *
 * The portable audit section is COMPANY-SCOPED (`backup.ts` reads it with
 * `where: { companyId }`), so a destination also holds audit rows the backup never
 * carried: rows whose `companyId` is NULL (erased by the legacy company FK) and rows
 * of another tenant. Their stored seals cover references that were destroyed AFTER
 * the backup was exported, so no recomputation here can ever reproduce them.
 *
 * The whole remaining path is proven end to end: the pre-mutation certification gate
 * (G1) accepts them as RETAINED IN PLACE, the archive freezes every preserved row
 * (G5), both installation-wide chains verify over the post-restore state (G7/G8), and
 * a NEW portable export succeeds — which internally runs `assertPortableSourceIntegrity`,
 * i.e. both chain verifiers, over the post-restore installation (checkpoint D).
 */
describe('R. payload-absent retained audit rows are retained in place (T36)', () => {
  const VANISHED_COMPANY = 'company-destroyed-after-export-t36';
  const EARLIER_DESTROYED_COMPANY = 'company-destroyed-earlier-t36';
  const OTHER_TENANT_COMPANY = 'company-other-tenant-t36';
  const DESTROYED_ACTOR = 'user-destroyed-after-export-t36';
  const ids = {
    chain: 'payloadless-chain-1',
    chained: 'payloadless-chain-2',
    unsealed: 'payloadless-unsealed',
  };

  /** A retained row whose SEAL covers references that exist nowhere in the database. */
  async function insertPayloadlessAudit(input: {
    id: string; companyId: string | null; previousHash: string | null;
    sealedCompanyId: string | null; action: string; createdAt: string; hashless?: boolean;
  }) {
    const sealed = {
      id: input.id, companyId: input.sealedCompanyId, userId: DESTROYED_ACTOR,
      action: input.action, entity: 'Company', entityId: null, details: null,
      previousHash: input.previousHash,
    };
    await db.auditLog.create({
      data: {
        id: input.id,
        // The STORED references are the erased / foreign ones.
        companyId: input.companyId,
        userId: null,
        action: input.action,
        entity: 'Company',
        entityId: null,
        details: null,
        previousHash: input.previousHash,
        hash: input.hashless === true ? null : computeAuditHash(sealed),
        createdAt: new Date(input.createdAt),
      },
    });
  }

  /**
   * A real source backup, then the destination state: zero companies, a local
   * eligible owner for the SAME person (so checkpoint D's export is authorized as
   * the product requires), and the payload-absent rows above.
   */
  async function preparePayloadlessState() {
    process.env.HMAC_SECRET = DESTINATION_KEY;
    const source = await createSourceBackup(DESTINATION_KEY);
    await deleteCompanyLikeAdminPath(source.companyId);
    await db.user.delete({ where: { id: source.ownerId } });
    const local = await db.user.create({
      data: {
        email: OWNER_EMAIL,
        passwordHash: await hashPassword(RECOVERY_PASSWORD),
        firstName: '',
        lastName: '',
        platformRole: 'super_admin',
        emailVerifiedAt: new Date('2026-02-01T00:00:00.000Z'),
        legacyUser: false,
      },
    });

    await insertPayloadlessAudit({
      id: ids.chain, companyId: null, previousHash: null,
      sealedCompanyId: VANISHED_COMPANY, action: 'COMPANY_DELETED',
      createdAt: '2026-01-03T10:00:00.000Z',
    });
    const first = await db.auditLog.findUnique({ where: { id: ids.chain } });
    expect(first?.hash).toMatch(/^[a-f0-9]{64}$/);
    await insertPayloadlessAudit({
      id: ids.chained, companyId: OTHER_TENANT_COMPANY, previousHash: first!.hash,
      sealedCompanyId: EARLIER_DESTROYED_COMPANY, action: 'COMPANY_UPDATED',
      createdAt: '2026-01-03T10:00:01.000Z',
    });
    await insertPayloadlessAudit({
      id: ids.unsealed, companyId: null, previousHash: null,
      sealedCompanyId: null, action: 'LEGACY_MAINTENANCE',
      createdAt: '2026-01-03T10:00:02.000Z', hashless: true,
    });
    expect(await db.company.count()).toBe(0);
    // The source installation's own audit row also survives the company deletion (the
    // audit table is never pruned): it is the ONE row the payload carries here, reused
    // verbatim, while the three rows above are payload-absent.
    expect(await db.auditLog.count()).toBe(4);
    return { source, local };
  }

  it('restores 200, certifies both chains and exports a new backup', async () => {
    httpMail.sent.length = 0;
    const { source, local } = await preparePayloadlessState();
    const before = await auditSnapshot();

    // G1: the pre-mutation certification gate. Before T36 this call answered 400
    // `RESTORE_CHAIN: retained destination audit history cannot be certified
    // (local key or archive)` — the exact string the operator reported.
    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status, JSON.stringify(await challenge.clone().json())).toBe(200);
    expect(httpMail.sent).toHaveLength(1);
    const completion = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    const body = await completion.json() as { stage?: string; user?: { id?: string } };
    expect(completion.status, JSON.stringify(body)).toBe(200);
    expect(body.stage).toBe('restored');
    expect(body.user?.id).toBe(local.id);

    // Frozen in place: every payload-absent row is byte-identical afterwards.
    const after = await auditSnapshot();
    for (const id of Object.values(ids)) expect(after[id]).toBe(before[id]);
    expect(JSON.parse(after[ids.unsealed]).hash).toBeNull();

    // G5: the archive covers EVERY preserved row, marking the payload-absent ones
    // with the digest of the bytes this installation stores.
    const retained = {
      chain: await db.auditLog.findUnique({ where: { id: ids.chain } }),
      chained: await db.auditLog.findUnique({ where: { id: ids.chained } }),
      unsealed: await db.auditLog.findUnique({ where: { id: ids.unsealed } }),
    };
    const evidence = await provenanceEvidence(source.companyId) as Array<{
      id: string; digest: string; sealLess?: true; outsidePayload?: true;
    }>;
    expect(evidence.find((entry) => entry.id === ids.chain)).toEqual({
      id: ids.chain, digest: auditHistoryDigestOf(retained.chain as never),
      outsidePayload: true,
    });
    expect(evidence.find((entry) => entry.id === ids.chained)).toEqual({
      id: ids.chained, digest: auditHistoryDigestOf(retained.chained as never),
      outsidePayload: true,
    });
    expect(evidence.find((entry) => entry.id === ids.unsealed)).toEqual({
      id: ids.unsealed, digest: auditHistoryDigestOf(retained.unsealed as never),
      outsidePayload: true, sealLess: true,
    });

    // G7/G8: both installation-wide chains verify over the post-restore state, with
    // the retained rows reaching the recovered events through the stored links.
    const audit = await verifyAuditChain({ companyId: source.companyId });
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
    expect(audit.firstBreak).toBeNull();
    const journal = await verifyJournalChain(source.companyId);
    expect(journal.valid, JSON.stringify(journal.firstBreak)).toBe(true);

    // checkpoint D: the source-integrity gate and a NEW portable export.
    await expect(assertPortableSourceIntegrity(source.companyId)).resolves.toBeUndefined();
    const exported = await createPortableBackup({
      companyId: source.companyId, createdByUserId: local.id, password: RECOVERY_PASSWORD,
    });
    expect(exported.recoveryFilename).toMatch(/_recovery\.json$/);
    expect(exported.portableSize).toBeGreaterThan(0);

    // The new file is readable by the SAME production reader a later recovery uses,
    // and its company-scoped audit section carries the restored source event while
    // the payload-absent rows stay outside any payload by construction.
    const exportedText = Buffer.from(exported.data, 'base64').toString('utf8');
    const reopenedFile = openPortableContainer(exportedText, RECOVERY_PASSWORD, {
      ownerEmail: OWNER_EMAIL, companyLegalName: LEGAL_NAME,
    });
    const reopened = validateRestoreSource(source.companyId, JSON.stringify(reopenedFile.payload.snapshot), {
      recovery: 'portable', authenticatedDigest: reopenedFile.fileDigest,
    });
    expect(reopened.tables.AuditLog.map((row) => row.id)).toContain(source.auditIds[0]);
    for (const id of Object.values(ids)) {
      expect(reopened.tables.AuditLog.map((row) => row.id)).not.toContain(id);
    }
  });

  it('refuses when the payload DOES carry the row and its content differs', async () => {
    httpMail.sent.length = 0;
    const { source } = await preparePayloadlessState();
    // A payload-PRESENT row that is not the authenticated event, next to the frozen
    // payload-absent rows: the classification is per row, never a blanket exemption.
    await db.$executeRawUnsafe(
      `UPDATE "AuditLog" SET details = $1 WHERE id = $2`, 'rewritten before recovery', source.auditIds[0]);
    const before = await auditSnapshot();
    const provenanceBefore = await provenanceCount();

    const challenge = await postBootstrapRestore(challengeBody(source.fileText));
    expect(challenge.status).toBe(200);
    const completion = await postBootstrapRestore({
      ...challengeBody(source.fileText), token: httpMail.sent[0].token,
    });
    const refusal = await completion.json() as { code?: string; error?: string };
    expect(completion.status, JSON.stringify(refusal)).toBe(400);
    expect(refusal.code).toBe('RECOVERY_RESTORE_REFUSED');
    expect(refusal.error).toContain('RESTORE_ID_CONFLICT');
    expect(refusal.error).toContain('fields: details');
    for (const secret of [
      source.auditIds[0], source.companyId, source.ownerId, OWNER_EMAIL,
      RECOVERY_PASSWORD, httpMail.sent[0].token, 'rewritten before recovery',
    ]) {
      expect(refusal.error).not.toContain(secret);
    }
    // Nothing mutated, nothing archived.
    expect(await auditSnapshot()).toEqual(before);
    expect(await provenanceCount()).toBe(provenanceBefore);
    expect(await db.company.count()).toBe(0);
  });
});

/* ─── S23 / S24: the company destination mode (T40 gap closure) ──────── */

let portableRestoreHandler: typeof import('@/app/api/backup/restore/route')['POST'] | undefined;

/**
 * Invoke the REAL in-app restore handler (`POST /api/backup/restore`) for its
 * portable door, as a function: no server, no port, nothing listening. The
 * session cookie is the production one (`createSession` + `getSessionCookieName`)
 * so the door's own authorization runs for real.
 */
async function postPortableRestore(input: {
  door: 'admin' | 'settings';
  sessionToken: string;
  companyId?: string;
  body: Record<string, unknown>;
}) {
  if (!portableRestoreHandler) {
    ({ POST: portableRestoreHandler } = await import('@/app/api/backup/restore/route'));
  }
  const url = new URL('http://127.0.0.1/api/backup/restore');
  url.searchParams.set('mode', 'portable');
  url.searchParams.set('door', input.door);
  if (input.companyId) url.searchParams.set('companyId', input.companyId);
  const request = new NextRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${getSessionCookieName()}=${input.sessionToken}`,
    },
    body: JSON.stringify(input.body),
  });
  return portableRestoreHandler(request, { params: Promise.resolve({}) });
}

/** The portable upload the two session doors accept (same three sealed inputs). */
function portableBody(fileText: string, token?: string) {
  return {
    text: fileText,
    password: RECOVERY_PASSWORD,
    companyName: LEGAL_NAME,
    ownerEmail: OWNER_EMAIL,
    ...(token ? { token } : {}),
  };
}

/**
 * A verified local account that can sit in front of the session doors, plus its
 * real session. Its email IS the backup owner's email and its password opens the
 * backup too, so the documented S4 same-person/different-id path applies.
 */
async function createSessionOwner(role: 'user' | 'super_admin' = 'super_admin') {
  const user = await db.user.create({
    data: {
      email: OWNER_EMAIL,
      passwordHash: await hashPassword(RECOVERY_PASSWORD),
      firstName: '',
      lastName: '',
      platformRole: role,
      emailVerifiedAt: new Date('2026-02-01T00:00:00.000Z'),
      legacyUser: false,
    },
  });
  return { user, sessionToken: await createSession(user.id) };
}

/**
 * A company this installation owns already: the normal onboarding shape (company,
 * membership, chart of accounts, one posted entry sealed by THIS key). `id` lets a
 * case reproduce the S24 state where the backup's company is already present.
 */
async function seedOnboardingCompany(options: {
  legalName: string; ownerId: string; id?: string;
  cashCode?: string; revenueCode?: string; entryDescription?: string;
}) {
  const company = await db.company.create({
    data: {
      ...(options.id ? { id: options.id } : {}),
      legalName: options.legalName,
      entityType: 'BUSINESS',
      taxId: '30-71234567-8',
    },
  });
  await createTestCompanyMember(options.ownerId, company.id);
  const cash = await createTestGlAccount({
    companyId: company.id, code: options.cashCode ?? '1100', name: 'Caja local',
    accountType: 'asset', normalBalance: 'debit',
  });
  const revenue = await createTestGlAccount({
    companyId: company.id, code: options.revenueCode ?? '4100', name: 'Ventas locales',
    accountType: 'revenue', normalBalance: 'credit',
  });
  const entry = await createTestJournalEntry(company.id, {
    date: '2025-06-01',
    description: options.entryDescription ?? 'Venta local previa',
    lines: [
      { glAccountId: cash.id, debit: 100, credit: 0 },
      { glAccountId: revenue.id, debit: 0, credit: 100 },
    ],
  });
  await db.$transaction((tx) => appendEntryToJournalChain(tx, { companyId: company.id, entryId: entry.id }));
  return { companyId: company.id, glAccountIds: [cash.id, revenue.id], journalEntryId: entry.id };
}

/**
 * S. THE COMPANY DESTINATION MODE ON REAL POSTGRESQL (S23 / S24).
 *
 * The two session doors were only covered by isolated tests. Here they run through
 * the REAL production route and the REAL portable engine on the disposable
 * database, because the two shapes they add are exactly the ones an isolated fake
 * client cannot prove:
 *
 *  S23 (Administracion de Empresas, `door=admin`): the destination ALREADY has a
 *      company. The backup's own company must be added NEXT TO it, and the
 *      retained history of the other tenant must survive byte-identically while
 *      both lineages keep verifying.
 *  S24 (Configuracion -> Respaldos, `door=settings`): the backup's company already
 *      exists here, so its data is REPLACED in place. That company's own previous
 *      audit rows are the replacement's scope (never "retained history"), while
 *      every row outside it stays frozen and the archive records the provenance.
 *  Refusal: a company-scoped door whose active company is NOT the company inside
 *      the opened backup is refused by name, before any token exists and without
 *      mutating anything.
 */
describe('S. the company destination mode on real PostgreSQL (S23/S24)', () => {
  const OTHER_LEGAL_NAME = 'Otra Empresa Local S.A.';
  const OTHER_EMAIL = 'contadora.otra.empresa@example.test';

  it('S23: adds the backup company next to an existing one and preserves its retained history', async () => {
    httpMail.sent.length = 0;
    const source = await createSourceBackup(SOURCE_KEY);
    await wipeDatabase();
    process.env.HMAC_SECRET = DESTINATION_KEY;

    // A normal installation: one company loaded through onboarding, plus a second
    // account of the same owner for it. Nothing is fabricated for the recovery.
    const owner = await createSessionOwner();
    const other = await seedOnboardingCompany({ legalName: OTHER_LEGAL_NAME, ownerId: owner.user.id });
    const otherMember = await db.user.create({
      data: {
        email: OTHER_EMAIL,
        passwordHash: await hashPassword('Otra-Clave-Local-2026'),
        firstName: '',
        lastName: '',
        platformRole: 'user',
        emailVerifiedAt: new Date('2026-02-01T00:00:00.000Z'),
        legacyUser: false,
      },
    });
    await createTestCompanyMember(otherMember.id, other.companyId);
    // The other tenant's own audit evidence, sealed by THIS installation's key.
    const otherAudit = await createAuditLogWithRetry({
      companyId: other.companyId, userId: owner.user.id, action: 'JOURNAL_POSTED',
      entity: 'JournalEntry', entityId: other.journalEntryId,
    });

    expect(await db.company.count()).toBe(1);
    expect(await db.company.findUnique({ where: { id: source.companyId } })).toBeNull();
    const before = await auditSnapshot();
    const otherCompanyBefore = await db.company.findUnique({ where: { id: other.companyId } });
    const otherEntryBefore = await db.journalEntry.findUnique({ where: { id: other.journalEntryId } });

    // Stage 1 — the admin door authorizes the file and mails the owner token.
    const challenge = await postPortableRestore({
      door: 'admin', sessionToken: owner.sessionToken, body: portableBody(source.fileText),
    });
    expect(challenge.status, JSON.stringify(await challenge.clone().json())).toBe(200);
    const challengeJson = await challenge.json() as { stage?: string };
    expect(challengeJson.stage).toBe('challenge_sent');
    expect(httpMail.sent).toHaveLength(1);
    expect(httpMail.sent[0]).toMatchObject({ type: 'recovery', to: OWNER_EMAIL });
    expect(httpMail.sent[0].token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(challengeJson)).not.toContain(httpMail.sent[0].token);

    // Stage 2 — the backup's own company is ADDED next to the existing one.
    const completion = await postPortableRestore({
      door: 'admin', sessionToken: owner.sessionToken,
      body: portableBody(source.fileText, httpMail.sent[0].token),
    });
    const body = await completion.json() as {
      success?: boolean; stage?: string; code?: string; error?: string; operationId?: string;
    };
    expect(completion.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ success: true, stage: 'restored' });
    expect(body.operationId).toBeTruthy();
    // The session door never mints a second session.
    expect(completion.headers.get('set-cookie')).toBeNull();
    expect(await db.session.count()).toBe(1);

    // TWO companies now: the pre-existing one untouched, the backup's one created.
    const companies = await db.company.findMany({ select: { id: true, legalName: true } });
    expect(companies).toHaveLength(2);
    expect(companies).toEqual(expect.arrayContaining([
      { id: other.companyId, legalName: OTHER_LEGAL_NAME },
      { id: source.companyId, legalName: LEGAL_NAME },
    ]));
    expect(await db.company.findUnique({ where: { id: other.companyId } })).toEqual(otherCompanyBefore);

    // The restored accounting data landed in the NEW company only.
    expect(await db.glAccount.count({ where: { companyId: source.companyId } })).toBe(2);
    expect(await db.journalEntry.count({ where: { companyId: source.companyId } })).toBe(1);
    expect(await db.journalLine.count({ where: { entry: { companyId: source.companyId } } })).toBe(2);
    expect(await db.companyMember.count({ where: { companyId: source.companyId } })).toBe(1);
    expect(await db.companyMember.findUnique({
      where: { userId_companyId: { userId: owner.user.id, companyId: source.companyId } },
    })).not.toBeNull();

    // The OTHER company's retained history is byte-identical and still complete.
    expect(await db.journalEntry.findUnique({ where: { id: other.journalEntryId } })).toEqual(otherEntryBefore);
    expect(await db.glAccount.count({ where: { companyId: other.companyId } })).toBe(2);
    expect(await db.companyMember.findUnique({
      where: { userId_companyId: { userId: otherMember.id, companyId: other.companyId } },
    })).not.toBeNull();
    const after = await auditSnapshot();
    for (const [id, row] of Object.entries(before)) expect(after[id]).toBe(row);
    expect(Object.keys(after).sort())
      .toEqual([...Object.keys(before), source.auditIds[0], body.operationId!].sort());

    // Nothing was recreated or promoted: the one session account keeps its own
    // credentials, and the deleted source account is not resurrected.
    expect(await db.user.count()).toBe(2);
    expect(await db.user.findUnique({ where: { id: owner.user.id } })).toMatchObject({
      email: OWNER_EMAIL, platformRole: 'super_admin', passwordHash: owner.user.passwordHash,
    });
    expect(await db.user.findUnique({ where: { id: source.ownerId } })).toBeNull();

    // The recovered row keeps the SOURCE seal: the archive certifies it, and
    // nothing was re-signed under this installation's key.
    const restoredAudit = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(restoredAudit?.companyId).toBe(source.companyId);
    expect(computeAuditHash({
      id: restoredAudit!.id, companyId: restoredAudit!.companyId, userId: restoredAudit!.userId,
      action: restoredAudit!.action, entity: restoredAudit!.entity, entityId: restoredAudit!.entityId,
      details: restoredAudit!.details, previousHash: restoredAudit!.previousHash,
    })).not.toBe(restoredAudit!.hash);

    // Provenance: one record, the recovered row plus the OTHER company's retained
    // row as payload-absent evidence (frozen stored bytes, never re-signed).
    expect(await provenanceCount()).toBe(1);
    const evidence = await provenanceEvidence(source.companyId) as Array<{
      id: string; digest: string; outsidePayload?: true;
    }>;
    const otherRowAfter = await db.auditLog.findUnique({ where: { id: otherAudit.id } });
    expect(evidence.find((entry) => entry.id === otherAudit.id)).toEqual({
      id: otherAudit.id, digest: auditHistoryDigest(otherRowAfter as never), outsidePayload: true,
    });
    expect(evidence.find((entry) => entry.id === source.auditIds[0])?.digest)
      .toBe(auditHistoryDigest(restoredAudit as never));

    // BOTH chains verify afterwards: each tenant's journal lineage and the
    // installation-wide audit history.
    expect((await verifyJournalChain(source.companyId)).valid).toBe(true);
    expect((await verifyJournalChain(other.companyId)).valid).toBe(true);
    const audit = await verifyAuditChain({});
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
    expect(audit.firstBreak).toBeNull();
  });

  it('S24: replaces the already-present company data and keeps every preserved row byte-identical', async () => {
    httpMail.sent.length = 0;
    const source = await createSourceBackup(SOURCE_KEY);
    await wipeDatabase();
    process.env.HMAC_SECRET = DESTINATION_KEY;

    const owner = await createSessionOwner();
    // The backup's company ALREADY exists here (same id) with its own local data.
    const target = await seedOnboardingCompany({
      id: source.companyId, legalName: LEGAL_NAME, ownerId: owner.user.id,
      cashCode: '1999', revenueCode: '4999', entryDescription: 'Venta local anterior',
    });
    // A target-company audit row the payload does NOT carry: it is the replacement's
    // own scope, never "retained history" the restore must preserve.
    const ownRow = await db.auditLog.create({
      data: {
        companyId: source.companyId, userId: null, action: 'COMPANY_UPDATED',
        entity: 'Company', entityId: null, details: 'local row outside the payload',
        previousHash: null, hash: null, createdAt: new Date('2026-01-05T10:00:00.000Z'),
      },
    });
    // An installation-wide retained row (outside the target company): real history
    // this replacement must never touch.
    const retainedId = 'retained-installation-row-s24';
    const retainedHash = await insertLocalAudit({
      id: retainedId, companyId: null, action: 'GLOBAL_MAINTENANCE',
      previousHash: null, createdAt: '2026-01-05T10:00:01.000Z', secret: DESTINATION_KEY,
    });

    expect(await db.company.count()).toBe(1);
    const before = await auditSnapshot();
    expect(Object.keys(before).sort()).toEqual([ownRow.id, retainedId].sort());

    // Stage 1 — the settings door, with the backup's company as the ACTIVE one.
    const challenge = await postPortableRestore({
      door: 'settings', companyId: source.companyId,
      sessionToken: owner.sessionToken, body: portableBody(source.fileText),
    });
    expect(challenge.status, JSON.stringify(await challenge.clone().json())).toBe(200);
    expect((await challenge.json() as { stage?: string }).stage).toBe('challenge_sent');
    expect(httpMail.sent).toHaveLength(1);

    // Stage 2 — the existing company is replaced in place.
    const completion = await postPortableRestore({
      door: 'settings', companyId: source.companyId,
      sessionToken: owner.sessionToken,
      body: portableBody(source.fileText, httpMail.sent[0].token),
    });
    const body = await completion.json() as {
      success?: boolean; stage?: string; code?: string; error?: string; operationId?: string;
    };
    expect(completion.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ success: true, stage: 'restored' });

    // NO company was created: the target company kept its identity and took the
    // backup's data.
    expect(await db.company.count()).toBe(1);
    expect(await db.company.findUnique({ where: { id: source.companyId } })).toMatchObject({
      id: source.companyId, legalName: LEGAL_NAME,
    });
    expect(await db.glAccount.count({ where: { companyId: source.companyId } })).toBe(2);
    expect(await db.glAccount.findMany({
      where: { companyId: source.companyId }, select: { code: true }, orderBy: { code: 'asc' },
    })).toEqual([{ code: '1010' }, { code: '4010' }]);
    expect(await db.journalEntry.findUnique({ where: { id: target.journalEntryId } })).toBeNull();
    expect(await db.journalEntry.count({ where: { companyId: source.companyId } })).toBe(1);
    expect(await db.journalEntry.findFirst({
      where: { companyId: source.companyId }, select: { description: true },
    })).toEqual({ description: 'Venta de origen' });
    expect(await db.journalLine.count({ where: { entry: { companyId: source.companyId } } })).toBe(2);

    // New rows: the authenticated source event plus this operation's own receipt.
    const after = await auditSnapshot();
    expect(Object.keys(after).sort())
      .toEqual([...Object.keys(before), source.auditIds[0], body.operationId!].sort());

    // S24 / T42 — THE EXCLUSION PIN, RE-PINNED WITH A STATED REASON.
    // It used to demand that the target's own row be ABSENT from the recorded
    // evidence ("the replacement's scope"), which was the same target-company filter
    // that hid attested target-scoped rows from the post-commit proof while the
    // admission validator certified over ALL retained rows (the L88 asymmetry that
    // produced the reported RECOVERY_HISTORY_LOST). No restore deletes `AuditLog`
    // rows, so this row is RETAINED history: it is frozen with the digest of its
    // stored bytes plus the explicit `outsidePayload` marker (and `sealLess`, since
    // it carries no seal). Only `assertDestinationAuditPreserved` still scopes to the
    // rows OUTSIDE the target company.
    expect(after[ownRow.id]).toBe(before[ownRow.id]);
    const evidence = await provenanceEvidence(source.companyId) as Array<{
      id: string; digest: string; outsidePayload?: true; sealLess?: true;
    }>;
    const ownRowAfter = await db.auditLog.findUnique({ where: { id: ownRow.id } });
    expect(evidence.find((entry) => entry.id === ownRow.id)).toEqual({
      id: ownRow.id, digest: auditHistoryDigest(ownRowAfter as never),
      outsidePayload: true, sealLess: true,
    });

    // Every PRESERVED row stays byte-identical and is archived as payload-absent.
    expect(after[retainedId]).toBe(before[retainedId]);
    const retainedAfter = await db.auditLog.findUnique({ where: { id: retainedId } });
    expect(retainedAfter?.hash).toBe(retainedHash);
    expect(evidence.find((entry) => entry.id === retainedId)).toEqual({
      id: retainedId, digest: auditHistoryDigest(retainedAfter as never), outsidePayload: true,
    });

    // The recovered history keeps its SOURCE seal and is archived, and exactly one
    // provenance record was written for this company.
    const restoredAudit = await db.auditLog.findUnique({ where: { id: source.auditIds[0] } });
    expect(restoredAudit?.companyId).toBe(source.companyId);
    expect(computeAuditHash({
      id: restoredAudit!.id, companyId: restoredAudit!.companyId, userId: restoredAudit!.userId,
      action: restoredAudit!.action, entity: restoredAudit!.entity, entityId: restoredAudit!.entityId,
      details: restoredAudit!.details, previousHash: restoredAudit!.previousHash,
    })).not.toBe(restoredAudit!.hash);
    expect(evidence.find((entry) => entry.id === source.auditIds[0])?.digest)
      .toBe(auditHistoryDigest(restoredAudit as never));
    expect(await provenanceCount()).toBe(1);

    // Both chains verify over the post-restore state.
    const journal = await verifyJournalChain(source.companyId);
    expect(journal.valid, JSON.stringify(journal.firstBreak)).toBe(true);
    const audit = await verifyAuditChain({});
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
    expect(audit.firstBreak).toBeNull();
  });

  it('S24/T42: certifies a target-scoped retained row whose actor reference the legacy FK erased', async () => {
    // THE OWNER'S EXACT SHAPE (L88): the same installation created the backup, then a
    // company/account deletion nulled the actor reference of audit rows that carry the
    // TARGET company id while their seal still covers the destroyed reference. The
    // completion used to fail with RECOVERY_HISTORY_LOST because the post-commit proof
    // read a filtered set while admission certified over every retained row.
    httpMail.sent.length = 0;
    const source = await createSourceBackup(SOURCE_KEY);
    await wipeDatabase();
    // SAME installation key: this is the documented same-machine restore, so the seal
    // the destination kept is the one this installation wrote.
    process.env.HMAC_SECRET = SOURCE_KEY;

    const owner = await createSessionOwner();
    // The backup's company is already here (S24: replace in place).
    await seedOnboardingCompany({
      id: source.companyId, legalName: LEGAL_NAME, ownerId: owner.user.id,
      cashCode: '1999', revenueCode: '4999', entryDescription: 'Venta local anterior',
    });
    // The historical local actor this installation once attributed the event to, and
    // the retained copy of the event itself: SAME id, same seal, target-scoped, with
    // the actor reference the legacy foreign key is about to erase.
    const retainedId = source.auditIds[0];
    const legacyActor = await db.user.create({
      data: {
        id: source.ownerId,
        email: 'actor.historico.t42@example.test',
        passwordHash: await hashPassword('actor-historico-t42'),
        firstName: '',
        lastName: '',
        isActive: false,
        emailVerifiedAt: null,
        legacyUser: true,
      },
    });
    await db.auditLog.create({
      data: {
        id: retainedId,
        companyId: source.auditRow.companyId,
        userId: legacyActor.id,
        action: source.auditRow.action,
        entity: source.auditRow.entity,
        entityId: source.auditRow.entityId,
        details: source.auditRow.details,
        previousHash: source.auditRow.previousHash,
        hash: source.auditRow.hash,
        createdAt: source.auditRow.createdAt,
      },
    });
    // The real legacy `ON DELETE SET NULL` erases the reference; the seal stays over
    // the destroyed value, exactly like the owner's installation.
    await deleteOwnerUnderLegacyConstraint(legacyActor.id);
    const retainedRow = await db.auditLog.findUnique({ where: { id: retainedId } });
    expect(retainedRow).toMatchObject({
      userId: null, hash: source.auditRow.hash, companyId: source.companyId,
    });
    const before = await auditSnapshot();

    // Stage 1 — the settings door with the backup's company as the ACTIVE one.
    const challenge = await postPortableRestore({
      door: 'settings', companyId: source.companyId,
      sessionToken: owner.sessionToken, body: portableBody(source.fileText),
    });
    expect(challenge.status, JSON.stringify(await challenge.clone().json())).toBe(200);
    expect(httpMail.sent).toHaveLength(1);

    // Stage 2 — completion. Admission certified the erased-reference projection, so the
    // post-commit proof must certify the SAME retained row instead of reporting the
    // untouched stored bytes as "rewritten".
    const completion = await postPortableRestore({
      door: 'settings', companyId: source.companyId,
      sessionToken: owner.sessionToken,
      body: portableBody(source.fileText, httpMail.sent[0].token),
    });
    const body = await completion.json() as {
      success?: boolean; stage?: string; code?: string; error?: string; operationId?: string;
    };
    expect(completion.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ success: true, stage: 'restored' });

    // The retained row is byte-identical: never rewritten, never re-signed, one copy.
    const after = await auditSnapshot();
    expect(after[retainedId]).toBe(before[retainedId]);
    expect((await db.auditLog.findMany({ where: { id: retainedId } }))).toHaveLength(1);

    // Evidence describes the STORED bytes and records the proven original actor.
    const evidence = await provenanceEvidence(source.companyId) as Array<{
      id: string; digest: string; projectedUserId?: string;
    }>;
    const retainedAfter = await db.auditLog.findUnique({ where: { id: retainedId } });
    expect(evidence.find((entry) => entry.id === retainedId)).toEqual({
      id: retainedId, digest: auditHistoryDigest(retainedAfter as never),
      projectedUserId: source.ownerId,
    });
    expect(await provenanceCount()).toBe(1);

    // Both chains verify over the post-restore state.
    const journal = await verifyJournalChain(source.companyId);
    expect(journal.valid, JSON.stringify(journal.firstBreak)).toBe(true);
    const audit = await verifyAuditChain({});
    expect(audit.valid, JSON.stringify(audit.firstBreak)).toBe(true);
    expect(audit.firstBreak).toBeNull();
  });

  it('refuses a company target that is not the company inside the backup, mutating nothing', async () => {
    httpMail.sent.length = 0;
    const source = await createSourceBackup(SOURCE_KEY);
    await wipeDatabase();
    process.env.HMAC_SECRET = DESTINATION_KEY;

    const owner = await createSessionOwner();
    const other = await seedOnboardingCompany({ legalName: OTHER_LEGAL_NAME, ownerId: owner.user.id });
    const before = await auditSnapshot();
    const companyBefore = await db.company.findUnique({ where: { id: other.companyId } });

    // The active company is NOT the company sealed in the opened backup: the door
    // names the situation and cuts before any token is issued.
    const refused = await postPortableRestore({
      door: 'settings', companyId: other.companyId,
      sessionToken: owner.sessionToken, body: portableBody(source.fileText),
    });
    const body = await refused.json() as { code?: string; error?: string };
    expect(refused.status, JSON.stringify(body)).toBe(409);
    expect(body.code).toBe('RECOVERY_ACTIVE_COMPANY_MISMATCH');
    // No token was ever mailed for a refused destination.
    expect(httpMail.sent).toHaveLength(0);

    // Nothing was mutated: no company added, no data replaced, no archive, no
    // audit row touched.
    expect(await db.company.count()).toBe(1);
    expect(await db.company.findUnique({ where: { id: other.companyId } })).toEqual(companyBefore);
    expect(await db.company.findUnique({ where: { id: source.companyId } })).toBeNull();
    expect(await db.glAccount.count({ where: { companyId: other.companyId } })).toBe(2);
    expect(await db.journalEntry.count({ where: { companyId: other.companyId } })).toBe(1);
    expect(await db.companyMember.count()).toBe(1);
    expect(await db.user.count()).toBe(1);
    expect(await provenanceCount()).toBe(0);
    expect(await auditSnapshot()).toEqual(before);
  });
});
