import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { POST as backupPOST } from '@/app/api/backup/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  clearDatabase,
} from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

const BACKUP_DIR = path.join(process.cwd(), 'db', 'backups');
const MANIFEST_PATH = path.join(BACKUP_DIR, 'manifest.json');
const createdCompanyIds = new Set<string>();
const diskTestCompanyIds = new Set<string>();

function authHeaders(token: string): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  h.set('Authorization', `Bearer ${token}`);
  return h;
}

describe('F-4 — Backup no longer exports user passwordHash (remediation)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
    const ids = [...createdCompanyIds];
    createdCompanyIds.clear();
    if (ids.length === 0) return;
    const filter = { companyId: { in: ids } };
    await db.companyMember.deleteMany({ where: filter }).catch(() => {});
    await db.company.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    try {
      const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
      const kept = manifest.backups.filter((b: { companyId: string }) => !diskTestCompanyIds.has(b.companyId));
      if (kept.length !== manifest.backups.length) {
        fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ backups: kept }, null, 2) + '\n', 'utf-8');
      }
    } catch {
      // no manifest
    }
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      if (diskTestCompanyIds.has(f.split('_')[0])) {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
      }
    }
  });

  afterAll(async () => {
    const leftoverUsers = await db.user.count({ where: { email: { contains: '@example.com' } } });
    const leftoverCompanies = await db.company.count({ where: { legalName: { in: ['Backup Hash Corp'] } } });
    log('AFTER-ALL DB STATE: users =', leftoverUsers, '| backup companies =', leftoverCompanies);
  });

  it('POST /api/backup no longer includes passwordHash for members (hash stays in the DB)', async () => {
    const user = await createTestUser('member-f4@example.com');
    const realHash = await hashPassword('SuperSecret!2026');
    await db.user.update({ where: { id: user.id }, data: { passwordHash: realHash } });
    const company = await createTestCompany('Backup Hash Corp');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.add(company.id);
    diskTestCompanyIds.add(company.id);

    const stored = await db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
    log('SEEDED: member (company_admin, NOT super_admin) | passwordHash =', stored?.passwordHash?.slice(0, 20) + '...');

    const token = await createSession(user.id);
    const res = await backupPOST(
      new NextRequest(`http://localhost/api/backup?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('POST /api/backup: status =', res.status, '| filename =', body.filename, '| size =', body.size);
    expect(res.status).toBe(200);

    const backupData = JSON.parse(Buffer.from(body.data, 'base64').toString('utf-8'));
    const backupUser = backupData.data.users.find((u: { id: string }) => u.id === user.id);
    log('BACKUP PAYLOAD: user passwordHash present =', Boolean(backupUser?.passwordHash));
    expect(backupUser).toBeDefined();
    expect(backupUser.passwordHash).toBeUndefined();

    const dbHashAfter = await db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
    log('DB HASH AFTER EXPORT: unchanged =', dbHashAfter?.passwordHash === realHash);
    expect(dbHashAfter?.passwordHash).toBe(realHash);
  });

  it('Control: the DB hash is untouched and login with the real password still works', async () => {
    const user = await createTestUser('member-f4b@example.com');
    const realHash = await hashPassword('AnotherSecret!2026');
    await db.user.update({ where: { id: user.id }, data: { passwordHash: realHash } });
    const company = await createTestCompany('Backup Hash Corp');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.add(company.id);
    diskTestCompanyIds.add(company.id);

    const token = await createSession(user.id);
    const res = await backupPOST(
      new NextRequest(`http://localhost/api/backup?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);

    const dbHash = await db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
    const loginOk = await verifyPassword('AnotherSecret!2026', dbHash!.passwordHash);
    log('CONTROL: login with real password after export =', loginOk);
    expect(loginOk).toBe(true);
  });
});
