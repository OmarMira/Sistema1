import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockCompanyCount, mockUserCount } = vi.hoisted(() => ({
  mockCompanyCount: vi.fn(),
  mockUserCount: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    company: { count: mockCompanyCount },
    user: { count: mockUserCount },
  },
}));

vi.mock('@/lib/api-handler', () => ({
  apiHandler: (handler: any) => handler,
}));

import { GET } from '@/app/api/bootstrap/check/route';

function req(): NextRequest {
  return new NextRequest('http://localhost/api/bootstrap/check', { method: 'GET' });
}
const ctx = { params: Promise.resolve({}) };

describe('GET /api/bootstrap/check — response shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('companyCount=0, userCount=0 → {empty:true, hasUsers:false}', async () => {
    mockCompanyCount.mockResolvedValue(0);
    mockUserCount.mockResolvedValue(0);
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body).toEqual({ empty: true, hasUsers: false });
  });

  it('companyCount=0, userCount=1 → {empty:true, hasUsers:true}', async () => {
    mockCompanyCount.mockResolvedValue(0);
    mockUserCount.mockResolvedValue(1);
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body).toEqual({ empty: true, hasUsers: true });
  });

  it('companyCount=1, userCount=0 → {empty:false, hasUsers:false}', async () => {
    mockCompanyCount.mockResolvedValue(1);
    mockUserCount.mockResolvedValue(0);
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body).toEqual({ empty: false, hasUsers: false });
  });

  it('companyCount=1, userCount=1 → {empty:false, hasUsers:true}', async () => {
    mockCompanyCount.mockResolvedValue(1);
    mockUserCount.mockResolvedValue(1);
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body).toEqual({ empty: false, hasUsers: true });
  });

  it('companyCount=5, userCount=12 → {empty:false, hasUsers:true}', async () => {
    mockCompanyCount.mockResolvedValue(5);
    mockUserCount.mockResolvedValue(12);
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body).toEqual({ empty: false, hasUsers: true });
  });
});
