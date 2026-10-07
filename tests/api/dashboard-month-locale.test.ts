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
  $queryRaw: vi.fn(),
}));

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: vi.fn().mockResolvedValue('user-test'),
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

import { GET } from '@/app/api/dashboard/route';

const trendRows = [
  { month: '2026-01', income: BigInt(100), expenses: BigInt(50) },
  { month: '2026-09', income: BigInt(10), expenses: BigInt(5) },
];

async function callDashboard(query = '') {
  const req = new NextRequest(`http://localhost/api/dashboard?companyId=c1${query}`);
  const res = await GET(req, { params: Promise.resolve({}) });
  return { res, body: await res.json() };
}

describe('GET /api/dashboard — monthlyTrend month labels by locale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.user.findUnique.mockResolvedValue({ id: 'user-test', platformRole: 'user' });
    mockDb.companyMember.findUnique.mockResolvedValue({
      id: 'member-test',
      userId: 'user-test',
      companyId: 'c1',
    });
    mockDb.company.findUnique.mockResolvedValue({ isActive: true });
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
    mockDb.bankAccount.findMany.mockResolvedValue([]);
    mockDb.bankTransaction.findMany.mockResolvedValue([]);
    mockDb.bankTransaction.count.mockResolvedValue(0);
    mockDb.fiscalPeriod.findFirst.mockResolvedValue(null);
    mockDb.fiscalPeriod.findMany.mockResolvedValue([]);
    mockDb.journalEntry.count.mockResolvedValue(0);
    // Only the monthly-trend query reads BankTransaction; GL balance queries
    // must stay empty so the mocked trend rows land on the right call.
    mockDb.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      return Promise.resolve(sql.includes('BankTransaction') ? trendRows : []);
    });
  });

  it('keeps the legacy capitalized Spanish labels when no locale is sent', async () => {
    const { res, body } = await callDashboard();

    expect(res.status).toBe(200);
    expect(body.monthlyTrend).toEqual([
      { month: 'Ene', income: 100, expenses: 50 },
      { month: 'Sep', income: 10, expenses: 5 },
    ]);
  });

  it('returns the same Spanish labels for locale=es (default parity)', async () => {
    const { body } = await callDashboard('&locale=es');

    expect(body.monthlyTrend.map((r: { month: string }) => r.month)).toEqual(['Ene', 'Sep']);
  });

  it('localizes month labels to English for locale=en', async () => {
    const { body } = await callDashboard('&locale=en');

    expect(body.monthlyTrend).toEqual([
      { month: 'Jan', income: 100, expenses: 50 },
      { month: 'Sep', income: 10, expenses: 5 },
    ]);
  });

  it('falls back to Spanish for an unsupported locale value', async () => {
    const { body } = await callDashboard('&locale=fr');

    expect(body.monthlyTrend.map((r: { month: string }) => r.month)).toEqual(['Ene', 'Sep']);
  });
});
