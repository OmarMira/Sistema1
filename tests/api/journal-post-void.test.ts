import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from '../../src/app/api/journal/[id]/route';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, clearDatabase } from '../helpers/factories';
import { createSession } from '@/lib/sessions';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import * as JournalEntryServiceModule from '@/lib/services/journal-entry.service';

async function createDraftEntry(companyId: string, debitGl: string, creditGl: string) {
  return db.journalEntry.create({
    data: {
      companyId,
      date: new Date('2025-06-15'),
      description: 'Draft entry for testing',
      status: 'draft',
      lines: {
        create: [
          { glAccountId: debitGl, debit: 1000, credit: 0 },
          { glAccountId: creditGl, debit: 0, credit: 1000 },
        ],
      },
    },
  });
}

async function createPostedEntry(companyId: string, debitGl: string, creditGl: string) {
  return db.journalEntry.create({
    data: {
      companyId,
      date: new Date('2025-06-15'),
      description: 'Posted entry for testing',
      status: 'posted',
      lines: {
        create: [
          { glAccountId: debitGl, debit: 1000, credit: 0 },
          { glAccountId: creditGl, debit: 0, credit: 1000 },
        ],
      },
    },
  });
}

describe('H2 — POST /api/journal/[id] (verificación de mitigación)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  describe('H2-A: Atomicidad', () => {
    it('post: cambia draft → posted dentro de $transaction', async () => {
      const user = await createTestUser('h2a-post@example.com');
      const company = await createTestCompany('H2A Post');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1000', name: 'Asset' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3000', name: 'Equity' });
      const entry = await createDraftEntry(company.id, glAsset.id, glEquity.id);

      const res = await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'post' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('posted');
    });

    it('void: cambia posted → void dentro de $transaction', async () => {
      const user = await createTestUser('h2a-void@example.com');
      const company = await createTestCompany('H2A Void');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1001', name: 'Asset' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3001', name: 'Equity' });
      const entry = await createPostedEntry(company.id, glAsset.id, glEquity.id);

      const res = await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'void' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('void');
    });

    it('prova rollback: si recalculateBalance falla, el status no cambia', async () => {
      const user = await createTestUser('h2a-rollback@example.com');
      const company = await createTestCompany('H2A Rollback');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1002', name: 'Asset' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3002', name: 'Equity' });
      const entry = await createDraftEntry(company.id, glAsset.id, glEquity.id);

      const spy = vi.spyOn(JournalEntryServiceModule.JournalEntryService, 'recalculateBalance')
        .mockRejectedValueOnce(new Error('Simulated failure inside $transaction'));

      const res = await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'post' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(500);

      const reloaded = await db.journalEntry.findUnique({ where: { id: entry.id } });
      expect(reloaded?.status).toBe('draft');

      spy.mockRestore();
    });

    it('prova rollback: audit log no queda persistido si la transacción falla', async () => {
      const user = await createTestUser('h2a-audit-rollback@example.com');
      const company = await createTestCompany('H2A Audit Rollback');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1003', name: 'Asset' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3003', name: 'Equity' });
      const entry = await createDraftEntry(company.id, glAsset.id, glEquity.id);

      const spy = vi.spyOn(JournalEntryServiceModule.JournalEntryService, 'recalculateBalance')
        .mockRejectedValueOnce(new Error('Simulated failure inside $transaction'));

      const res = await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'post' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(500);

      const auditLogs = await db.auditLog.findMany({
        where: { companyId: company.id, entity: 'journalEntry', entityId: entry.id },
      });
      expect(auditLogs).toHaveLength(0);

      spy.mockRestore();
    });

    it('post: rechaza posted → post (estado inválido)', async () => {
      const user = await createTestUser('h2a-invalid@example.com');
      const company = await createTestCompany('H2A Invalid');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1004', name: 'Asset' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3004', name: 'Equity' });
      const entry = await createPostedEntry(company.id, glAsset.id, glEquity.id);

      const res = await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'post' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Only draft entries can be posted');
    });

    it('void: rechaza draft → void (estado inválido)', async () => {
      const user = await createTestUser('h2a-invalid-void@example.com');
      const company = await createTestCompany('H2A Invalid Void');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1005', name: 'Asset' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3005', name: 'Equity' });
      const entry = await createDraftEntry(company.id, glAsset.id, glEquity.id);

      const res = await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'void' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Only posted entries can be voided');
    });

    it('rechaza acción inválida', async () => {
      const user = await createTestUser('h2a-bad-action@example.com');
      const company = await createTestCompany('H2A BadAction');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1006', name: 'Asset' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3006', name: 'Equity' });
      const entry = await createPostedEntry(company.id, glAsset.id, glEquity.id);

      const res = await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('Invalid action');
    });

    it('rechaza entrada inexistente', async () => {
      const user = await createTestUser('h2a-notfound@example.com');
      const company = await createTestCompany('H2A NotFound');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const res = await POST(
        new NextRequest(`http://localhost/api/journal/nonexistent?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'post' }),
        }),
        { params: Promise.resolve({ id: 'nonexistent' }) },
      );

      expect(res.status).toBe(404);
    });
  });

  describe('H2-B: Período fiscal', () => {
    it('post: bloquea posteo en período cerrado', async () => {
      const user = await createTestUser('h2b-period@example.com');
      const company = await createTestCompany('H2B Period');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1100', name: 'Asset Period' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3100', name: 'Equity Period' });

      await db.fiscalPeriod.create({
        data: {
          companyId: company.id,
          name: 'June 2025',
          startDate: new Date('2025-06-01'),
          endDate: new Date('2025-06-30'),
          isLocked: true,
        },
      });

      const entry = await createDraftEntry(company.id, glAsset.id, glEquity.id);

      const res = await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'post' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('closed period');
    });

    it('void: bloquea anulación en período cerrado', async () => {
      const user = await createTestUser('h2b-void-period@example.com');
      const company = await createTestCompany('H2B Void Period');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1101', name: 'Asset Void Period' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3101', name: 'Equity Void Period' });

      await db.fiscalPeriod.create({
        data: {
          companyId: company.id,
          name: 'June 2025',
          startDate: new Date('2025-06-01'),
          endDate: new Date('2025-06-30'),
          isLocked: true,
        },
      });

      const entry = await createPostedEntry(company.id, glAsset.id, glEquity.id);

      const res = await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'void' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain('closed period');
    });

    it('post: permite posteo en período abierto', async () => {
      const user = await createTestUser('h2b-open@example.com');
      const company = await createTestCompany('H2B Open');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1102', name: 'Asset Open' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3102', name: 'Equity Open' });

      await db.fiscalPeriod.create({
        data: {
          companyId: company.id,
          name: 'June 2025',
          startDate: new Date('2025-06-01'),
          endDate: new Date('2025-06-30'),
          isLocked: false,
        },
      });

      const entry = await createDraftEntry(company.id, glAsset.id, glEquity.id);

      const res = await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'post' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe('posted');
    });
  });

  describe('H2-C: Balances', () => {
    it('post: actualiza GlAccount.balance de todas las líneas', async () => {
      const user = await createTestUser('h2c-balance@example.com');
      const company = await createTestCompany('H2C Balance');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1200', name: 'Asset Bal', normalBalance: 'debit' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3200', name: 'Equity Bal', normalBalance: 'credit' });
      const entry = await createDraftEntry(company.id, glAsset.id, glEquity.id);

      await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'post' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      const afterAsset = await db.glAccount.findUnique({ where: { id: glAsset.id }, select: { balance: true } });
      const afterEquity = await db.glAccount.findUnique({ where: { id: glEquity.id }, select: { balance: true } });

      expect(afterAsset?.balance).toBe(1000);
      expect(afterEquity?.balance).toBe(1000);
    });

    it('void: actualiza GlAccount.balance (mismas líneas siguen existiendo)', async () => {
      const user = await createTestUser('h2c-void-balance@example.com');
      const company = await createTestCompany('H2C Void Balance');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1201', name: 'Asset Void', normalBalance: 'debit' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3201', name: 'Equity Void', normalBalance: 'credit' });
      const entry = await createPostedEntry(company.id, glAsset.id, glEquity.id);

      await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'void' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      const afterAsset = await db.glAccount.findUnique({ where: { id: glAsset.id }, select: { balance: true } });
      const afterEquity = await db.glAccount.findUnique({ where: { id: glEquity.id }, select: { balance: true } });

      expect(afterAsset?.balance).toBe(0);
      expect(afterEquity?.balance).toBe(0);
    });
  });

  describe('H2-D: Trazabilidad', () => {
    it('post: crea audit log', async () => {
      const user = await createTestUser('h2d-audit@example.com');
      const company = await createTestCompany('H2D Audit');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1300', name: 'Asset Audit' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3300', name: 'Equity Audit' });
      const entry = await createDraftEntry(company.id, glAsset.id, glEquity.id);

      await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'post' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      const auditLogs = await db.auditLog.findMany({
        where: { companyId: company.id, entity: 'journalEntry', entityId: entry.id },
      });
      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].action).toBe('post');
    });

    it('void: crea audit log', async () => {
      const user = await createTestUser('h2d-void-audit@example.com');
      const company = await createTestCompany('H2D Void Audit');
      await createTestCompanyMember(user.id, company.id);
      const token = await createSession(user.id);

      const glAsset = await createTestGlAccount({ companyId: company.id, code: '1301', name: 'Asset Void Audit' });
      const glEquity = await createTestGlAccount({ companyId: company.id, code: '3301', name: 'Equity Void Audit' });
      const entry = await createPostedEntry(company.id, glAsset.id, glEquity.id);

      await POST(
        new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'void' }),
        }),
        { params: Promise.resolve({ id: entry.id }) },
      );

      const auditLogs = await db.auditLog.findMany({
        where: { companyId: company.id, entity: 'journalEntry', entityId: entry.id },
      });
      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].action).toBe('void');
    });
  });
});
