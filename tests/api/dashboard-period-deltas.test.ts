import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  companyMember: { findUnique: vi.fn() },
  company: { findUnique: vi.fn() },
  companyModuleEntitlement: { findFirst: vi.fn() },
  bankAccount: { findMany: vi.fn() },
  journalLine: { findMany: vi.fn() },
  bankTransaction: { findMany: vi.fn(), count: vi.fn() },
  fiscalPeriod: { findFirst: vi.fn(), findMany: vi.fn() },
  journalEntry: { count: vi.fn() },
  $queryRaw: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn().mockResolvedValue('user-test'),
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

import { GET } from '@/app/api/dashboard/route';

function mockContext() {
  mockDb.user.findUnique.mockResolvedValue({ id: 'user-test', platformRole: 'user' });
  mockDb.companyMember.findUnique.mockResolvedValue({
    id: 'member-test',
    userId: 'user-test',
    companyId: 'c1',
  });
  mockDb.company.findUnique.mockResolvedValue({ isActive: true });
}

async function callDashboard() {
  const req = new NextRequest('http://localhost/api/dashboard?companyId=c1');
  const res = await GET(req, { params: Promise.resolve({}) });
  return { res, body: await res.json() };
}

describe('GET /api/dashboard — real period metrics and deltas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContext();
    mockDb.bankAccount.findMany.mockResolvedValue([]);
    mockDb.bankTransaction.findMany.mockResolvedValue([]);
    mockDb.bankTransaction.count.mockResolvedValue(0);
    mockDb.fiscalPeriod.findFirst.mockResolvedValue(null);
    mockDb.fiscalPeriod.findMany.mockResolvedValue([]);
    mockDb.journalEntry.count.mockResolvedValue(0);
    mockDb.companyModuleEntitlement.findFirst.mockResolvedValue({
      id: 'entitlement-1',
      companyId: 'c1',
      moduleKey: 'accounting',
      enabled: true,
      activatedAt: new Date(),
      deactivatedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('computes period-scoped revenue and real deltas against the previous period', async () => {
    const currentPeriod = {
      name: 'September 2026',
      startDate: new Date('2026-09-01T00:00:00.000Z'),
      endDate: new Date('2026-09-30T23:59:59.999Z'),
    };
    const prevPeriod = {
      name: 'August 2026',
      startDate: new Date('2026-08-01T00:00:00.000Z'),
      endDate: new Date('2026-08-31T23:59:59.999Z'),
    };
    mockDb.fiscalPeriod.findFirst
      .mockResolvedValueOnce(currentPeriod)
      .mockResolvedValueOnce(prevPeriod);
    mockDb.$queryRaw
      .mockResolvedValueOnce([
        // all-time balances: assets 1000
        { accountType: 'asset', normalBalance: 'debit', totalDebit: BigInt(1000), totalCredit: BigInt(0) },
      ])
      .mockResolvedValueOnce([
        // snapshot at period start: assets 800
        { accountType: 'asset', normalBalance: 'debit', totalDebit: BigInt(800), totalCredit: BigInt(0) },
      ])
      .mockResolvedValueOnce([
        // current period: revenue 500
        { accountType: 'revenue', normalBalance: 'credit', totalDebit: BigInt(0), totalCredit: BigInt(500) },
      ])
      .mockResolvedValueOnce([
        // previous period: revenue 400
        { accountType: 'revenue', normalBalance: 'credit', totalDebit: BigInt(0), totalCredit: BigInt(400) },
      ])
      .mockResolvedValueOnce([]); // monthly trend

    const { res, body } = await callDashboard();

    expect(res.status).toBe(200);
    expect(body.period.name).toBe('September 2026');
    expect(body.period.startDate).toBe('2026-09-01T00:00:00.000Z');
    expect(body.period.prevStartDate).toBe('2026-08-01T00:00:00.000Z');
    // all-time totals stay available and untouched
    expect(body.totalAssets).toBe(1000);
    // period card values come from the period window, not all-time totals
    expect(body.periodRevenue).toBe(500);
    expect(body.periodExpenses).toBe(0);
    expect(body.deltas.assets).toBe(25); // (1000 - 800) / 800
    expect(body.deltas.revenue).toBe(25); // (500 - 400) / 400
    expect(body.deltas.liabilities).toBeNull(); // 0 vs 0 has no honest percentage
    expect(body.deltas.expenses).toBeNull();
  });

  it('falls back to the current calendar month and hides deltas when there is no history', async () => {
    const { res, body } = await callDashboard();

    const now = new Date();
    const expectedStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
    const expectedEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999),
    ).toISOString();
    const expectedPrevStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    ).toISOString();

    expect(res.status).toBe(200);
    expect(body.period.name).toBeNull();
    expect(body.period.startDate).toBe(expectedStart);
    expect(body.period.endDate).toBe(expectedEnd);
    expect(body.period.prevStartDate).toBe(expectedPrevStart);
    expect(body.periodRevenue).toBe(0);
    expect(body.deltas).toEqual({
      assets: null,
      liabilities: null,
      revenue: null,
      expenses: null,
    });
  });
});
