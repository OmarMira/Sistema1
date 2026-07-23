import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, clearDatabase } from '../helpers/factories';
import { db } from '@/lib/db';
import { NextRequest } from 'next/server';

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-placeholder'));

const mockCreateAuditLog = vi.hoisted(() => vi.fn());

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: mockGetSessionUserId,
}));

vi.mock('@/lib/audit', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/audit')>();
  mockCreateAuditLog.mockImplementation(mod.createAuditLogWithRetry);
  return {
    ...mod,
    createAuditLogWithRetry: mockCreateAuditLog,
  };
});

describe('H2 — Rollback del audit log', () => {
  beforeEach(async () => {
    mockCreateAuditLog.mockClear();
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('fallo en createAuditLogWithRetry: todo revierte (status, balances, sin audit log)', async () => {
    mockCreateAuditLog.mockRejectedValueOnce(new Error('Simulated audit log failure'));

    const user = await createTestUser('h2-rollback-fail@example.com');
    const company = await createTestCompany('H2 Rollback Fail');
    await createTestCompanyMember(user.id, company.id);

    mockGetSessionUserId.mockResolvedValue(user.id);

    const glAsset = await createTestGlAccount({ companyId: company.id, code: '1500', name: 'Asset', normalBalance: 'debit' });
    const glEquity = await createTestGlAccount({ companyId: company.id, code: '3500', name: 'Equity', normalBalance: 'credit' });

    const entry = await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2025-06-15'),
        description: 'Draft for rollback test',
        status: 'draft',
        lines: {
          create: [
            { glAccountId: glAsset.id, debit: 1000, credit: 0 },
            { glAccountId: glEquity.id, debit: 0, credit: 1000 },
          ],
        },
      },
    });

    const { POST } = await import('../../src/app/api/journal/[id]/route');

    const res = await POST(
      new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'post' }),
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );

    expect(res.status).toBe(500);

    const reloaded = await db.journalEntry.findUnique({
      where: { id: entry.id },
      select: { status: true },
    });
    expect(reloaded?.status).toBe('draft');

    const afterAsset = await db.glAccount.findUnique({ where: { id: glAsset.id }, select: { balance: true } });
    const afterEquity = await db.glAccount.findUnique({ where: { id: glEquity.id }, select: { balance: true } });
    expect(afterAsset?.balance).toBe(0);
    expect(afterEquity?.balance).toBe(0);

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'journalEntry', entityId: entry.id },
    });
    expect(auditLogs).toHaveLength(0);
  });

  it('crea audit log con tx real, luego falla recalculateBalance: el audit insertado también revierte', async () => {
    const { JournalEntryService } = await import('@/lib/services/journal-entry.service');
    const recalculateSpy = vi.spyOn(JournalEntryService, 'recalculateBalance');
    recalculateSpy.mockRejectedValue(new Error('Simulated recalculate failure'));

    const user = await createTestUser('h2-rollback-audit-created@example.com');
    const company = await createTestCompany('H2 Rollback Audit Created');
    await createTestCompanyMember(user.id, company.id);

    mockGetSessionUserId.mockResolvedValue(user.id);

    const glAsset = await createTestGlAccount({ companyId: company.id, code: '1501', name: 'Asset2', normalBalance: 'debit' });
    const glEquity = await createTestGlAccount({ companyId: company.id, code: '3501', name: 'Equity2', normalBalance: 'credit' });

    const entry = await db.journalEntry.create({
      data: {
        companyId: company.id,
        date: new Date('2025-06-15'),
        description: 'Draft for rollback with created audit log',
        status: 'draft',
        lines: {
          create: [
            { glAccountId: glAsset.id, debit: 1000, credit: 0 },
            { glAccountId: glEquity.id, debit: 0, credit: 1000 },
          ],
        },
      },
    });

    const { POST } = await import('../../src/app/api/journal/[id]/route');

    const res = await POST(
      new NextRequest(`http://localhost/api/journal/${entry.id}?companyId=${company.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'post' }),
      }),
      { params: Promise.resolve({ id: entry.id }) },
    );

    expect(res.status).toBe(500);

    const reloaded = await db.journalEntry.findUnique({
      where: { id: entry.id },
      select: { status: true },
    });
    expect(reloaded?.status).toBe('draft');

    const afterAsset = await db.glAccount.findUnique({ where: { id: glAsset.id }, select: { balance: true } });
    const afterEquity = await db.glAccount.findUnique({ where: { id: glEquity.id }, select: { balance: true } });
    expect(afterAsset?.balance).toBe(0);
    expect(afterEquity?.balance).toBe(0);

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'journalEntry', entityId: entry.id },
    });
    expect(auditLogs).toHaveLength(0);

    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1);

    recalculateSpy.mockRestore();
  });
});
