import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { POST as backupPOST } from '../../src/app/api/backup/route';
import { POST as restorePOST } from '../../src/app/api/backup/restore/route';
import { db } from '@/lib/db';
import { BACKUP_DIR } from '@/lib/config/paths';
import { createSession } from '@/lib/sessions';
import { hashPassword } from '@/lib/auth';
import { sealSnapshot } from '@/lib/backup-format';
import { computeAuditHash, verifyAuditChain, verifyJournalChain } from '@/lib/journal-hash';
import { POST as adminCompaniesPOST } from '../../src/app/api/admin/companies/route';
import { appendEntryToJournalChain } from '@/lib/journal-chain';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  createTestBankAccount,
  createTestBankStatement,
  createTestBankTransaction,
  createTestJournalEntry,
  clearDatabase,
} from '../helpers/factories';

/**
 * T3 (S6) — historical re-anchoring, and T4 (S5) — legacy plain-text refusal.
 *
 * A backup made on another installation carries an audit segment whose first
 * row chains to a predecessor that was lost with that installation (L2: 302
 * intact transactions, chain unrootable). Restoring it used to die at
 * RESTORE_CHAIN. On a provably empty destination the segment may now be
 * re-based under the current secret with a sealed RESTORE_REBASE root that
 * documents backup id, the lost predecessor hash and the re-anchor date. On a
 * non-empty destination the exact RESTORE_CHAIN refusal must remain.
 *
 * Legacy plain-text files (no sealed current-system format) are refused with
 * their own Spanish message before any mutation.
 */
const OWNER_PASSWORD = 'Clave.Reanchor.2026';
/** The predecessor the old installation took with it. */
const LOST_PREDECESSOR = 'f'.repeat(64);
const INTEGRITY_SCOPE = 'JSON.stringify({manifest-without-integrity,data})';

function backupFiles(): string[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .sort();
}

function rows(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function decode(base64: string): Record<string, any> {
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function postBackup(token: string, companyId: string, body: unknown) {
  return backupPOST(
    new NextRequest(`http://localhost/api/backup?companyId=${companyId}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

async function postRestore(token: string, companyId: string, body: unknown) {
  return restorePOST(
    new NextRequest(`http://localhost/api/backup/restore?companyId=${companyId}`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

/** One stored audit member: its own HMAC is always recomputed from the stored link. */
function auditMember(id: string, previousHash: string | null, createdAt: string, companyId: string) {
  const row: Record<string, any> = {
    id,
    companyId,
    userId: null,
    action: 'HISTORICAL_POST',
    entity: 'Backup',
    entityId: null,
    details: JSON.stringify({ id }),
    hash: null,
    previousHash,
    createdAt,
  };
  row.hash = computeAuditHash(row as never);
  return row;
}

/** Publish the payload with a replaced audit segment, exactly as a file would carry it. */
function withAuditSegment(payload: Record<string, any>, segment: Record<string, any>[]): string {
  payload.data.auditLogs = segment;
  payload.manifest.recordCounts.auditLogs = segment.length;
  sealSnapshot(payload as never);
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/**
 * A legacy plain-text file: a raw JSON snapshot sealed with the old UNKEYED
 * sha256 digest, i.e. without the current sealed (HMAC) format. That is exactly
 * what an old installation wrote to disk.
 */
function legacyPlainText(payload: Record<string, any>): string {
  const { integrity: _integrity, ...manifest } = payload.manifest;
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify({ manifest, data: payload.data }), 'utf8')
    .digest('hex');
  const legacy = {
    ...payload,
    manifest: {
      ...manifest,
      integrity: { algorithm: 'sha256', encoding: 'utf8', scope: INTEGRITY_SCOPE, authenticated: false, digest },
    },
  };
  return Buffer.from(JSON.stringify(legacy), 'utf8').toString('base64');
}

/**
 * A verifiably empty destination: the restore target keeps only its shell
 * (Company/User/CompanyMember) and no restorable row, no audit chain member and
 * no journal chain head remains.
 */
async function emptyDestination(companyId: string) {
  await db.auditLog.deleteMany({ where: { hash: { not: null } } });
  await db.journalChainHead.deleteMany({ where: { companyId } });
  await db.journalLine.deleteMany({ where: { entry: { companyId } } });
  await db.journalEntry.deleteMany({ where: { companyId } });
  await db.bankTransaction.deleteMany({ where: { statement: { companyId } } });
  await db.bankStatement.deleteMany({ where: { companyId } });
  await db.bankAccount.deleteMany({ where: { companyId } });
  await db.glAccount.deleteMany({ where: { companyId } });
}

async function createFixture(companyId: string) {
  const gl = await createTestGlAccount({
    companyId,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  const bankAccount = await createTestBankAccount(companyId, gl.id, 'Test Bank');
  const statement = await createTestBankStatement(companyId, bankAccount.id);
  await createTestBankTransaction(companyId, statement.id, {
    date: '2025-03-15',
    amount: 500.0,
    description: 'Test deposit',
    reference: 'REF-001',
  });
  const entry = await createTestJournalEntry(companyId, {
    date: '2025-03-15',
    description: 'Test entry',
    lines: [
      { glAccountId: gl.id, debit: 500, credit: 0 },
      { glAccountId: gl.id, debit: 0, credit: 500 },
    ],
  });
  await db.$transaction((tx) => appendEntryToJournalChain(tx, { companyId, entryId: entry.id }));
  return { gl, bankAccount, statement, entry };
}

/**
 * The S6 contract "re-anchor only on a provably EMPTY destination" is evaluated
 * against the whole installation, and `clearDatabase()` only removes companies
 * that still have a test member: a company another file left behind without
 * members — or whose delete was blocked by a child row — survives it and makes
 * the destination look installed, turning the re-anchor into a RESTORE_CHAIN
 * refusal. The fixture database is disposable: start from an empty installation
 * by removing every company, user, membership, session and dormant identity row
 * before the first test.
 */
async function wipeInstallation() {
  if (!(process.env.DATABASE_URL ?? '').includes('test')) {
    throw new Error('wipeInstallation() REFUSED: DATABASE_URL does not point to a test database');
  }
  // RESTRICT edges first: these children block the cascade from Company/User.
  await db.bankTransaction.deleteMany();
  await db.bankStatement.deleteMany();
  await db.bankAccount.deleteMany();
  await db.journalLine.deleteMany();
  await db.journalEntry.deleteMany();
  await db.reconciliationPeriod.deleteMany();
  await db.ruleApplyRecord.deleteMany();
  // CompanyKnowledge is not cascaded from Company and its children point at it.
  await db.knowledgeAudit.deleteMany();
  await db.pendingApproval.deleteMany();
  await db.companyKnowledge.updateMany({ data: { mergedIntoId: null } });
  await db.companyKnowledge.deleteMany();
  // Everything else that hangs off a company cascades with it.
  await db.company.deleteMany();
  await db.companyMember.deleteMany();
  await db.session.deleteMany();
  await db.user.deleteMany();
  await db.identityPendingRegistration.deleteMany();
  await db.identityChallenge.deleteMany();
  await db.identityRateLimit.deleteMany();
  await db.identitySecurityEvent.deleteMany();
}

beforeAll(async () => {
  await wipeInstallation();
});

describe('historical audit re-anchoring (S6) and legacy plain-text refusal (S5)', () => {
  let user: { id: string };
  let company: { id: string };
  let token: string;

  beforeEach(async () => {
    await clearDatabase();
    // An installation-wide chain cannot be certified by a coordinated restore;
    // only hashed rows are removed (see tests/api/backup-restore.test.ts).
    await db.auditLog.deleteMany({ where: { hash: { not: null } } });
    user = await createTestUser('reanchor-sro@example.com');
    await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(OWNER_PASSWORD) } });
    company = await createTestCompany('Reanchor Corp');
    await createTestCompanyMember(user.id, company.id);
    token = await createSession(user.id);
    await createFixture(company.id);
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('re-anchors an unrooted segment on a provably empty destination with a sealed RESTORE_REBASE root', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    const payload = decode(created.data);
    const first = auditMember('segment-first', LOST_PREDECESSOR, '2025-01-01T00:00:00.000Z', company.id);
    const second = auditMember('segment-second', first.hash, '2025-01-02T00:00:00.000Z', company.id);
    const data = withAuditSegment(payload, [first, second]);
    await emptyDestination(company.id);

    const res = await postRestore(token, company.id, { data, ownerPassword: OWNER_PASSWORD });
    const body = await res.json();
    expect(body.error ?? '').toBe('');
    expect(res.status).toBe(200);
    expect(body.status).toBe('committed');

    const members = (await db.auditLog.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
      .filter((row) => row.hash != null);
    expect(members).toHaveLength(3);

    const [rebase, rebasedFirst, rebasedSecond] = members;
    // (1) The re-anchor is the FIRST entry, rooted at previousHash = null and
    //     itself hashed, and it documents the operation.
    expect(rebase.action).toBe('RESTORE_REBASE');
    expect(rebase.previousHash).toBeNull();
    expect(rebase.hash).toBe(computeAuditHash(rebase as never));
    const evidence = JSON.parse(rebase.details as string);
    expect(Object.keys(evidence).sort()).toEqual(['backupId', 'originalPredecessorHash', 'rebasedAt']);
    expect(evidence.backupId).toBe(payload.manifest.id);
    expect(evidence.originalPredecessorHash).toBe(LOST_PREDECESSOR);
    expect(new Date(evidence.rebasedAt).toISOString()).toBe(evidence.rebasedAt);

    // (2) The segment keeps its rows and its substance, re-based from the new root.
    expect(rebasedFirst.id).toBe('segment-first');
    expect(rebasedFirst.action).toBe('HISTORICAL_POST');
    expect(rebasedFirst.previousHash).toBe(rebase.hash);
    expect(rebasedFirst.hash).toBe(computeAuditHash(rebasedFirst as never));
    expect(rebasedFirst.hash).not.toBe(first.hash);
    expect(rebasedSecond.id).toBe('segment-second');
    expect(rebasedSecond.previousHash).toBe(rebasedFirst.hash);
    expect(rebasedSecond.hash).toBe(computeAuditHash(rebasedSecond as never));

    // (3) The restored installation certifies its own audit chain again.
    expect((await verifyAuditChain()).valid).toBe(true);
  });

  it('keeps the RESTORE_CHAIN refusal byte-for-byte on a non-empty destination', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    const payload = decode(created.data);
    const first = auditMember('segment-first', LOST_PREDECESSOR, '2025-01-01T00:00:00.000Z', company.id);
    const second = auditMember('segment-second', first.hash, '2025-01-02T00:00:00.000Z', company.id);
    const data = withAuditSegment(payload, [first, second]);
    // The destination keeps its own data and its own (hashed) audit history.
    const auditBefore = rows(await db.auditLog.findMany({ orderBy: { id: 'asc' } }));
    const files = backupFiles();

    const res = await postRestore(token, company.id, { data, ownerPassword: OWNER_PASSWORD });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      'RESTORE_CHAIN: replacement cannot certify installation-wide audit order; preserve other tenants and do not re-sign',
    );

    expect(rows(await db.auditLog.findMany({ orderBy: { id: 'asc' } }))).toEqual(auditBefore);
    expect(await db.auditLog.count({ where: { action: 'RESTORE_REBASE' } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'COMPANY_RESTORE_COMMITTED' } })).toBe(0);
    expect(backupFiles()).toEqual(files);
  });

  it('restores a rooted segment on an empty destination without inventing a re-anchor', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    const payload = decode(created.data);
    const root = auditMember('root-first', null, '2025-01-01T00:00:00.000Z', company.id);
    const second = auditMember('root-second', root.hash, '2025-01-02T00:00:00.000Z', company.id);
    const data = withAuditSegment(payload, [root, second]);
    await emptyDestination(company.id);

    const res = await postRestore(token, company.id, { data, ownerPassword: OWNER_PASSWORD });
    const body = await res.json();
    expect(body.error ?? '').toBe('');
    expect(res.status).toBe(200);
    expect(body.status).toBe('committed');

    expect(await db.auditLog.count({ where: { action: 'RESTORE_REBASE' } })).toBe(0);
    const members = (await db.auditLog.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
      .filter((row) => row.hash != null);
    // Stored HMACs are preserved exactly: nothing was re-signed.
    expect(members.map((row) => [row.id, row.hash, row.previousHash])).toEqual([
      [root.id, root.hash, null],
      [second.id, second.hash, root.hash],
    ]);
    expect((await verifyAuditChain()).valid).toBe(true);
  });

  it('refuses a legacy plain-text backup with RESTORE_LEGACY_FORMAT and mutates nothing', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    const legacy = legacyPlainText(decode(created.data));
    const glBefore = rows(await db.glAccount.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } }));
    const auditBefore = rows(await db.auditLog.findMany({ orderBy: { id: 'asc' } }));
    const files = backupFiles();

    const res = await postRestore(token, company.id, { data: legacy, ownerPassword: OWNER_PASSWORD });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('RESTORE_LEGACY_FORMAT');
    // Spanish, and it says why: the file predates sealed backups and has to be
    // re-created with the current system.
    expect(body.error).toContain('respaldo');
    expect(body.error).toContain('ACCOUNTEXPRESS-ENCRYPTED-BACKUP/1');
    expect(body.error).toContain('volver a generar');

    expect(rows(await db.glAccount.findMany({ where: { companyId: company.id }, orderBy: { id: 'asc' } }))).toEqual(glBefore);
    expect(rows(await db.auditLog.findMany({ orderBy: { id: 'asc' } }))).toEqual(auditBefore);
    expect(await db.auditLog.count({ where: { action: 'COMPANY_RESTORE_COMMITTED' } })).toBe(0);
    expect(backupFiles()).toEqual(files);
  });

  it('verifies the ownership credential before the legacy-format refusal', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    const payload = decode(created.data);
    delete payload.manifest.ownership;
    const legacy = legacyPlainText(payload);

    const res = await postRestore(token, company.id, { data: legacy, ownerPassword: OWNER_PASSWORD });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('RESTORE_OWNERSHIP');
    expect(body.error).toContain('credencial de propiedad');
  });
});


/* ─── S4 (T5): restoring the sixth company into an active installation ──
 * "¿qué pasa si tengo 5 empresas y quiero restaurar la 6 que está en un
 * backup?" — a super_admin creates an empty company through the existing admin
 * route and restores the archive TARGETING that shell. The production
 * installation keeps running: every other tenant's rows, journal chain and the
 * installation-wide LIVE audit chain stay byte-identical, while the archive's
 * rows are remapped onto the new company id, its journal chain is re-sealed
 * under the new tenant identity (the tenant id is part of the HMAC payload) and
 * its audit segment lands as CLOSED HISTORICAL evidence that is never a member
 * of the live chain.
 */
const LIVE_HEAD_ONE = '2025-05-01T00:00:00.000Z';
const LIVE_HEAD_TWO = '2025-05-02T00:00:00.000Z';

/** A member of the installation-wide LIVE audit chain (hash + stored link). */
async function liveMember(
  id: string,
  previousHash: string | null,
  createdAt: string,
  companyId: string,
  action: string,
) {
  const row: Record<string, any> = {
    id,
    companyId,
    userId: null,
    action,
    entity: 'Company',
    entityId: companyId,
    details: JSON.stringify({ id }),
    hash: null,
    previousHash,
    createdAt,
  };
  row.hash = computeAuditHash(row as never);
  await db.auditLog.create({ data: row as never });
  return row;
}

/** The real admin company-creation route: identity, membership, seeded chart. */
async function adminCompany(token: string, legalName: string) {
  const res = await adminCompaniesPOST(
    new NextRequest('http://localhost/api/admin/companies', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ legalName }),
    }),
    { params: Promise.resolve({}) },
  );
  return { res, body: await res.json() };
}

/**
 * The sixth company only exists in the archive (it comes from another
 * installation). Hashed audit rows stay: the schema keeps AuditLog.companyId as
 * a historical scope, never a foreign key, and the installation-wide live chain
 * must not lose a member.
 */
async function forgetCompany(companyId: string) {
  await db.journalLine.deleteMany({ where: { entry: { companyId } } });
  await db.journalEntry.deleteMany({ where: { companyId } });
  await db.journalChainHead.deleteMany({ where: { companyId } });
  await db.bankTransaction.deleteMany({ where: { statement: { companyId } } });
  await db.bankStatement.deleteMany({ where: { companyId } });
  await db.bankAccount.deleteMany({ where: { companyId } });
  await db.glAccount.deleteMany({ where: { companyId } });
  await db.auditLog.deleteMany({ where: { companyId, hash: null } });
  await db.companyMember.deleteMany({ where: { companyId } });
  await db.company.deleteMany({ where: { id: companyId } });
}

/** Everything a tenant owns, plus its own tail and its own audit rows. */
async function tenantFingerprint(companyId: string) {
  const journalEntries = await db.journalEntry.findMany({ where: { companyId }, orderBy: { id: 'asc' } });
  return rows({
    company: await db.company.findUnique({ where: { id: companyId } }),
    glAccounts: await db.glAccount.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
    bankAccounts: await db.bankAccount.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
    bankStatements: await db.bankStatement.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
    bankTransactions: await db.bankTransaction.findMany({ where: { statement: { companyId } }, orderBy: { id: 'asc' } }),
    journalEntries,
    journalLines: await db.journalLine.findMany({
      where: { entryId: { in: journalEntries.map((entry) => entry.id) } },
      orderBy: { id: 'asc' },
    }),
    journalChainHead: await db.journalChainHead.findUnique({ where: { companyId } }),
    audit: await db.auditLog.findMany({ where: { companyId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  });
}

describe('restore a backup as a NEW company into an active installation (S4)', () => {
  let superAdmin: { id: string };
  let superToken: string;
  let companyAdminToken: string;
  let active: { id: string };
  let shell: { id: string };
  let sixthCompanyId: string;
  let archive: string;
  let archivePayload: Record<string, any>;

  beforeEach(async () => {
    await clearDatabase();
    await db.auditLog.deleteMany({ where: { hash: { not: null } } });

    superAdmin = await createTestUser('sixth-super-sro@example.com');
    await db.user.update({
      where: { id: superAdmin.id },
      data: { passwordHash: await hashPassword(OWNER_PASSWORD), platformRole: 'super_admin' },
    });
    superToken = await createSession(superAdmin.id);

    const companyAdmin = await createTestUser('sixth-admin-sro@example.com');
    companyAdminToken = await createSession(companyAdmin.id);

    // The installation's existing company: books, certified tail and history.
    active = await createTestCompany('Active Five Corp');
    await createTestCompanyMember(superAdmin.id, active.id);
    await createTestCompanyMember(companyAdmin.id, active.id);
    await createFixture(active.id);
    const liveFirst = await liveMember('live-first', null, LIVE_HEAD_ONE, active.id, 'LIVE_MARKER_ONE');
    await liveMember('live-second', liveFirst.hash, LIVE_HEAD_TWO, active.id, 'LIVE_MARKER_TWO');

    // The sixth company: an archive made on another installation.
    const sixth = await createTestCompany('Sixth Foreign Corp');
    await createTestCompanyMember(superAdmin.id, sixth.id);
    await createFixture(sixth.id);
    const created = await (await postBackup(superToken, sixth.id, { password: OWNER_PASSWORD })).json();
    archivePayload = decode(created.data);
    sixthCompanyId = sixth.id;
    // Its audit segment lost its root with the old installation (L2).
    const first = auditMember('sixth-history-first', LOST_PREDECESSOR, '2024-11-01T00:00:00.000Z', sixth.id);
    const second = auditMember('sixth-history-second', first.hash, '2024-11-02T00:00:00.000Z', sixth.id);
    archive = withAuditSegment(archivePayload, [first, second]);
    await forgetCompany(sixth.id);

    // The shell the super_admin creates before restoring (real admin route).
    const createdShell = await adminCompany(superToken, 'Sexta Empresa');
    expect(createdShell.res.status).toBe(201);
    shell = createdShell.body.company;
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('imports the archive into the shell while every other tenant and the live chain stay untouched', async () => {
    const activeBefore = await tenantFingerprint(active.id);
    const chainBefore = await verifyAuditChain();
    expect(chainBefore.valid).toBe(true);
    expect(chainBefore.members).toBe(3); // two live markers + the sixth's BACKUP_CREATED
    const shellChartBefore = await db.glAccount.count({ where: { companyId: shell.id } });
    expect(shellChartBefore).toBeGreaterThan(0); // the admin route seeds a chart

    const res = await postRestore(superToken, active.id, {
      data: archive,
      ownerPassword: OWNER_PASSWORD,
      targetCompanyId: shell.id,
    });
    const body = await res.json();
    expect(body.error ?? '').toBe('');
    expect(res.status).toBe(200);
    expect(body.status).toBe('committed');

    // (1) The archive's rows live under the NEW company id, with their ids.
    const entries = await db.journalEntry.findMany({ where: { companyId: shell.id }, orderBy: { id: 'asc' } });
    expect(entries.map((entry) => entry.id)).toEqual(
      archivePayload.data.journalEntries.map((entry: Record<string, any>) => entry.id),
    );
    expect(entries.every((entry) => entry.companyId === shell.id)).toBe(true);
    expect((await db.bankTransaction.findMany({ where: { statement: { companyId: shell.id } } })).map((tx) => tx.id))
      .toEqual(archivePayload.data.bankTransactions.map((tx: Record<string, any>) => tx.id));
    expect((await db.glAccount.findMany({ where: { companyId: shell.id } })).map((gl) => gl.id).sort())
      .toEqual(archivePayload.data.glAccounts.map((gl: Record<string, any>) => gl.id).sort());
    const importedCompany = await db.company.findUnique({ where: { id: shell.id } });
    expect(importedCompany?.legalName).toBe('Sixth Foreign Corp');
    expect(await db.company.findUnique({ where: { id: sixthCompanyId } })).toBeNull();

    // (2) Its own journal chain certifies under the new tenant identity: the
    //     tenant id is part of the HMAC payload, so the chain is re-sealed and
    //     the SOURCE tail is documented as sealed evidence.
    const verdict = await verifyJournalChain(shell.id);
    expect(verdict.valid).toBe(true);
    expect(verdict.members).toBe(1);
    const head = await db.journalChainHead.findUnique({ where: { companyId: shell.id } });
    expect(head?.lastEntryId).toBe(entries[0].id);
    expect(head?.lastHash).toBe(entries[0].hash);
    expect(entries[0].hash).not.toBe(archivePayload.data.journalEntries[0].hash);
    const provenance = await db.auditLog.findMany({ where: { companyId: shell.id, action: 'RESTORE_IMPORT_JOURNAL' } });
    expect(provenance).toHaveLength(1);
    expect(provenance[0].hash).toBeNull();
    expect(provenance[0].previousHash).toBeNull();
    const provenanceEvidence = JSON.parse(provenance[0].details as string);
    expect(provenanceEvidence).toMatchObject({
      backupId: archivePayload.manifest.id,
      sourceCompanyId: sixthCompanyId,
      targetCompanyId: shell.id,
      sourceTailHash: archivePayload.data.journalEntries[0].hash,
    });

    // (3) The audit segment lands as CLOSED HISTORICAL evidence: never a member
    //     of the installation-wide live chain, its certified HMAC preserved.
    const imported = await db.auditLog.findMany({
      where: { companyId: shell.id, action: 'RESTORE_IMPORT_HISTORICAL' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(imported).toHaveLength(2);
    expect(imported.every((row) => row.hash === null && row.previousHash === null)).toBe(true);
    const evidence = JSON.parse(imported[0].details as string);
    expect(evidence.backupId).toBe(archivePayload.manifest.id);
    expect(evidence.sourceCompanyId).toBe(sixthCompanyId);
    expect(evidence.record.id).toBe('sixth-history-first');
    expect(evidence.record.previousHash).toBe(LOST_PREDECESSOR);
    expect(evidence.record.companyId).toBe(sixthCompanyId);
    // The stored HMAC still certifies under this installation's secret.
    expect(computeAuditHash(evidence.record as never)).toBe(evidence.record.hash);
    expect(computeAuditHash(JSON.parse(imported[1].details).record as never))
      .toBe(JSON.parse(imported[1].details).record.hash);

    // (4) The installation-wide LIVE chain is untouched and still certifies.
    const chainAfter = await verifyAuditChain();
    expect(chainAfter.valid).toBe(true);
    expect(chainAfter.members).toBe(chainBefore.members);
    expect(await db.auditLog.count({ where: { action: 'RESTORE_REBASE' } })).toBe(0);

    // (5) Isolation: the active company is byte-identical, chain included.
    expect(await tenantFingerprint(active.id)).toEqual(activeBefore);
    expect((await verifyJournalChain(active.id)).valid).toBe(true);

    // (6) An ordinary restore of the active company still passes afterwards.
    const activeArchive = await (await postBackup(superToken, active.id, { password: OWNER_PASSWORD })).json();
    const ordinary = await postRestore(superToken, active.id, {
      data: activeArchive.data,
      ownerPassword: OWNER_PASSWORD,
    });
    const ordinaryBody = await ordinary.json();
    expect(ordinaryBody.error ?? '').toBe('');
    expect(ordinary.status).toBe(200);
    expect((await verifyAuditChain()).valid).toBe(true);
    expect((await verifyJournalChain(active.id)).valid).toBe(true);
    expect(await db.auditLog.count({ where: { companyId: shell.id, action: 'RESTORE_IMPORT_HISTORICAL' } })).toBe(2);
  });

  it('keeps the caller company path unchanged when no target is given', async () => {
    // Existing behaviour: the caller's company is the destination and a foreign
    // archive is still refused by identity, never silently imported.
    const res = await postRestore(superToken, active.id, { data: archive, ownerPassword: OWNER_PASSWORD });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('RESTORE_IDENTITY');
    expect(await db.auditLog.count({ where: { action: 'RESTORE_IMPORT_HISTORICAL' } })).toBe(0);
  });

  it('refuses a non super_admin caller with a Spanish message and mutates nothing', async () => {
    const chartBefore = await db.glAccount.count({ where: { companyId: shell.id } });
    const files = backupFiles();
    const auditBefore = rows(await db.auditLog.findMany({ orderBy: { id: 'asc' } }));

    const res = await postRestore(companyAdminToken, active.id, {
      data: archive,
      ownerPassword: OWNER_PASSWORD,
      targetCompanyId: shell.id,
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('FORBIDDEN');
    expect(body.error).toContain('super administrador');

    expect(await db.glAccount.count({ where: { companyId: shell.id } })).toBe(chartBefore);
    expect(await db.auditLog.count({ where: { action: 'RESTORE_IMPORT_HISTORICAL' } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'COMPANY_RESTORE_COMMITTED' } })).toBe(0);
    expect(rows(await db.auditLog.findMany({ orderBy: { id: 'asc' } }))).toEqual(auditBefore);
    expect(backupFiles()).toEqual(files);
  });

  it('refuses a target that is not an empty shell with a Spanish message', async () => {
    const gl = await db.glAccount.findFirstOrThrow({ where: { companyId: shell.id } });
    await createTestBankAccount(shell.id, gl.id, 'Caja de la sexta');
    const chartBefore = rows(await db.glAccount.findMany({ where: { companyId: shell.id }, orderBy: { id: 'asc' } }));
    const files = backupFiles();

    const res = await postRestore(superToken, active.id, {
      data: archive,
      ownerPassword: OWNER_PASSWORD,
      targetCompanyId: shell.id,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('RESTORE_SHELL');
    expect(body.error).toContain('vacía');

    expect(rows(await db.glAccount.findMany({ where: { companyId: shell.id }, orderBy: { id: 'asc' } }))).toEqual(chartBefore);
    expect(await db.bankAccount.count({ where: { companyId: shell.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'RESTORE_IMPORT_HISTORICAL' } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'COMPANY_RESTORE_COMMITTED' } })).toBe(0);
    expect(backupFiles()).toEqual(files);
  });

  it('refuses a wrong ownership credential before the shell checks and mutates nothing', async () => {
    const gl = await db.glAccount.findFirstOrThrow({ where: { companyId: shell.id } });
    await createTestBankAccount(shell.id, gl.id, 'Caja de la sexta');
    const files = backupFiles();

    const res = await postRestore(superToken, active.id, {
      data: archive,
      ownerPassword: 'esto-no-es-la-clave',
      targetCompanyId: shell.id,
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    // Ownership first, always: not the (also true) shell refusal.
    expect(body.code).toBe('RESTORE_OWNERSHIP');
    expect(body.error).toContain('contraseña');

    expect(await db.bankAccount.count({ where: { companyId: shell.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'RESTORE_IMPORT_HISTORICAL' } })).toBe(0);
    expect(backupFiles()).toEqual(files);
  });

  it('refuses a target company that does not exist', async () => {
    const res = await postRestore(superToken, active.id, {
      data: archive,
      ownerPassword: OWNER_PASSWORD,
      targetCompanyId: 'no-such-company',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('RESTORE_IDENTITY');
    expect(await db.company.findUnique({ where: { id: 'no-such-company' } })).toBeNull();
    expect(await db.auditLog.count({ where: { action: 'RESTORE_IMPORT_HISTORICAL' } })).toBe(0);
  });
});
