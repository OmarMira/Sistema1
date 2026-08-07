import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-1'));
const mockCheckRateLimit = vi.hoisted(() => vi.fn());
const mockDbUserFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyMemberFindUnique = vi.hoisted(() => vi.fn());
const mockDbJournalFindMany = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockDbJournalCount = vi.hoisted(() => vi.fn().mockResolvedValue(0));

vi.mock('@/lib/sessions', () => ({ getSessionUserId: mockGetSessionUserId }));
vi.mock('@/lib/security/rate-limiter', () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mockDbUserFindUnique },
    company: { findUnique: mockDbCompanyFindUnique },
    companyMember: { findUnique: mockDbCompanyMemberFindUnique },
    journalEntry: {
      findMany: mockDbJournalFindMany,
      count: mockDbJournalCount,
    },
  },
}));

import { GET } from '@/app/api/journal/route';

function getRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/journal?companyId=c1${query}`, {
    method: 'GET',
  });
}

type Where = { date?: { gte?: Date; lte?: Date } };

function lastWhere(): Where {
  const last = mockDbJournalFindMany.mock.calls.at(-1)?.[0];
  return last?.where as Where;
}

describe('GET /api/journal — date range filter boundary (D5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionUserId.mockResolvedValue('user-1');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyFindUnique.mockResolvedValue({ isActive: true });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1' });
    mockCheckRateLimit.mockReturnValue({ allowed: true, limit: 100, remaining: 99, resetAt: Math.ceil(Date.now() / 1000) + 60 });
    mockDbJournalFindMany.mockResolvedValue([]);
    mockDbJournalCount.mockResolvedValue(0);
  });

  it('start of the range is included (gte = lower bound midnight)', async () => {
    await GET(getRequest('&startDate=2025-06-01&endDate=2025-06-30'), { params: Promise.resolve({}) });
    const where = lastWhere();
    expect(where!.date!.gte).toEqual(new Date('2025-06-01T00:00:00.000Z'));
  });

  it('a row at endDate T00:00:00.000Z is within the range', async () => {
    await GET(getRequest('&startDate=2025-06-01&endDate=2025-06-30'), { params: Promise.resolve({}) });
    const lte = lastWhere()!.date!.lte!;
    expect(lte.getTime()).toBeGreaterThanOrEqual(new Date('2025-06-30T00:00:00.000Z').getTime());
  });

  it('a row at endDate T12:00:00.000Z is within the range', async () => {
    await GET(getRequest('&startDate=2025-06-01&endDate=2025-06-30'), { params: Promise.resolve({}) });
    const lte = lastWhere()!.date!.lte!;
    expect(lte.getTime()).toBeGreaterThanOrEqual(new Date('2025-06-30T12:00:00.000Z').getTime());
  });

  it('a row at endDate T23:59:59.999Z is included (inclusive full end day)', async () => {
    await GET(getRequest('&startDate=2025-06-01&endDate=2025-06-30'), { params: Promise.resolve({}) });
    expect(lastWhere()!.date!.lte).toEqual(new Date('2025-06-30T23:59:59.999Z'));
  });

  it('a row at next-day T00:00:00.000Z is excluded', async () => {
    await GET(getRequest('&startDate=2025-06-01&endDate=2025-06-30'), { params: Promise.resolve({}) });
    expect(new Date('2025-07-01T00:00:00.000Z').getTime()).toBeGreaterThan(lastWhere()!.date!.lte!.getTime());
  });

  it('endDate must not introduce a lower bound when none is sent (only endDate)', async () => {
    await GET(getRequest('&endDate=2025-06-30'), { params: Promise.resolve({}) });
    const date = lastWhere()!.date!;
    expect(date.lte).toEqual(new Date('2025-06-30T23:59:59.999Z'));
    expect(date.gte).toBeUndefined();
  });

  it('startDate must not introduce an upper bound when none is sent (only startDate)', async () => {
    await GET(getRequest('&startDate=2025-06-01'), { params: Promise.resolve({}) });
    const date = lastWhere()!.date!;
    expect(date.gte).toEqual(new Date('2025-06-01T00:00:00.000Z'));
    expect(date.lte).toBeUndefined();
  });

  it('both bounds are set when both are sent', async () => {
    await GET(getRequest('&startDate=2025-06-01&endDate=2025-06-30'), { params: Promise.resolve({}) });
    const date = lastWhere()!.date!;
    expect(date.gte).toEqual(new Date('2025-06-01T00:00:00.000Z'));
    expect(date.lte).toEqual(new Date('2025-06-30T23:59:59.999Z'));
  });

  it('no date filter is applied when neither extreme is sent', async () => {
    await GET(getRequest(''), { params: Promise.resolve({}) });
    const where = lastWhere();
    expect(where!.date).toBeUndefined();
  });
});