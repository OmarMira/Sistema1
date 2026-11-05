import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { hashPassword } from '@/lib/auth';
import { POST as backupPOST, DELETE as backupDELETE } from '@/app/api/backup/route';
import { createBackup } from '@/lib/backup';
import { BACKUP_DIR } from '@/lib/config/paths';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  clearDatabase,
} from '../helpers/factories';

const MANIFEST_PATH = path.join(BACKUP_DIR, 'manifest.json');

const log = (...args: unknown[]) => console.log('[EVIDENCE-D10C]', ...args);

function authHeaders(token: string): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  h.set('Authorization', `Bearer ${token}`);
  return h;
}

function readManifestFile(): { backups: Array<{ filename: string; companyId: string }> } {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
}

const createdFilenames = new Set<string>();

/**
 * S7 — every backup carries the creating administrator's credential: the HTTP
 * route verifies the re-entered password, and the library primitive requires it
 * so a snapshot nobody can prove ownership of is never published. The DELETE
 * integrity contract under test is unchanged.
 */
const ADMIN_PASSWORD = 'Clave.D10C.2026';

function trackCreatedFile(filename: string) {
  createdFilenames.add(filename);
}

function fileExists(name: string): boolean {
  return fs.existsSync(path.join(BACKUP_DIR, name));
}

function cleanupCreatedFiles() {
  const manifestPath = path.join(BACKUP_DIR, 'manifest.json');
  for (const name of createdFilenames) {
    const p = path.join(BACKUP_DIR, name);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.backups = (manifest.backups || []).filter(
        (b: { filename: string }) => !createdFilenames.has(b.filename),
      );
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch {
      // ignore parse errors
    }
  }
  createdFilenames.clear();
}

describe('D10-C — Backup DELETE: path integrity + tenant ownership + role gate', () => {
  let tenantA: { id: string };
  let tenantB: { id: string };
  let adminA: { id: string };
  let adminB: { id: string };
  let viewerA: { id: string };
  let employeeA: { id: string };
  let superUser: { id: string };
  let unlinkSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await clearDatabase();
    vi.restoreAllMocks();

    tenantA = await createTestCompany('D10C Tenant A');
    tenantB = await createTestCompany('D10C Tenant B');

    adminA = await createTestUser('admin-a-d10c@example.com');
    await db.user.update({
      where: { id: adminA.id },
      data: { passwordHash: await hashPassword(ADMIN_PASSWORD) },
    });
    await createTestCompanyMember(adminA.id, tenantA.id);

    viewerA = await createTestUser('viewer-a-d10c@example.com');
    await db.companyMember.create({ data: { userId: viewerA.id, companyId: tenantA.id, role: 'viewer' } });

    employeeA = await createTestUser('employee-a-d10c@example.com');
    await db.companyMember.create({ data: { userId: employeeA.id, companyId: tenantA.id, role: 'employee' } });

    adminB = await createTestUser('admin-b-d10c@example.com');
    await createTestCompanyMember(adminB.id, tenantB.id);

    superUser = await db.user.create({
      data: {
        email: 'super-d10c@example.com',
        passwordHash: 'hashed_password_placeholder',
        firstName: 'Super',
        lastName: 'Admin',
        platformRole: 'super_admin',
        // Verified, non-legacy actor: the sessions resolver rejects pending users.
        emailVerifiedAt: new Date(),
        legacyUser: false,
      },
    });

    unlinkSpy = vi.spyOn(fs, 'unlinkSync');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    cleanupCreatedFiles();
    await clearDatabase();
  });

  async function materializeBackup(companyId: string, note = ''): Promise<string> {
    const backup = await createBackup(companyId, undefined, { ownerPassword: ADMIN_PASSWORD });
    trackCreatedFile(backup.filename);
    return backup.filename;
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function manifestEntryCount(): number {
    return readManifestFile().backups.length;
  }

  function manifestHas(name: string, companyId: string): boolean {
    return readManifestFile().backups.some(
      (b) => b.filename === name && b.companyId === companyId,
    );
  }

  // Counts only unlink calls that targeted the exact stored file; the atomic
  // writer also removes its own `.<name>.<uuid>.tmp` sibling on every publish.
  function targetUnlinkCount(fileName: string): number {
    const target = path.resolve(path.join(BACKUP_DIR, fileName));
    return unlinkSpy.mock.calls.filter((c) => path.resolve(String(c[0])) === target).length;
  }

  it('1. viewer A + backup A → 403, zero unlink', async () => {
    const fileName = await materializeBackup(tenantA.id, 'v1');
    const token = await createSession(viewerA.id);

    const res = await backupDELETE(
      new NextRequest(`http://localhost/api/backup?companyId=${tenantA.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: tenantA.id, filename: fileName }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    const unlinks = targetUnlinkCount(fileName);
    log('1 viewer own:', res.status, '| unlinks matching:', unlinks, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(unlinks).toBe(0);
    expect(fileExists(fileName)).toBe(true);
  });

  it('2. employee A + backup A → 403, zero unlink', async () => {
    const fileName = await materializeBackup(tenantA.id, 'e1');
    const token = await createSession(employeeA.id);

    const res = await backupDELETE(
      new NextRequest(`http://localhost/api/backup?companyId=${tenantA.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: tenantA.id, filename: fileName }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    const unlinks = targetUnlinkCount(fileName);
    log('2 employee own:', res.status, '| unlinks matching:', unlinks, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(unlinks).toBe(0);
    expect(fileExists(fileName)).toBe(true);
  });

  it('3. company_admin A + backup A → 200, one unlink of exact path, entry removed', async () => {
    const fileName = await materializeBackup(tenantA.id, 'c1');
    const token = await createSession(adminA.id);

    const res = await backupDELETE(
      new NextRequest(`http://localhost/api/backup?companyId=${tenantA.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: tenantA.id, filename: fileName }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('3 admin own:', res.status, '| body:', JSON.stringify(body));

    const exactUnlink = unlinkSpy.mock.calls.filter(
      (c) => path.resolve(String(c[0])) === path.resolve(path.join(BACKUP_DIR, fileName)),
    ).length;
    expect(res.status).toBe(200);
    expect(exactUnlink).toBe(1);
    expect(fileExists(fileName)).toBe(false);
    expect(manifestHas(fileName, tenantA.id)).toBe(false);
  });

  it('4. company_admin A + backup B → 404 neutral, zero unlink', async () => {
    const fileNameB = await materializeBackup(tenantB.id, 'b4');
    const token = await createSession(adminA.id);

    const res = await backupDELETE(
      new NextRequest(`http://localhost/api/backup?companyId=${tenantA.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: tenantA.id, filename: fileNameB }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    const unlinks = targetUnlinkCount(fileNameB);
    log('4 cross-tenant real:', res.status, '| unlinks matching:', unlinks, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(404);
    expect(unlinks).toBe(0);
    expect(fileExists(fileNameB)).toBe(true);
  });

  it('5. company_admin A + A_x/../B_<ts>.json → 400, zero unlink (D10-C path collapse)', async () => {
    const fileNameB = await materializeBackup(tenantB.id, 'b5');
    const token = await createSession(adminA.id);
    const traversal = `${tenantA.id}_x/../${fileNameB}`;

    const res = await backupDELETE(
      new NextRequest(`http://localhost/api/backup?companyId=${tenantA.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: tenantA.id, filename: traversal }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    const unlinks = targetUnlinkCount(fileNameB);
    log('5 A_x/../B:', res.status, '| unlinks matching B:', unlinks, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(400);
    expect(unlinks).toBe(0);
    expect(fileExists(fileNameB)).toBe(true);
  });

  it('6. company_admin A + A_../../B_<ts>.json → 400, zero unlink', async () => {
    const fileNameB = await materializeBackup(tenantB.id, 'b6');
    const token = await createSession(adminA.id);
    const traversal = `${tenantA.id}_../../${fileNameB}`;

    const res = await backupDELETE(
      new NextRequest(`http://localhost/api/backup?companyId=${tenantA.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: tenantA.id, filename: traversal }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    const unlinks = targetUnlinkCount(fileNameB);
    log('6 A_../../B:', res.status, '| unlinks matching B:', unlinks, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(400);
    expect(unlinks).toBe(0);
    expect(fileExists(fileNameB)).toBe(true);
  });

  it('7. company_admin A + A_x/../manifest.json → 400, zero unlink, manifest intact', async () => {
    const fileNameA = await materializeBackup(tenantA.id, 'c7');
    const token = await createSession(adminA.id);
    const before = manifestEntryCount();
    const traversal = `${tenantA.id}_x/../manifest.json`;

    const res = await backupDELETE(
      new NextRequest(`http://localhost/api/backup?companyId=${tenantA.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: tenantA.id, filename: traversal }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    const manifestUnlink = unlinkSpy.mock.calls.filter(
      (c) => path.resolve(String(c[0])) === path.resolve(MANIFEST_PATH),
    ).length;
    log('7 manifest target:', res.status, '| manifest unlinks:', manifestUnlink, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(400);
    expect(manifestUnlink).toBe(0);
    expect(fs.existsSync(MANIFEST_PATH)).toBe(true);
    expect(manifestEntryCount()).toBe(before);
    expect(manifestHas(fileNameA, tenantA.id)).toBe(true);
  });

  it('8. company_admin A + nonexistent valid filename → 404, zero unlink', async () => {
    const token = await createSession(adminA.id);
    const phantom = `${tenantA.id}_2099-01-01T00-00-00.json`;

    const res = await backupDELETE(
      new NextRequest(`http://localhost/api/backup?companyId=${tenantA.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: tenantA.id, filename: phantom }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    const unlinks = unlinkSpy.mock.calls.filter((c) => String(c[0]).includes(phantom)).length;
    log('8 nonexistent:', res.status, '| unlinks matching:', unlinks, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(404);
    expect(unlinks).toBe(0);
  });

  it('9. super_admin ctx A + backup B → 404 (bypass role, NOT ownership)', async () => {
    const fileNameB = await materializeBackup(tenantB.id, 'b9');
    const token = await createSession(superUser.id);

    const res = await backupDELETE(
      new NextRequest(`http://localhost/api/backup?companyId=${tenantA.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: tenantA.id, filename: fileNameB }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    const unlinks = targetUnlinkCount(fileNameB);
    log('9 super ctxA + backupB:', res.status, '| unlinks matching B:', unlinks, '| error:', JSON.stringify(body.error));
    expect(res.status).toBe(404);
    expect(unlinks).toBe(0);
    expect(fileExists(fileNameB)).toBe(true);
  });

  it('10. super_admin ctx B + backup B → 200, one unlink', async () => {
    const fileNameB = await materializeBackup(tenantB.id, 'b10');
    const token = await createSession(superUser.id);

    const res = await backupDELETE(
      new NextRequest(`http://localhost/api/backup?companyId=${tenantB.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: tenantB.id, filename: fileNameB }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    const exactUnlink = unlinkSpy.mock.calls.filter(
      (c) => path.resolve(String(c[0])) === path.resolve(path.join(BACKUP_DIR, fileNameB)),
    ).length;
    log('10 super ctxB + backupB:', res.status, '| exact unlinks:', exactUnlink, '| body:', JSON.stringify(body));
    expect(res.status).toBe(200);
    expect(exactUnlink).toBe(1);
    expect(fileExists(fileNameB)).toBe(false);
    expect(manifestHas(fileNameB, tenantB.id)).toBe(false);
  });

  it('11. after deleting own backup: siblings + other-tenant backups + manifest survive', async () => {
    const fileA1 = await materializeBackup(tenantA.id, 's1');
    await sleep(1100);
    const fileA2 = await materializeBackup(tenantA.id, 's2');
    await sleep(1100);
    const fileB1 = await materializeBackup(tenantB.id, 's3');
    const token = await createSession(adminA.id);

    log('11 spacings: A1=', fileA1, 'A2=', fileA2, 'B1=', fileB1, '| distinct:', new Set([fileA1, fileA2, fileB1]).size === 3);
    expect(new Set([fileA1, fileA2, fileB1]).size).toBe(3);

    const res = await backupDELETE(
      new NextRequest(`http://localhost/api/backup?companyId=${tenantA.id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: tenantA.id, filename: fileA1 }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);

    expect(fileExists(fileA1)).toBe(false);
    expect(fileExists(fileA2)).toBe(true);
    expect(fileExists(fileB1)).toBe(true);

    const manifest = readManifestFile();
    expect(manifest.backups.some((b) => b.filename === fileA1 && b.companyId === tenantA.id)).toBe(false);
    expect(manifest.backups.some((b) => b.filename === fileA2 && b.companyId === tenantA.id)).toBe(true);
    expect(manifest.backups.some((b) => b.filename === fileB1 && b.companyId === tenantB.id)).toBe(true);
  });

  it('0. backup created via POST materializes real file + manifest entry (control)', async () => {
    const adminAToken = await createSession(adminA.id);
    const res = await backupPOST(
      new NextRequest(`http://localhost/api/backup?companyId=${tenantA.id}`, {
        method: 'POST',
        headers: authHeaders(adminAToken),
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('0 POST control:', res.status, '| filename:', body.filename);
    expect(res.status).toBe(200);
    expect(typeof body.filename).toBe('string');
    expect(fileExists(body.filename)).toBe(true);
    trackCreatedFile(body.filename);
  });
});