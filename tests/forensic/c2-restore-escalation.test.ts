import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { createBackup, restoreBackup } from '@/lib/backup';
import { verifyPassword } from '@/lib/auth';
import { createSession } from '@/lib/sessions';
import { GET as adminUsersGET } from '@/app/api/admin/users/route';
import { POST as backupRestorePOST } from '@/app/api/backup/restore/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

const BACKUP_DIR = path.join(process.cwd(), 'db', 'backups');
const MANIFEST_PATH = path.join(BACKUP_DIR, 'manifest.json');

// createBackup writes real files to db/backups and appends to manifest.json.
// The PoC runs in the test DB, but it MUST NOT leave disk residue behind.
const diskTestCompanyIds = new Set<string>();
// clearDatabase() only removes companies that have test-user memberships.
// Victim Corp has NO member, so it must be removed explicitly to keep the
// test DB clean between runs.
const createdCompanyIds = new Set<string>();

function readManifestFile(): { backups: Array<Record<string, unknown>> } {
  if (!fs.existsSync(MANIFEST_PATH)) return { backups: [] };
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch {
    return { backups: [] };
  }
}

function cleanupDiskArtifacts(): void {
  const manifest = readManifestFile();
  const kept = manifest.backups.filter(
    (b) => !diskTestCompanyIds.has(String(b.companyId)),
  );
  if (kept.length !== manifest.backups.length) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ backups: kept }, null, 2) + '\n', 'utf-8');
  }
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const companyId = f.split('_')[0];
    if (diskTestCompanyIds.has(companyId)) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
  }
}

async function cleanupCreatedDbRows(): Promise<void> {
  const ids = [...createdCompanyIds];
  createdCompanyIds.clear();
  if (ids.length === 0) return;
  const filter = { companyId: { in: ids } };
  await db.glAccount.deleteMany({ where: filter }).catch(() => {});
  await db.companyMember.deleteMany({ where: filter }).catch(() => {});
  await db.company.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
}

describe('C2 — Restore role escalation (dynamic PoC)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
    await cleanupCreatedDbRows();
  });

  afterAll(async () => {
    const leftoverUsers = await db.user.count({ where: { email: { contains: '@example.com' } } });
    const leftoverCompanies = await db.company.count({
      where: { legalName: { in: ['Acme Corp', 'Victim Corp'] } },
    });
    log('AFTER-ALL DB STATE: leftover test users =', leftoverUsers, '| leftover test companies =', leftoverCompanies);
    cleanupDiskArtifacts();
    log('DISK CLEANUP: removed test backup files and manifest entries for', [...diskTestCompanyIds]);
  });

  it('does NOT escalate to super_admin when ONLY the role field is tampered in a legitimate backup (RC2-3)', async () => {
    // Setup: attacker is a company_admin of Acme Corp
    const user = await createTestUser('attacker@example.com');
    const company = await createTestCompany('Acme Corp');
    await createTestCompanyMember(user.id, company.id);
    diskTestCompanyIds.add(company.id);
    createdCompanyIds.add(company.id);
    log('USER CREATED: id =', user.id, '| role =', user.platformRole);

    // Baseline DB state
    const before = await db.user.findUnique({ where: { id: user.id }, select: { platformRole: true } });
    log('DB BEFORE RESTORE: user.role =', before?.platformRole);

    // Baseline: superadmin route is FORBIDDEN with company_admin role
    let token = await createSession(user.id);
    let res = await adminUsersGET(
      new NextRequest('http://localhost/api/admin/users', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({}) },
    );
    log('GET /api/admin/users BEFORE restore: status =', res.status);
    expect(res.status).toBe(403);

    // 1. Create a completely legitimate backup
    const backup = await createBackup(company.id);
    const backupData = JSON.parse(Buffer.from(backup.data, 'base64').toString('utf-8'));

    // 2. Change ONLY the role field
    const target = backupData.data.users.find((u: { id: string }) => u.id === user.id);
    expect(target).toBeDefined();
    expect(target.role).toBe('user'); // factory now persists platformRole 'user' -> wire role 'user' in backup
    target.role = 'super_admin';
    log('BACKUP TAMPERED: users[].role changed to super_admin (only field modified)');

    // 3. Restore it — actor is NOT a global super_admin, so the tampered role
    //    must be normalized to 'user' (RC2-3 actor-gated contract).
    const result = await restoreBackup(company.id, backupData, user.id);
    log('RESTORE result: success =', result.success, '| message =', result.message);
    expect(result.success).toBe(true);

    // 4. Verify the row in PostgreSQL directly: the tampered role must NOT persist
    const stored = await db.user.findUnique({ where: { id: user.id } });
    log('DB AFTER RESTORE: user.role =', stored?.platformRole);
    expect(stored?.platformRole).toBe('user');

    // 5. Verify login with the known default password is now BLOCKED (F-5 fix)
    const loginOk = await verifyPassword('Admin123!', stored!.passwordHash);
    log('LOGIN CHECK: verifyPassword("Admin123!", stored.passwordHash) =', loginOk);
    expect(loginOk).toBe(false);

    // 6. Verify the superadmin route is STILL FORBIDDEN (no escalation)
    token = await createSession(user.id);
    res = await adminUsersGET(
      new NextRequest('http://localhost/api/admin/users', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({}) },
    );
    log('GET /api/admin/users AFTER restore: status =', res.status);
    expect(res.status).toBe(403);
  });

  it('injects a tenanted row into another company when ONLY companyId is tampered', async () => {
    // Setup: attacker is a company_admin of Acme Corp; Victim Corp is a separate tenant
    const user = await createTestUser('attacker2@example.com');
    const acme = await createTestCompany('Acme Corp');
    const victim = await createTestCompany('Victim Corp');
    await createTestCompanyMember(user.id, acme.id);
    diskTestCompanyIds.add(acme.id);
    diskTestCompanyIds.add(victim.id);
    createdCompanyIds.add(acme.id);
    createdCompanyIds.add(victim.id);
    const gl = await createTestGlAccount({
      companyId: acme.id,
      code: '1000',
      name: 'Cash',
    });
    log('GL ACCOUNT CREATED: id =', gl.id, '| companyId =', gl.companyId, '(Acme)');

    // 1. Create a completely legitimate backup
    const backup = await createBackup(acme.id);
    const backupData = JSON.parse(Buffer.from(backup.data, 'base64').toString('utf-8'));

    // 2. Change ONLY the companyId of one tenanted row
    const row = backupData.data.glAccounts.find((a: { id: string }) => a.id === gl.id);
    expect(row).toBeDefined();
    expect(row.companyId).toBe(acme.id);
    row.companyId = victim.id;
    log('BACKUP TAMPERED: glAccounts[].companyId changed to victim.id =', victim.id, '(only field modified)');

    // 3. Restore it into Acme
    const result = await restoreBackup(acme.id, backupData, user.id);
    log('RESTORE result: success =', result.success, '| message =', result.message);
    expect(result.success).toBe(true);

    // 4. Verify in PostgreSQL: the row now lives in Victim Corp's tenant
    const stored = await db.glAccount.findUnique({ where: { id: gl.id } });
    log('DB AFTER RESTORE: glAccount.companyId =', stored?.companyId, '| victim.id =', victim.id);
    expect(stored?.companyId).toBe(victim.id);
  });

  it('does NOT escalate to super_admin via the HTTP endpoint /api/backup/restore with real auth (RC2-3)', async () => {
    // Setup: attacker is a company_admin of Acme Corp
    const user = await createTestUser('attacker3@example.com');
    const company = await createTestCompany('Acme Corp');
    await createTestCompanyMember(user.id, company.id);
    diskTestCompanyIds.add(company.id);
    createdCompanyIds.add(company.id);

    // 1. Create a completely legitimate backup
    const backup = await createBackup(company.id);
    const backupData = JSON.parse(Buffer.from(backup.data, 'base64').toString('utf-8'));

    // 2. Change ONLY the role field
    const target = backupData.data.users.find((u: { id: string }) => u.id === user.id);
    expect(target).toBeDefined();
    target.role = 'super_admin';
    const tamperedBase64 = Buffer.from(JSON.stringify(backupData), 'utf-8').toString('base64');
    log('BACKUP TAMPERED: users[].role -> super_admin, re-encoded as base64');

    // 3. Call the HTTP endpoint with a real session (as the attacker would)
    const token = await createSession(user.id);
    const req = new NextRequest('http://localhost/api/backup/restore', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ companyId: company.id, data: tamperedBase64 }),
    });
    const res = await backupRestorePOST(req, { params: Promise.resolve({}) });
    const body = await res.json();
    log('HTTP POST /api/backup/restore: status =', res.status, '| body =', JSON.stringify(body));
    expect(res.status).toBe(200);

    // 4. Verify the row in PostgreSQL directly — the actor is NOT a global
    //    super_admin, so the tampered role must NOT persist.
    const stored = await db.user.findUnique({ where: { id: user.id } });
    log('DB AFTER HTTP RESTORE: user.role =', stored?.platformRole);
    expect(stored?.platformRole).toBe('user');

    // 5. Verify the superadmin route is STILL FORBIDDEN (no escalation)
    const token2 = await createSession(user.id);
    const resAdmin = await adminUsersGET(
      new NextRequest('http://localhost/api/admin/users', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token2}` },
      }),
      { params: Promise.resolve({}) },
    );
    log('GET /api/admin/users AFTER HTTP RESTORE: status =', resAdmin.status);
    expect(resAdmin.status).toBe(403);
  });
});
