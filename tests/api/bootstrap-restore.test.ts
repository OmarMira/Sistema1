import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { POST as backupPOST } from '../../src/app/api/backup/route';
import { POST as bootstrapRestorePOST } from '../../src/app/api/bootstrap/restore/route';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { hashPassword } from '@/lib/auth';
import { LEGACY_BACKUP_MESSAGE, sealSnapshot } from '@/lib/backup-format';
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
 * T7 (S3/S5) — the first-install route reports the refusal ITSELF.
 *
 * `restoreCompanyBackupCoordinated` refuses a payload with documented machine
 * codes (`RESTORE_LEGACY_FORMAT`, `RESTORE_OWNERSHIP`, `RESTORE_CHAIN`,
 * `RESTORE_SHELL`). The in-system route already answers those codes through the
 * shared error handler; the bootstrap route used to flatten every one of them
 * into a generic `RESTORE_FAILED` with an `No se pudo restaurar el sistema:`
 * prefix, so the operator lost both the code and the Spanish explanation.
 *
 * Pinned here (bootstrap surface only):
 *   - a legacy plain-text archive answers 400 `RESTORE_LEGACY_FORMAT` with the
 *     sealed-format Spanish message verbatim;
 *   - an archive whose journal history cannot be certified answers 400
 *     `RESTORE_CHAIN` (never a generic failure);
 *   - an UNKNOWN refusal keeps today's generic handling (`RESTORE_FAILED`).
 * Every refusal leaves the system verifiably empty: the bootstrap shell is
 * discarded, so a later attempt still passes the empty-system gate.
 *
 * Refusal semantics are untouched: only the code/message surface changes.
 */
const OWNER_PASSWORD = 'Clave.Bootstrap.2026';
const RECOVERY_PASSWORD = 'Recuperacion.2026';

function decode(base64: string): Record<string, any> {
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
}

async function postBackup(token: string, companyId: string, body: unknown) {
  return backupPOST(
    new NextRequest(`http://localhost/api/backup?companyId=${companyId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}

/** First-install restore with the payload as FILE, exactly like the UI does. */
async function postBootstrap(payload: Record<string, any>, fields: Record<string, string> = {}) {
  const formData = new FormData();
  formData.append(
    'file',
    new File([Buffer.from(JSON.stringify(payload), 'utf8')], 'backup.json', {
      type: 'application/json',
    }),
  );
  formData.append('recoveryPassword', RECOVERY_PASSWORD);
  for (const [key, value] of Object.entries(fields)) formData.append(key, value);
  return bootstrapRestorePOST(
    new NextRequest('http://localhost/api/bootstrap/restore', { method: 'POST', body: formData }),
    { params: Promise.resolve({}) },
  );
}

/**
 * A legacy plain-text file: the raw snapshot sealed with the old UNKEYED sha256
 * digest, i.e. without the current sealed (HMAC) format. Everything else —
 * including the ownership verifier — is untouched, so ownership passes first
 * and the sealed-format refusal is what the operator sees.
 */
function legacyPlainText(payload: Record<string, any>): Record<string, any> {
  const { integrity: _integrity, ...manifest } = payload.manifest;
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify({ manifest, data: payload.data }), 'utf8')
    .digest('hex');
  return {
    ...payload,
    manifest: {
      ...manifest,
      integrity: {
        algorithm: 'sha256',
        encoding: 'utf8',
        scope: 'JSON.stringify({manifest-without-integrity,data})',
        authenticated: false,
        digest,
      },
    },
  };
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
  return { gl, entry };
}

describe('bootstrap restore refusal codes (T7)', () => {
  let user: { id: string };
  let company: { id: string };
  let token: string;

  beforeEach(async () => {
    await clearDatabase();
    // Installation-wide audit residue from other suites cannot be certified by
    // the coordinated restore; only hashed rows are removed (see
    // tests/api/backup-restore.test.ts).
    await db.auditLog.deleteMany({ where: { hash: { not: null } } });
    user = await createTestUser('bootstrap-sro@example.com');
    await db.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(OWNER_PASSWORD) },
    });
    company = await createTestCompany('Bootstrap Restore Corp');
    await createTestCompanyMember(user.id, company.id);
    token = await createSession(user.id);
    await createFixture(company.id);
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('answers RESTORE_LEGACY_FORMAT with the sealed-format Spanish message', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    const legacy = legacyPlainText(decode(created.data));
    await clearDatabase();

    const res = await postBootstrap(legacy, { ownerPassword: OWNER_PASSWORD });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('RESTORE_LEGACY_FORMAT');
    // The operator's explanation is the core's own Spanish message, verbatim —
    // never the `No se pudo restaurar el sistema:` wrapper.
    expect(body.error).toBe(LEGACY_BACKUP_MESSAGE);

    // Refused before any mutation: the system is still empty and admissible.
    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
    expect(await db.companyMember.count()).toBe(0);
  });

  it('answers RESTORE_CHAIN when the archive journal history cannot be certified', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    const payload = decode(created.data);
    // Same shape, different substance: the stored journal hash no longer
    // certifies the row, so the destination key cannot certify the archive.
    payload.data.journalEntries[0].description = 'Descripción alterada sin re-firmar';
    sealSnapshot(payload as never);
    await clearDatabase();

    const res = await postBootstrap(payload, { ownerPassword: OWNER_PASSWORD });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('RESTORE_CHAIN');
    expect(body.error).toContain('RESTORE_CHAIN');

    expect(await db.company.count()).toBe(0);
    expect(await db.user.count()).toBe(0);
  });

  it('keeps the generic RESTORE_FAILED answer for an unknown refusal', async () => {
    const created = await (await postBackup(token, company.id, { password: OWNER_PASSWORD })).json();
    const payload = decode(created.data);
    // Not one of the documented RESTORE_ codes: the installer reads a missing
    // section, which must keep today's generic handling untouched.
    delete payload.data.fiscalPeriods;
    sealSnapshot(payload as never);
    await clearDatabase();

    const res = await postBootstrap(payload, { ownerPassword: OWNER_PASSWORD });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('RESTORE_FAILED');
    expect(body.error).toContain('No se pudo restaurar el sistema');

    expect(await db.company.count()).toBe(0);
  });
});
