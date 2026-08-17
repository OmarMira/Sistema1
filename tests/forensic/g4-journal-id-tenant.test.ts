import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { createSession } from '@/lib/sessions';
import { GET, PUT, POST } from '@/app/api/journal/[id]/route';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestGlAccount,
  clearDatabase,
} from '../helpers/factories';

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

describe('D2-H13 — journal/[id] enforces active-tenant authority resource-scoped (GET/PUT/POST)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  describe('cross-tenant access denied (tenant A cannot touch tenant B entry)', () => {
    it('GET /api/journal/[id]: tenant A member cannot read tenant B entry (403, no leak)', async () => {
      const attacker = await createTestUser('a-x-get@example.com');
      const attackerCompany = await createTestCompany('Tenant A');
      await createTestCompanyMember(attacker.id, attackerCompany.id);

      const victimCompany = await createTestCompany('Tenant B');
      const { entry } = await seedEntry(victimCompany.id, 'TOP SECRET B ENTRY');

      const token = await createSession(attacker.id);
      const res = await GET(
        new NextRequest(`http://localhost/api/journal/${entry.id}`, {
          method: 'GET',
          headers: authHeaders(token),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Forbidden');
      expect(JSON.stringify(body)).not.toContain('TOP SECRET B ENTRY');
    });

    it('PUT /api/journal/[id]: tenant A member cannot modify tenant B entry (403, entry unchanged)', async () => {
      const attacker = await createTestUser('a-x-put@example.com');
      const attackerCompany = await createTestCompany('Tenant A');
      await createTestCompanyMember(attacker.id, attackerCompany.id);

      const victimCompany = await createTestCompany('Tenant B');
      const { gl1, gl2, entry } = await seedEntry(victimCompany.id, 'Victim B draft');

      const token = await createSession(attacker.id);
      const res = await PUT(
        new NextRequest(`http://localhost/api/journal/${entry.id}`, {
          method: 'PUT',
          headers: authHeaders(token),
          body: JSON.stringify({
            description: 'HACKED BY TENANT A',
            lines: [
              { glAccountId: gl1.id, debit: 999, credit: 0 },
              { glAccountId: gl2.id, debit: 0, credit: 999 },
            ],
          }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(403);
      const stored = await db.journalEntry.findUnique({ where: { id: entry.id } });
      expect(stored?.description).toBe('Victim B draft');
      expect(stored?.status).toBe('draft');
    });

    it('POST /api/journal/[id]: tenant A member cannot post tenant B entry (403, entry unchanged)', async () => {
      const attacker = await createTestUser('a-x-post@example.com');
      const attackerCompany = await createTestCompany('Tenant A');
      await createTestCompanyMember(attacker.id, attackerCompany.id);

      const victimCompany = await createTestCompany('Tenant B');
      const { entry } = await seedEntry(victimCompany.id, 'Victim B draft to protect');

      const token = await createSession(attacker.id);
      const res = await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}`, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ action: 'post' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(403);
      const stored = await db.journalEntry.findUnique({ where: { id: entry.id } });
      expect(stored?.status).toBe('draft');
    });
  });

  describe('inactive company denied (fail-closed)', () => {
    it('GET /api/journal/[id]: member of deactivated company cannot read entry (403)', async () => {
      const user = await createTestUser('inact-get@example.com');
      const company = await createTestCompany('Deactivated Corp');
      await createTestCompanyMember(user.id, company.id);
      const { entry } = await seedEntry(company.id, 'Entry of deactivated company');

      await db.company.update({ where: { id: company.id }, data: { isActive: false } });

      const token = await createSession(user.id);
      const res = await GET(
        new NextRequest(`http://localhost/api/journal/${entry.id}`, {
          method: 'GET',
          headers: authHeaders(token),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Company is deactivated');
      expect(JSON.stringify(body)).not.toContain('Entry of deactivated company');
    });

    it('PUT /api/journal/[id]: member of deactivated company cannot modify entry (403)', async () => {
      const user = await createTestUser('inact-put@example.com');
      const company = await createTestCompany('Deactivated Corp');
      await createTestCompanyMember(user.id, company.id);
      const { gl1, gl2, entry } = await seedEntry(company.id, 'Deactivated draft');

      await db.company.update({ where: { id: company.id }, data: { isActive: false } });

      const token = await createSession(user.id);
      const res = await PUT(
        new NextRequest(`http://localhost/api/journal/${entry.id}`, {
          method: 'PUT',
          headers: authHeaders(token),
          body: JSON.stringify({
            description: 'Should not apply',
            lines: [
              { glAccountId: gl1.id, debit: 100, credit: 0 },
              { glAccountId: gl2.id, debit: 0, credit: 100 },
            ],
          }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(403);
      const stored = await db.journalEntry.findUnique({ where: { id: entry.id } });
      expect(stored?.description).toBe('Deactivated draft');
    });

    it('POST /api/journal/[id]: member of deactivated company cannot post entry (403)', async () => {
      const user = await createTestUser('inact-post@example.com');
      const company = await createTestCompany('Deactivated Corp');
      await createTestCompanyMember(user.id, company.id);
      const { entry } = await seedEntry(company.id, 'Deactivated post target');

      await db.company.update({ where: { id: company.id }, data: { isActive: false } });

      const token = await createSession(user.id);
      const res = await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}`, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ action: 'post' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(403);
      const stored = await db.journalEntry.findUnique({ where: { id: entry.id } });
      expect(stored?.status).toBe('draft');
    });
  });

  describe('owner of active company keeps valid behavior', () => {
    it('GET /api/journal/[id]: owning company_admin can read own entry (200)', async () => {
      const user = await createTestUser('owner-get@example.com');
      const company = await createTestCompany('Owner Corp');
      await createTestCompanyMember(user.id, company.id);
      const { entry } = await seedEntry(company.id, 'My own entry');

      const token = await createSession(user.id);
      const res = await GET(
        new NextRequest(`http://localhost/api/journal/${entry.id}`, {
          method: 'GET',
          headers: authHeaders(token),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe(entry.id);
      expect(body.description).toBe('My own entry');
      expect(body.companyId).toBe(company.id);
    });

    it('PUT /api/journal/[id]: owning company_admin can update own draft (200)', async () => {
      const user = await createTestUser('owner-put@example.com');
      const company = await createTestCompany('Owner Corp');
      await createTestCompanyMember(user.id, company.id);
      const { gl1, gl2, entry } = await seedEntry(company.id, 'Draft to edit');

      const token = await createSession(user.id);
      const res = await PUT(
        new NextRequest(`http://localhost/api/journal/${entry.id}`, {
          method: 'PUT',
          headers: authHeaders(token),
          body: JSON.stringify({
            description: 'Updated by owner',
            lines: [
              { glAccountId: gl1.id, debit: 150, credit: 0 },
              { glAccountId: gl2.id, debit: 0, credit: 150 },
            ],
          }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.description).toBe('Updated by owner');
      expect(body.status).toBe('draft');
    });

    it('POST /api/journal/[id]: owning company_admin can post own draft (200)', async () => {
      const user = await createTestUser('owner-post@example.com');
      const company = await createTestCompany('Owner Corp');
      await createTestCompanyMember(user.id, company.id);
      const { entry } = await seedEntry(company.id, 'Draft to post');

      const token = await createSession(user.id);
      const res = await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}`, {
          method: 'POST',
          headers: authHeaders(token),
          body: JSON.stringify({ action: 'post' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('posted');
    });
  });
});