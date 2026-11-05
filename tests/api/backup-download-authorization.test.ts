import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GET as backupFileGET } from '../../src/app/api/backup/[filename]/route';
import { POST as backupPOST } from '../../src/app/api/backup/route';
import { POST as previewPOST } from '../../src/app/api/backup/restore/preview/route';
import { createTestUser, createTestCompany, createTestGlAccount, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { hashPassword } from '@/lib/auth';
import { BACKUP_DIR } from '@/lib/config/paths';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import fs from 'fs';
import path from 'path';

/**
 * S7 — creating a backup is sudo-style: the route asks the authenticated
 * administrator to re-enter their own password. This suite tests the
 * download/preview ROLE gate, so the fixture owner simply has a real password
 * and every POST /api/backup carries it.
 */
const ADMIN_PASSWORD = 'Clave.Descarga.2026';

async function createBackupAdmin(email: string) {
  const user = await createTestUser(email);
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(ADMIN_PASSWORD) },
  });
  return user;
}

function cleanTestBackups(filenames: string[]) {
  for (const name of filenames) {
    const filePath = path.join(BACKUP_DIR, name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  const manifestPath = path.join(BACKUP_DIR, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.backups = manifest.backups.filter(
        (b: { filename: string }) => !filenames.includes(b.filename),
      );
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch {
      // ignore parse errors on cleanup
    }
  }
}

describe('backup download/preview authorization', () => {
  const createdBackups: string[] = [];

  beforeEach(async () => {
    await clearDatabase();
    createdBackups.length = 0;
  });

  afterEach(async () => {
    await clearDatabase();
    cleanTestBackups(createdBackups);
  });

  async function createBackupAsAdmin(companyId: string, adminToken: string) {
    const res = await backupPOST(
      new NextRequest(`http://localhost/api/backup?companyId=${companyId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    createdBackups.push(body.filename);
    return body.filename as string;
  }

  it('rejects backup download for a viewer (company_admin required)', async () => {
    const owner = await createBackupAdmin('dl-admin@example.com');
    const viewer = await createTestUser('dl-viewer@example.com');
    const company = await createTestCompany('Download Auth Test');
    await db.companyMember.create({ data: { userId: owner.id, companyId: company.id, role: 'company_admin' } });
    await db.companyMember.create({ data: { userId: viewer.id, companyId: company.id, role: 'viewer' } });
    await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash', accountType: 'asset', normalBalance: 'debit' });

    const adminToken = await createSession(owner.id);
    const filename = await createBackupAsAdmin(company.id, adminToken);

    const viewerToken = await createSession(viewer.id);
    const res = await backupFileGET(
      new NextRequest(`http://localhost/api/backup/${filename}?companyId=${company.id}`, {
        headers: { Authorization: `Bearer ${viewerToken}` },
      }),
      { params: Promise.resolve({ filename }) },
    );
    expect(res.status).toBe(403);
  });

  it('still allows company_admin to download their own backup', async () => {
    const owner = await createBackupAdmin('dl-admin-ok@example.com');
    const company = await createTestCompany('Download Auth Admin Test');
    await db.companyMember.create({ data: { userId: owner.id, companyId: company.id, role: 'company_admin' } });
    await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash', accountType: 'asset', normalBalance: 'debit' });

    const adminToken = await createSession(owner.id);
    const filename = await createBackupAsAdmin(company.id, adminToken);

    const res = await backupFileGET(
      new NextRequest(`http://localhost/api/backup/${filename}?companyId=${company.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      { params: Promise.resolve({ filename }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filename).toBe(filename);
    expect(typeof body.data).toBe('string');
  });

  it('rejects restore preview for a viewer (company_admin required)', async () => {
    const owner = await createBackupAdmin('pv-admin@example.com');
    const viewer = await createTestUser('pv-viewer@example.com');
    const company = await createTestCompany('Preview Auth Test');
    await db.companyMember.create({ data: { userId: owner.id, companyId: company.id, role: 'company_admin' } });
    await db.companyMember.create({ data: { userId: viewer.id, companyId: company.id, role: 'viewer' } });
    await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash', accountType: 'asset', normalBalance: 'debit' });

    const adminToken = await createSession(owner.id);
    const filename = await createBackupAsAdmin(company.id, adminToken);
    const filePath = path.join(BACKUP_DIR, filename);
    const data = Buffer.from(fs.readFileSync(filePath, 'utf-8')).toString('base64');

    const viewerToken = await createSession(viewer.id);
    const res = await previewPOST(
      new NextRequest(`http://localhost/api/backup/restore/preview?companyId=${company.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${viewerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ companyId: company.id, data }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(403);
  });
});
