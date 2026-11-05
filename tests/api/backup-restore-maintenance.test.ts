import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { GET as backupGET, POST as backupPOST } from '../../src/app/api/backup/route';
import { POST as restorePOST } from '../../src/app/api/backup/restore/route';
import { createMaintenanceGate } from '@/lib/backup-maintenance.mjs';
import { RUNTIME_DIR } from '@/lib/config/paths';
import { createRecoveryJournal } from '@/lib/backup-recovery-journal';
import { reconcileCompanyBackupRecovery } from '@/lib/backup-restore';
import { createSession } from '@/lib/sessions';
import { hashPassword } from '@/lib/auth';
import { db } from '@/lib/db';
import { cleanupBackupFiles } from '../helpers/backup-files';
import {
  clearDatabase,
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
} from '../helpers/factories';

/**
 * Maintenance-transition contract of the coordinated restore (RC: /api/backup/restore):
 *
 *  1. a non-restore request during maintenance is refused with 503;
 *  2. a restore that fails BEFORE it records a recovery intent must not leave a
 *     marker behind (it would fence the whole application);
 *  3. a marker + recovery journal left by an external crash is NOT auto-released:
 *     it stays closed until an operator explicitly resumes/releases it, and an
 *     ambiguous reconciliation keeps it closed.
 */

const MAINTENANCE_ROOT = path.join(RUNTIME_DIR, 'backup-maintenance');
const MARKER = path.join(MAINTENANCE_ROOT, 'maintenance.json');
const JOURNAL_ROOT = path.join(RUNTIME_DIR, 'backup-recovery');

const authHeaders = (token: string) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
});

/** Password of the administrator who creates and restores the fixture backups (S1/S2/S7). */
const ADMIN_PASSWORD = 'Clave.Mantenimiento.2026';

function listRequest(companyId: string, token: string): NextRequest {
  return new NextRequest(`http://localhost/api/backup?companyId=${companyId}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
}

function restoreRequest(companyId: string, token: string, data: string): NextRequest {
  // S1/S2 — a restore must prove the credential of the administrator who created
  // the backup, so the fixture supplies it; the maintenance transition contract
  // under test is unchanged.
  return new NextRequest(`http://localhost/api/backup/restore?companyId=${companyId}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ data, ownerPassword: ADMIN_PASSWORD }),
  });
}

async function seedCompanyWithBackupOwner(email: string) {
  const user = await createTestUser(email);
  // S7 — creating a backup is sudo-style: the administrator re-enters their own
  // password, so the fixture owner holds a real hash and supplies it below.
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(ADMIN_PASSWORD) },
  });
  const company = await createTestCompany('Maintenance Transition Co');
  await createTestCompanyMember(user.id, company.id);
  const token = await createSession(user.id);
  await createTestGlAccount({
    companyId: company.id,
    code: '1010',
    name: 'Cash',
    accountType: 'asset',
    normalBalance: 'debit',
  });
  return { user, company, token };
}

const createdBackups: string[] = [];

describe('/api/backup/restore — maintenance transition', () => {
  beforeEach(async () => {
    await clearDatabase();
    createdBackups.length = 0;
  });

  afterEach(async () => {
    // Never leave a fence behind for the next test file.
    await releaseIfMarked();
    await clearDatabase();
    cleanupBackupFiles(createdBackups);
    for (const name of fs.existsSync(JOURNAL_ROOT) ? fs.readdirSync(JOURNAL_ROOT) : []) {
      const target = path.join(JOURNAL_ROOT, name);
      if (target.startsWith(JOURNAL_ROOT) && fs.statSync(target).isFile()) fs.unlinkSync(target);
    }
  });

  it('requirement 1: a non-restore request during maintenance receives 503 and recovers after release', async () => {
    const { company, token } = await seedCompanyWithBackupOwner('maint-fence@example.com');
    const gate = createMaintenanceGate(MAINTENANCE_ROOT);
    const owner = gate.beginMaintenance();
    try {
      const blocked = await backupGET(listRequest(company.id, token), { params: Promise.resolve({}) });
      const body = await blocked.json();
      expect(blocked.status).toBe(503);
      expect(body.code).toBe('BACKUP_MAINTENANCE');
    } finally {
      await owner.drain({ timeoutMs: 0 });
      owner.release();
    }
    expect(fs.existsSync(MARKER)).toBe(false);
    const reopened = await backupGET(listRequest(company.id, token), { params: Promise.resolve({}) });
    expect(reopened.status).toBe(200);
  });

  it('requirement 2: a restore that fails before any recovery intent does not leave a maintenance marker', async () => {
    const { user, company, token } = await seedCompanyWithBackupOwner('maint-failed@example.com');
    const backupRes = await backupPOST(
      new NextRequest(`http://localhost/api/backup?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(backupRes.status).toBe(200);
    const backup = await backupRes.json();
    createdBackups.push(backup.filename);

    // The transition is admitted and then the destination identity check fails
    // inside the restore transaction (the snapshot's member no longer matches).
    await db.user.update({ where: { id: user.id }, data: { email: 'maint-failed-changed@example.com' } });

    const restoreRes = await restorePOST(restoreRequest(company.id, token, backup.data), {
      params: Promise.resolve({}),
    });
    const restoreBody = await restoreRes.json();
    expect(restoreRes.status).toBe(400);
    expect(restoreBody.code).toBe('VALIDATION_ERROR');
    expect(restoreBody.error).toContain('RESTORE_MISSING_IDENTITY');

    // Failure without a recovery intent must not fence the application.
    expect(fs.existsSync(MARKER)).toBe(false);
    const reopened = await backupGET(listRequest(company.id, token), { params: Promise.resolve({}) });
    expect(reopened.status).toBe(200);
  });

  it('requirement 3: a crash-left marker plus recovery journal is not auto-released and stays fenced when ambiguous', async () => {
    const { company, token } = await seedCompanyWithBackupOwner('maint-crash@example.com');
    const backupRes = await backupPOST(
      new NextRequest(`http://localhost/api/backup?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
      }),
      { params: Promise.resolve({}) },
    );
    const backup = await backupRes.json();
    createdBackups.push(backup.filename);

    // Exactly what a process killed mid-restore leaves: a published marker, a
    // flushed recovery intent, and no OWNER instance alive to release anything.
    const gate = createMaintenanceGate(MAINTENANCE_ROOT);
    const owner = gate.beginMaintenance();
    const operationId = crypto.randomUUID();
    const unknownBytes = Buffer.from('{"companies":{}}', 'utf8').toString('base64');
    createRecoveryJournal(JOURNAL_ROOT, {
      operationId,
      companyId: company.id,
      checksum: 'a'.repeat(64),
      maintenanceId: owner.id,
      files: [{ key: 'company-config', before: unknownBytes, after: unknownBytes }],
    });

    try {
      // A normal request stays fenced.
      const fenced = await backupGET(listRequest(company.id, token), { params: Promise.resolve({}) });
      expect(fenced.status).toBe(503);

      // A new restore cannot take over the fence.
      const retried = await restorePOST(restoreRequest(company.id, token, backup.data), {
        params: Promise.resolve({}),
      });
      expect(retried.status).toBe(503);

      // Reconciliation without verifiable evidence keeps the fence closed.
      const outcome = await reconcileCompanyBackupRecovery(company.id, operationId);
      expect(outcome.status).toBe('reconciliation_required');
      expect(fs.existsSync(MARKER)).toBe(true);
      const stillFenced = await backupGET(listRequest(company.id, token), { params: Promise.resolve({}) });
      expect(stillFenced.status).toBe(503);
    } finally {
      // Only the explicit operator path reopens the gate.
      const resumed = createMaintenanceGate(MAINTENANCE_ROOT).resumeMaintenance(owner.id);
      await resumed.drain({ timeoutMs: 0 });
      resumed.release();
    }

    expect(fs.existsSync(MARKER)).toBe(false);
    const reopened = await backupGET(listRequest(company.id, token), { params: Promise.resolve({}) });
    expect(reopened.status).toBe(200);
  });
});

async function releaseIfMarked(): Promise<void> {
  if (!fs.existsSync(MARKER)) return;
  const gate = createMaintenanceGate(MAINTENANCE_ROOT);
  const record = JSON.parse(fs.readFileSync(MARKER, 'utf-8')) as { id: string };
  const owner = gate.resumeMaintenance(record.id);
  await owner.drain({ timeoutMs: 0 });
  owner.release();
}
