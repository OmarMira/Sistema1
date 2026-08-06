import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { proxy } from '@/proxy';
import { POST as journalPOST } from '@/app/api/journal/route';
import { POST as journalActionPOST } from '@/app/api/journal/[id]/route';
import { POST as applyAllPOST } from '@/app/api/bank-rules/apply-all/route';
import { POST as backupPOST } from '@/app/api/backup/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';
import config from '../../rules/rbac-config.json';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

const BACKUP_DIR = 'db/backups';
const fs = require('fs');
const path = require('path');

const createdCompanyIds = new Set<string>();
const diskTestCompanyIds = new Set<string>();

function authHeaders(token: string): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  h.set('Authorization', `Bearer ${token}`);
  return h;
}

describe('F-3 — Sensitive routes validate membership but apply no role checks server-side (dynamic PoC)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
    const ids = [...createdCompanyIds];
    createdCompanyIds.clear();
    if (ids.length === 0) return;
    const filter = { companyId: { in: ids } };
    await db.journalLine.deleteMany({ where: { entry: filter } }).catch(() => {});
    await db.journalEntry.deleteMany({ where: filter }).catch(() => {});
    await db.glAccount.deleteMany({ where: filter }).catch(() => {});
    await db.companyMember.deleteMany({ where: filter }).catch(() => {});
    await db.company.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    // Clean up backup files/manifest entries for test companies
    try {
      const manifestPath = path.join(BACKUP_DIR, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const kept = manifest.backups.filter((b: any) => !diskTestCompanyIds.has(b.companyId));
        if (kept.length !== manifest.backups.length) {
          fs.writeFileSync(manifestPath, JSON.stringify({ backups: kept }, null, 2) + '\n', 'utf-8');
        }
      }
      for (const f of fs.readdirSync(BACKUP_DIR)) {
        if (diskTestCompanyIds.has(f.split('_')[0])) {
          fs.unlinkSync(path.join(BACKUP_DIR, f));
        }
      }
    } catch {
      // ignore
    }
  });

  afterAll(async () => {
    const leftoverUsers = await db.user.count({ where: { email: { contains: '@example.com' } } });
    const leftoverCompanies = await db.company.count({ where: { legalName: { in: ['RBAC Test Corp'] } } });
    log('AFTER-ALL DB STATE: users =', leftoverUsers, '| rbac companies =', leftoverCompanies);
  });

  it('Policy data point: rbac-config.json declares journal_entries.post for [super_admin,accountant], not viewer', async () => {
    const allowed = (config.permissions as Record<string, Record<string, string[]>>).journal_entries.post;
    log('RBAC CONFIG DATA POINT: journal_entries.post allowed roles =', JSON.stringify(allowed));
    expect(allowed).not.toContain('viewer');
    expect(allowed).not.toContain('employee');
  });

  it('viewer can POST a new journal entry (write op intended for accountant/admin)', async () => {
    const user = await createTestUser('viewer-f3@example.com');
    const company = await createTestCompany('RBAC Test Corp');
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'viewer' } });
    createdCompanyIds.add(company.id);

    const gl1 = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });
    const gl2 = await createTestGlAccount({ companyId: company.id, code: '2000', name: 'AP' });

    const token = await createSession(user.id);
    const res = await journalPOST(
      new NextRequest(`http://localhost/api/journal?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          companyId: company.id,
          date: '2026-03-01',
          description: 'Viewer-created entry',
          status: 'draft',
          lines: [
            { glAccountId: gl1.id, debit: 100, credit: 0 },
            { glAccountId: gl2.id, debit: 0, credit: 100 },
          ],
        }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('VIEWER POST /api/journal: status =', res.status, '| entry id =', body.id);
    expect(res.status).toBe(201);
  });

  it('viewer can POST /api/journal/[id] { action: post } — posts the entry (write op intended for accountant)', async () => {
    const user = await createTestUser('viewer-f3b@example.com');
    const company = await createTestCompany('RBAC Test Corp');
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'viewer' } });
    createdCompanyIds.add(company.id);

    const gl1 = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Cash' });
    const gl2 = await createTestGlAccount({ companyId: company.id, code: '2000', name: 'AP' });
    const entry = await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2026-03-01'),
        description: 'Draft to be posted by viewer',
        status: 'draft',
        lines: { create: [
          { glAccountId: gl1.id, debit: 100, credit: 0 },
          { glAccountId: gl2.id, debit: 0, credit: 100 },
        ] },
      },
    });
    log('SEEDED draft entry id =', entry.id);

    const token = await createSession(user.id);
    const res = await journalActionPOST(
      new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ action: 'post' }),
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    const body = await res.json();
    log('VIEWER POST action=post: status =', res.status, '| entry status =', body.status);
    expect(res.status).toBe(200);
    expect(body.status).toBe('posted');

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { status: true } });
    log('DB CHECK: entry status after viewer post =', stored?.status);
    expect(stored?.status).toBe('posted');
  });

  it('viewer can POST /api/bank-rules/apply-all — runs automatic classification (write op)', async () => {
    const user = await createTestUser('viewer-f3c@example.com');
    const company = await createTestCompany('RBAC Test Corp');
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'viewer' } });
    createdCompanyIds.add(company.id);

    const token = await createSession(user.id);
    const res = await applyAllPOST(
      new NextRequest(`http://localhost/api/bank-rules/apply-all?companyId=${company.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ companyId: company.id, confirmed: true }),
      }),
      { params: Promise.resolve({}) },
    );
    const body = await res.json();
    log('VIEWER POST apply-all: status =', res.status, '| body =', JSON.stringify(body));
    // apply-all with no transactions returns EXECUTED/success 200 — NOT 403
    expect([200, 201]).toContain(res.status);
  });

  it('viewer can POST /api/backup — exports full company backup (write op intended for admin)', async () => {
    const user = await createTestUser('viewer-f3d@example.com');
    const company = await createTestCompany('RBAC Test Corp');
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'viewer' } });
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
    const body = await res.json();
    log('VIEWER POST /api/backup: status =', res.status, '| filename =', body.filename, '| size =', body.size);
    expect(res.status).toBe(200);
    expect(body.filename).toBeDefined();
  });

  it('proxy does NOT enforce RBAC roles either (only session presence + CSRF)', async () => {
    const user = await createTestUser('viewer-f3e@example.com');
    const company = await createTestCompany('RBAC Test Corp');
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'viewer' } });
    createdCompanyIds.add(company.id);

    const token = await createSession(user.id);
    const req = new NextRequest(`http://localhost/api/journal?companyId=${company.id}`, {
      method: 'POST',
      headers: authHeaders(token),
    });
    const proxied = await proxy(req);
    log('PROXY CHECK: POST /api/journal as viewer -> proxy status =', proxied.status);
    expect(proxied.status).toBe(200);
  });
});
