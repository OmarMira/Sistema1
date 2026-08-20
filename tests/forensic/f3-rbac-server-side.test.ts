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

async function seedEntry(companyId: string, description = 'Draft entry', status = 'draft') {
  const gl1 = await createTestGlAccount({ companyId, code: '1000', name: 'Cash' });
  const gl2 = await createTestGlAccount({ companyId, code: '2000', name: 'AP' });
  const entry = await db.journalEntry.create({
    data: {
      companyId,
      date: new Date('2026-03-01'),
      description,
      status,
      lines: {
        create: [
          { glAccountId: gl1.id, debit: 100, credit: 0 },
          { glAccountId: gl2.id, debit: 0, credit: 100 },
        ],
      },
    },
  });
  return { gl1, gl2, entry };
}

describe('F-3 — Sensitive routes enforce CompanyMember.role server-side (regression)', () => {
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
    const leftoverCompanies = await db.company.count({ where: { legalName: { in: ['RBAC Test Corp', 'RBAC Other Corp'] } } });
    log('AFTER-ALL DB STATE: users =', leftoverUsers, '| rbac companies =', leftoverCompanies);
  });

  it('Policy data point: rbac-config.json declares journal_entries.post for [super_admin,company_admin], not viewer/employee', async () => {
    const allowed = (config.permissions as Record<string, Record<string, string[]>>).journal_entries.post;
    log('RBAC CONFIG DATA POINT: journal_entries.post allowed roles =', JSON.stringify(allowed));
    expect(allowed).toContain('super_admin');
    expect(allowed).toContain('company_admin');
    expect(allowed).not.toContain('viewer');
    expect(allowed).not.toContain('employee');
  });

  it('Policy data point: rbac-config.json uses runtime vocabulary (no admin/accountant anywhere)', async () => {
    const cfg = config as { roles: string[]; permissions: Record<string, Record<string, string[]>> };
    expect([...cfg.roles].sort()).toEqual(['company_admin', 'employee', 'super_admin', 'viewer'].sort());
    for (const resource of Object.values(cfg.permissions)) {
      for (const allowed of Object.values(resource)) {
        expect(allowed).not.toContain('admin');
        expect(allowed).not.toContain('accountant');
      }
    }
  });

  it('Policy data point: resolved D1-H1 matrix is expressed in config', async () => {
    const perms = (config as { permissions: Record<string, Record<string, string[]>> }).permissions;
    const matrix: Array<[string, string, string[]]> = [
      ['journal_entries', 'create', ['super_admin', 'company_admin']],
      ['journal_entries', 'post', ['super_admin', 'company_admin']],
      ['system', 'audit_view', ['super_admin']],
      ['reports', 'read', ['super_admin', 'company_admin', 'employee', 'viewer']],
      ['reports', 'export_pdf', ['super_admin', 'company_admin', 'employee', 'viewer']],
      ['bank_reconciliation', 'link', ['super_admin', 'company_admin', 'employee']],
      ['bank_reconciliation', 'export', ['super_admin', 'company_admin', 'employee', 'viewer']],
    ];
    for (const [r, a, expected] of matrix) {
      expect([...(perms[r]?.[a] ?? [])].sort()).toEqual([...expected].sort());
    }
  });

  it('viewer cannot POST a new journal entry (403)', async () => {
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
    log('VIEWER POST /api/journal: status =', res.status, '| error =', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(body.error).toBe('Forbidden');
  });

  it('employee cannot POST a new journal entry (403)', async () => {
    const user = await createTestUser('employee-f3@example.com');
    const company = await createTestCompany('RBAC Test Corp');
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'employee' } });
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
          description: 'Employee-created entry',
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
    log('EMPLOYEE POST /api/journal: status =', res.status, '| error =', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(body.error).toBe('Forbidden');
  });

  it('company_admin control: can POST a new journal entry (201)', async () => {
    const user = await createTestUser('admin-f3@example.com');
    const company = await createTestCompany('RBAC Test Corp');
    await createTestCompanyMember(user.id, company.id);
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
          description: 'Admin-created entry',
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
    log('COMPANY_ADMIN POST /api/journal: status =', res.status, '| entry id =', body.id);
    expect(res.status).toBe(201);
  });

  it('viewer cannot post /api/journal/[id] { action: post } (403) and the entry stays unchanged', async () => {
    const user = await createTestUser('viewer-f3b@example.com');
    const company = await createTestCompany('RBAC Test Corp');
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'viewer' } });
    createdCompanyIds.add(company.id);
    const { entry } = await seedEntry(company.id, 'Draft to be posted by viewer');
    log('SEEDED draft entry id =', entry.id);

    const token = await createSession(user.id);
    const res = await journalActionPOST(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ action: 'post' }),
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    const body = await res.json();
    log('VIEWER POST action=post (no companyId sent): status =', res.status, '| error =', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(body.error).toBe('Forbidden');

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { status: true } });
    log('DB CHECK: entry status after viewer post attempt =', stored?.status);
    expect(stored?.status).toBe('draft');
  });

  it('viewer cannot void /api/journal/[id] { action: void } (403) and the entry stays unchanged', async () => {
    const user = await createTestUser('viewer-f3void@example.com');
    const company = await createTestCompany('RBAC Test Corp');
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'viewer' } });
    createdCompanyIds.add(company.id);
    const { entry } = await seedEntry(company.id, 'Draft to be voided by viewer');

    const token = await createSession(user.id);
    const res = await journalActionPOST(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ action: 'void' }),
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    const body = await res.json();
    log('VIEWER POST action=void: status =', res.status, '| error =', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(body.error).toBe('Forbidden');

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { status: true } });
    log('DB CHECK: entry status after viewer void attempt =', stored?.status);
    expect(stored?.status).toBe('draft');
  });

  it('member of ANOTHER company cannot post /api/journal/[id] (403, resource-scoped, no companyId sent)', async () => {
    const attacker = await createTestUser('other-f3@example.com');
    const attackerCompany = await createTestCompany('RBAC Other Corp');
    await createTestCompanyMember(attacker.id, attackerCompany.id);
    createdCompanyIds.add(attackerCompany.id);

    const victimCompany = await createTestCompany('RBAC Test Corp');
    createdCompanyIds.add(victimCompany.id);
    const { entry } = await seedEntry(victimCompany.id, 'Victim draft to protect');
    log('SEEDED: attacker member of OTHER company | victim entry id =', entry.id);

    const token = await createSession(attacker.id);
    const res = await journalActionPOST(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ action: 'post' }),
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    const body = await res.json();
    log('OTHER-COMPANY POST action=post: status =', res.status, '| error =', JSON.stringify(body.error));
    expect(res.status).toBe(403);

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { status: true } });
    log('DB CHECK: victim entry status after attack =', stored?.status);
    expect(stored?.status).toBe('draft');
  });

  it('a fake companyId sent by the client does NOT prevail over entry.companyId (403)', async () => {
    const attacker = await createTestUser('fakecid-f3@example.com');
    const attackerCompany = await createTestCompany('RBAC Other Corp');
    await createTestCompanyMember(attacker.id, attackerCompany.id);
    createdCompanyIds.add(attackerCompany.id);

    const victimCompany = await createTestCompany('RBAC Test Corp');
    createdCompanyIds.add(victimCompany.id);
    const { entry } = await seedEntry(victimCompany.id, 'Victim entry with fake companyId');
    log('SEEDED victim entry id =', entry.id, '| attacker sends fake companyId =', victimCompany.id);

    const token = await createSession(attacker.id);
    const res = await journalActionPOST(
      new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${victimCompany.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ action: 'post', companyId: victimCompany.id }),
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    const body = await res.json();
    log('FAKE COMPANYID ATTACK: status =', res.status, '| error =', JSON.stringify(body.error));
    expect(res.status).toBe(403);

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { status: true } });
    expect(stored?.status).toBe('draft');
  });

  it('company_admin of the owning company can post with NO companyId sent (200, resource-scoped)', async () => {
    const user = await createTestUser('own-admin-f3@example.com');
    const company = await createTestCompany('RBAC Test Corp');
    await createTestCompanyMember(user.id, company.id);
    createdCompanyIds.add(company.id);
    const { entry } = await seedEntry(company.id, 'Draft to be posted by owning admin');

    const token = await createSession(user.id);
    const res = await journalActionPOST(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ action: 'post' }),
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    const body = await res.json();
    log('OWNING COMPANY_ADMIN POST action=post (no companyId): status =', res.status, '| status =', body.status);
    expect(res.status).toBe(200);
    expect(body.status).toBe('posted');

    const stored = await db.journalEntry.findUnique({ where: { id: entry.id }, select: { status: true } });
    expect(stored?.status).toBe('posted');
  });

  it('super_admin without membership keeps bypass on /api/journal/[id] (200)', async () => {
    const admin = await createTestUser('superadmin-f3@example.com');
    await db.user.update({ where: { id: admin.id }, data: { platformRole: 'super_admin' } });
    const company = await createTestCompany('RBAC Test Corp');
    createdCompanyIds.add(company.id);
    const { entry } = await seedEntry(company.id, 'Draft to be posted by super_admin');
    log('SEEDED: super_admin with NO membership row | entry id =', entry.id);

    const token = await createSession(admin.id);
    const res = await journalActionPOST(
      new NextRequest(`http://localhost/api/journal/${entry.id}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ action: 'post' }),
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );
    const body = await res.json();
    log('SUPER_ADMIN POST action=post (no membership): status =', res.status, '| status =', body.status);
    expect(res.status).toBe(200);
    expect(body.status).toBe('posted');
  });

  it('viewer cannot POST /api/bank-rules/apply-all (403)', async () => {
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
    log('VIEWER POST apply-all: status =', res.status, '| error =', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(body.error).toBe('Forbidden');
  });

  it('viewer cannot POST /api/backup (403)', async () => {
    const user = await createTestUser('viewer-f3d@example.com');
    const company = await createTestCompany('RBAC Test Corp');
    await db.companyMember.create({ data: { userId: user.id, companyId: company.id, role: 'viewer' } });
    createdCompanyIds.add(company.id);

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
    log('VIEWER POST /api/backup: status =', res.status, '| error =', JSON.stringify(body.error));
    expect(res.status).toBe(403);
    expect(body.error).toBe('Forbidden');
  });

  it('company_admin control: can POST /api/backup (200)', async () => {
    const user = await createTestUser('admin-backup-f3@example.com');
    const company = await createTestCompany('RBAC Test Corp');
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
    const body = await res.json();
    log('COMPANY_ADMIN POST /api/backup: status =', res.status, '| filename =', body.filename);
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
