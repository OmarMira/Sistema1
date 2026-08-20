import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetSessionUserId = vi.hoisted(() => vi.fn().mockResolvedValue('user-1'));
const mockCheckRateLimit = vi.hoisted(() => vi.fn());
const mockDbUserFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyFindUnique = vi.hoisted(() => vi.fn());
const mockDbCompanyMemberFindUnique = vi.hoisted(() => vi.fn());
const mockDbPeriodFindMany = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockDbPeriodCreate = vi.hoisted(() => vi.fn());
const mockDbAuditLogCreate = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('@/lib/sessions', () => ({ getSessionUserId: mockGetSessionUserId }));
vi.mock('@/lib/security/rate-limiter', () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mockDbUserFindUnique },
    company: { findUnique: mockDbCompanyFindUnique },
    companyMember: { findUnique: mockDbCompanyMemberFindUnique },
    fiscalPeriod: {
      findMany: mockDbPeriodFindMany,
      create: mockDbPeriodCreate,
    },
    auditLog: { create: mockDbAuditLogCreate },
  },
}));

import { POST } from '@/app/api/fiscal-periods/route';

function createRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/fiscal-periods?companyId=c1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createDataArgs() {
  return mockDbPeriodCreate.mock.calls.at(-1)?.[0].data;
}

describe('POST /api/fiscal-periods — inclusive end day (D4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionUserId.mockResolvedValue('user-1');
    mockDbUserFindUnique.mockResolvedValue({ platformRole: 'user' });
    mockDbCompanyFindUnique.mockResolvedValue({ isActive: true });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1', role: 'company_admin' });
    mockCheckRateLimit.mockReturnValue({ allowed: true, limit: 100, remaining: 99, resetAt: Math.ceil(Date.now() / 1000) + 60 });
    mockDbPeriodFindMany.mockResolvedValue([]);
  });

  it('keeps the full last day: created period endDate === T23:59:59.999Z while startDate stays at midnight', async () => {
    mockDbPeriodCreate.mockResolvedValue({
      id: 'period-1',
      companyId: 'c1',
      name: 'June 2026',
      startDate: new Date('2026-06-01'),
      endDate: new Date('2026-06-30T23:59:59.999Z'),
      isLocked: false,
    });

    const res = await POST(createRequest({ name: 'June 2026', startDate: '2026-06-01', endDate: '2026-06-30' }), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(200);
    const data = createDataArgs();
    expect(data.startDate).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    expect(data.endDate).toEqual(new Date('2026-06-30T23:59:59.999Z'));

    const body = await res.json();
    expect(new Date(body.period.endDate).getTime()).toBe(new Date('2026-06-30T23:59:59.999Z').getTime());
    expect(new Date('2026-07-01T00:00:00.000Z').getTime()).toBeGreaterThan(
      new Date(body.period.endDate).getTime(),
    );
  });

  it('rejects a request missing date fields before creating anything', async () => {
    const res = await POST(createRequest({ name: 'No Dates' }), { params: Promise.resolve({}) });
    expect(res.status).toBe(400);
    expect(mockDbPeriodCreate).not.toHaveBeenCalled();
  });
});