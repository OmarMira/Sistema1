import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockCompanyCount, mockUserCount, mockAuditCount } = vi.hoisted(() => ({
  mockCompanyCount: vi.fn(),
  mockUserCount: vi.fn(),
  mockAuditCount: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    company: { count: mockCompanyCount },
    user: { count: mockUserCount },
    auditLog: { count: mockAuditCount },
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

/**
 * The probe answers the first-run question with four fields: `empty`/`hasUsers`
 * (the original shape) plus `freshInstallation`/`retainedAudit`, because a
 * zero-company database is only FRESH when it also retains no audit history
 * (audit rows outlive their company, so a deliberate deletion must not look
 * like a formatted machine).
 */
describe('GET /api/bootstrap/check — response shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditCount.mockResolvedValue(0);
  });

  it('companyCount=0, userCount=0 → empty and fresh installation', async () => {
    mockCompanyCount.mockResolvedValue(0);
    mockUserCount.mockResolvedValue(0);
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body).toEqual({
      empty: true,
      hasUsers: false,
      freshInstallation: true,
      retainedAudit: false,
    });
  });

  it('companyCount=0, userCount=1 → empty with users but still a fresh installation', async () => {
    mockCompanyCount.mockResolvedValue(0);
    mockUserCount.mockResolvedValue(1);
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body).toEqual({
      empty: true,
      hasUsers: true,
      freshInstallation: true,
      retainedAudit: false,
    });
  });

  it('companyCount=0 with retained audit rows → deleted, NOT a fresh installation', async () => {
    mockCompanyCount.mockResolvedValue(0);
    mockUserCount.mockResolvedValue(0);
    mockAuditCount.mockResolvedValue(3);
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body).toEqual({
      empty: true,
      hasUsers: false,
      freshInstallation: false,
      retainedAudit: true,
    });
  });

  it('companyCount=1, userCount=0 → not empty, no fresh-installation claim', async () => {
    mockCompanyCount.mockResolvedValue(1);
    mockUserCount.mockResolvedValue(0);
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body).toEqual({
      empty: false,
      hasUsers: false,
      freshInstallation: false,
      retainedAudit: false,
    });
  });

  it('companyCount=1, userCount=1 → not empty, no fresh-installation claim', async () => {
    mockCompanyCount.mockResolvedValue(1);
    mockUserCount.mockResolvedValue(1);
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body).toEqual({
      empty: false,
      hasUsers: true,
      freshInstallation: false,
      retainedAudit: false,
    });
  });

  it('companyCount=5, userCount=12 → not empty, no fresh-installation claim', async () => {
    mockCompanyCount.mockResolvedValue(5);
    mockUserCount.mockResolvedValue(12);
    mockAuditCount.mockResolvedValue(40);
    const res = await GET(req(), ctx);
    const body = await res.json();
    expect(body).toEqual({
      empty: false,
      hasUsers: true,
      freshInstallation: false,
      retainedAudit: false,
    });
  });
});
