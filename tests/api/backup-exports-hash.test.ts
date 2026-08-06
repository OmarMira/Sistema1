import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { POST as backupPOST } from '@/app/api/backup/route';
import { createTestUser, createTestCompany, createTestCompanyMember, clearDatabase } from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

const BACKUP_DIR = path.join(process.cwd(), 'db', 'backups');
const MANIFEST_PATH = path.join(BACKUP_DIR, 'manifest.json');
const diskTestCompanyIds = new Set<string>();

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
  const kept = manifest.backups.filter((b) => !diskTestCompanyIds.has(String(b.companyId)));
  if (kept.length !== manifest.backups.length) {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ backups: kept }, null, 2) + '\n', 'utf-8');
  }
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (diskTestCompanyIds.has(f.split('_')[0])) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
  }
}

describe('F-4 — created backups must not export user passwordHash (remediation)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
    cleanupDiskArtifacts();
  });

  afterAll(async () => {
    cleanupDiskArtifacts();
    log('AFTER-ALL: remaining @example.com users =', await db.user.count({ where: { email: { contains: '@example.com' } } }));
  });

  it('Q1: POST /api/backup response data does not contain passwordHash for any user', async () => {
    const user = await createTestUser('f4-q1@example.com');
    const company = await createTestCompany('F4 Q1 Co');
    await createTestCompanyMember(user.id, company.id);
    diskTestCompanyIds.add(company.id);
    const token = await createSession(user.id);

    const req = new NextRequest(`http://localhost/api/backup?companyId=${company.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await backupPOST(req, { params: Promise.resolve({}) });
    const body = await res.json();

    const backupData = JSON.parse(Buffer.from(body.data, 'base64').toString('utf-8'));
    const leaked = backupData.data.users.filter((u: Record<string, unknown>) => 'passwordHash' in u);
    const stored = await db.user.findUnique({ where: { id: user.id } });

    log('Q1: POST /api/backup -> status =', res.status, '| users in backup =', backupData.data.users.length);
    log('Q1: users with a passwordHash field in the backup =', leaked.length, '| DB hash exists =', stored?.passwordHash ? 'yes' : 'no');
    expect(res.status).toBe(200);
    expect(leaked).toHaveLength(0);
  });

  it('Q2 (control): the backup still contains essential user data (email, role)', async () => {
    const user = await createTestUser('f4-q2@example.com');
    const company = await createTestCompany('F4 Q2 Co');
    await createTestCompanyMember(user.id, company.id);
    diskTestCompanyIds.add(company.id);
    const token = await createSession(user.id);

    const req = new NextRequest(`http://localhost/api/backup?companyId=${company.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await backupPOST(req, { params: Promise.resolve({}) });
    const body = await res.json();
    const backupData = JSON.parse(Buffer.from(body.data, 'base64').toString('utf-8'));
    const userRecord = backupData.data.users.find((u: Record<string, unknown>) => u.email === 'f4-q2@example.com');

    log('Q2: user record in backup -> email =', userRecord?.email, '| role =', userRecord?.role, '| has passwordHash key =', 'passwordHash' in (userRecord ?? {}));
    expect(res.status).toBe(200);
    expect(userRecord?.email).toBe('f4-q2@example.com');
    expect(userRecord?.role).toBe('company_admin');
  });

  it('Q3 (control): the backup manifest still reports user counts', async () => {
    const user = await createTestUser('f4-q3@example.com');
    const company = await createTestCompany('F4 Q3 Co');
    await createTestCompanyMember(user.id, company.id);
    diskTestCompanyIds.add(company.id);
    const token = await createSession(user.id);

    const req = new NextRequest(`http://localhost/api/backup?companyId=${company.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await backupPOST(req, { params: Promise.resolve({}) });
    const body = await res.json();
    const backupData = JSON.parse(Buffer.from(body.data, 'base64').toString('utf-8'));

    log('Q3: manifest.recordCounts.users =', backupData.manifest.recordCounts.users, '| users array length =', backupData.data.users.length);
    expect(res.status).toBe(200);
    expect(backupData.manifest.recordCounts.users).toBe(backupData.data.users.length);
  });
});
