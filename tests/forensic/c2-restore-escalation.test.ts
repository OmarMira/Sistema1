import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { createBackup } from '@/lib/backup';
import { BACKUP_DIR } from '@/lib/config/paths';
import { sealSnapshot } from '@/lib/backup-format';
import { restoreCompanyBackup } from '@/lib/backup-restore';
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

/**
 * Restore-escalation PoC, aligned with the CURRENT restore contract:
 *
 *  - 2.x company snapshots are admitted ONLY by the company recovery path
 *    (`restoreCompanyBackup` / `restoreCompanyBackupCoordinated`). The legacy
 *    `restoreBackup` deliberately refuses them (fence pinned in
 *    tests/backup-company/restore.test.ts:444-448).
 *  - `/api/backup/restore` commits through `restoreCompanyBackupCoordinated`.
 *  - Snapshot integrity is a FIDELITY digest, not authenticity
 *    (`authenticated: false`): an attacker who can edit the file can recompute
 *    it. The escalation proofs below therefore re-seal the tampered payload so
 *    the authority checks — not the checksum — are what gets exercised.
 *  - Users (credentials/authority) are never restored: the v2 restore set
 *    carries id+email references only, so a tampered `users[].role` cannot
 *    grant platform authority.
 */
const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

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
    // The recovery core certifies the INSTALLATION-WIDE audit chain before it
    // replaces any row (src/lib/backup-validation.ts RESTORE_CHAIN, pinned by
    // tests/backup-company/restore.test.ts): a predecessor another tenant still
    // needs must never be deleted or re-signed. Other suites leave hashed
    // AuditLog rows behind (their tenant is gone, or the hash was sealed with a
    // stubbed HMAC secret) and such a row can never be certified, so the shared
    // test DB removes ONLY that hashed residue. Unhashed operational rows — the
    // ones this suite asserts on — and every escalation assertion are untouched.
    await db.auditLog.deleteMany({ where: { hash: { not: null } } });
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
    const nested = backupData.data.companyMembers.find(
      (m: { user?: { id?: string } }) => m.user?.id === user.id,
    ).user;
    expect(nested.role).toBe('user');

    // 2a. Authority edited in ONE section only → refused: the nested member user
    //     must stay a subset of the users row (no spliced authority evidence).
    target.role = 'super_admin';
    sealSnapshot(backupData);
    await expect(
      restoreCompanyBackup(company.id, JSON.stringify(backupData)),
    ).rejects.toThrow(/RESTORE_NESTED: CompanyMember\.user/);
    log('BACKUP TAMPERED (users only): refused by the nested-consistency fence');

    // 2b. Coherent edit (both sections) + recomputed digest: the realistic
    //     attacker payload. Users are restored as id+email references only, so
    //     the tampered role still has no restoration route.
    target.role = 'super_admin';
    nested.role = 'super_admin';
    sealSnapshot(backupData);
    log('BACKUP TAMPERED: users[].role changed to super_admin (digest recomputed)');

    // 3. Restore it through the company recovery path — the tampered role has
    //    no restoration route at all (v2 restores id+email references only).
    const result = await restoreCompanyBackup(company.id, JSON.stringify(backupData));
    log('RESTORE result: status =', result.status, '| operationId =', result.operationId);
    expect(result.status).toBe('committed');

    // 4. Verify the row in PostgreSQL directly: the tampered role must NOT persist
    const stored = await db.user.findUnique({ where: { id: user.id } });
    log('DB AFTER RESTORE: user.role =', stored?.platformRole);
    expect(stored?.platformRole).toBe('user');

    // 5. Verify login with the known default password is now BLOCKED (F-5 fix):
    //    credentials are destination-only, never part of a snapshot.
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

  it('refuses a payload whose tenanted row is retargeted at another company (cross-tenant injection)', async () => {
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

    // 3a. As saved on disk (stale digest): the tenant fence fires before the
    //     digest check.
    await expect(
      restoreCompanyBackup(acme.id, JSON.stringify(backupData)),
    ).rejects.toThrow(/tenant mismatch/i);

    // 3b. Attacker recomputes the digest: the SAME tenant fence still refuses
    //     it, because every section row must belong to the selected company.
    sealSnapshot(backupData);
    await expect(
      restoreCompanyBackup(acme.id, JSON.stringify(backupData)),
    ).rejects.toThrow(/tenant mismatch/i);

    // 4. Verify in PostgreSQL: the row never left Acme and nothing landed in
    //    the victim tenant.
    const stored = await db.glAccount.findUnique({ where: { id: gl.id } });
    log('DB AFTER REFUSED RESTORE: glAccount.companyId =', stored?.companyId, '| acme.id =', acme.id);
    expect(stored?.companyId).toBe(acme.id);
    expect(await db.glAccount.count({ where: { companyId: victim.id } })).toBe(0);
    expect(
      await db.auditLog.count({ where: { companyId: acme.id, action: 'COMPANY_RESTORE_COMMITTED' } }),
    ).toBe(0);
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

    // 2. Change the role field in BOTH sections (a single-place edit is refused
    //    by the nested-consistency check) and re-seal the payload, so the
    //    request is rejected (or normalized) by the restore authority checks
    //    rather than by a stale digest.
    const target = backupData.data.users.find((u: { id: string }) => u.id === user.id);
    expect(target).toBeDefined();
    target.role = 'super_admin';
    backupData.data.companyMembers.find(
      (m: { user?: { id?: string } }) => m.user?.id === user.id,
    ).user.role = 'super_admin';
    sealSnapshot(backupData);
    const tamperedBase64 = Buffer.from(JSON.stringify(backupData), 'utf-8').toString('base64');
    log('BACKUP TAMPERED: users[].role -> super_admin, digest recomputed, re-encoded as base64');

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
    expect(body.success).toBe(true);
    expect(body.status).toBe('committed');
    expect(body.scope).toBe('database-and-company-config');

    // 4. Verify the row in PostgreSQL directly — the network payload never
    //    carries authority: users are restored as id+email references only.
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
