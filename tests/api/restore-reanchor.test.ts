import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { computeAuditHash, verifyAuditChain } from '@/lib/journal-hash';
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
