import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';

// ── Hoisted mock factories (must be before vi.mock) ─────────

const { mockGetSessionUserId, mockCheckRateLimit, mockDbUserFindUnique, mockDbCompanyMemberFindUnique, mockRequestContextRun, mockLoggerError } = vi.hoisted(() => ({
  mockGetSessionUserId: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockDbUserFindUnique: vi.fn(),
  mockDbCompanyMemberFindUnique: vi.fn(),
  mockRequestContextRun: vi.fn(),
  mockLoggerError: vi.fn(),
}));

// ── Mock all external dependencies ──────────────────────────

vi.mock('@/lib/sessions', () => ({
  getSessionUserId: mockGetSessionUserId,
}));

vi.mock('@/lib/security/rate-limiter', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/db', () => ({
  db: {
    user: { findUnique: mockDbUserFindUnique },
    companyMember: { findUnique: mockDbCompanyMemberFindUnique },
  },
}));

vi.mock('@/lib/context-storage', () => ({
  requestContext: { run: mockRequestContextRun },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: mockLoggerError },
}));

// ── Helpers ─────────────────────────────────────────────────

function createRequest(url = 'http://localhost/api/test', init?: RequestInit): NextRequest {
  return new NextRequest(url, init);
}

const defaultContext: RouteContext = { params: Promise.resolve({}) };

// Default rate limit: allow
mockCheckRateLimit.mockReturnValue({
  allowed: true,
  limit: 100,
  remaining: 99,
  resetAt: Math.ceil(Date.now() / 1000) + 60,
});

describe('apiHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequestContextRun.mockImplementation(async (_ctx: unknown, fn: () => unknown) => fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /* ── Auth validation ─────────────────────────────────── */

  it('throws AuthError when not authenticated and allowAnonymous is false', async () => {
    mockGetSessionUserId.mockResolvedValue(null);

    const handler = apiHandler(async () => NextResponse.json({ ok: true }));
    const req = createRequest();
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Unauthorized');
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('allows anonymous when allowAnonymous is true', async () => {
    mockGetSessionUserId.mockResolvedValue(null);
    mockCheckRateLimit.mockReturnValue({
      allowed: true, limit: 100, remaining: 99, resetAt: Math.ceil(Date.now() / 1000),
    });

    const handler = apiHandler(
      async () => NextResponse.json({ ok: true }),
      { allowAnonymous: true },
    );
    const req = createRequest();
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(200);
  });

  /* ── Membership validation ──────────────────────────── */

  it('requires companyId when requireMembership is true', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });

    const handler = apiHandler(async () => NextResponse.json({ ok: true }));
    const req = createRequest('http://localhost/api/test'); // no companyId
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('companyId is required');
  });

  it('returns 403 when user is not a company member', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyMemberFindUnique.mockResolvedValue(null); // no membership

    const handler = apiHandler(async () => NextResponse.json({ ok: true }));
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
  });

  it('allows request when user is a member', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1' });

    const handler = apiHandler(async () => NextResponse.json({ ok: true }));
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(200);
  });

  /* ── Super Admin ─────────────────────────────────────── */

  it('requires super_admin role when requireSuperAdmin is true', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' }); // not super_admin

    const handler = apiHandler(
      async () => NextResponse.json({ ok: true }),
      { requireSuperAdmin: true },
    );
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(403);
  });

  it('allows super_admin to bypass membership check', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'super_admin' });

    const handler = apiHandler(async () => NextResponse.json({ ok: true }));
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(200);
    // Should NOT have checked membership
    expect(mockDbCompanyMemberFindUnique).not.toHaveBeenCalled();
  });

  /* ── Rate limiting ───────────────────────────────────── */

  it('returns 429 when rate limit exceeded', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1' });

    mockCheckRateLimit.mockReturnValue({
      allowed: false,
      limit: 100,
      remaining: 0,
      resetAt: Math.ceil(Date.now() / 1000) + 60,
    });

    const handler = apiHandler(async () => NextResponse.json({ ok: true }));
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain('Too Many Requests');
    expect(body.retryAfter).toBeDefined();
    // Should have rate limit headers
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('rate limit key uses x-forwarded-for when no user', async () => {
    mockGetSessionUserId.mockResolvedValue(null);
    mockCheckRateLimit.mockReturnValue({
      allowed: false,
      limit: 100,
      remaining: 0,
      resetAt: Math.ceil(Date.now() / 1000) + 60,
    });

    const handler = apiHandler(
      async () => NextResponse.json({ ok: true }),
      { allowAnonymous: true },
    );
    const req = createRequest('http://localhost/api/test', {
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(429);
    expect(mockCheckRateLimit.mock.calls[0][0]).toBe('10.0.0.1');
  });

  /* ── Error handling ──────────────────────────────────── */

  it('returns AppError as JSON with correct status and code', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1' });

    const handler = apiHandler(async () => {
      throw new ValidationError('Bad input', { field: 'email' });
    });
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Bad input');
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details).toEqual({ field: 'email' });
  });

  it('handles object-like errors with statusCode', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1' });

    const handler = apiHandler(async () => {
      throw { statusCode: 403, message: 'Custom', code: 'CUSTOM' };
    });
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Custom');
    expect(body.code).toBe('CUSTOM');
  });

  it('handles Prisma-like errors (code + clientVersion)', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1' });

    const handler = apiHandler(async () => {
      throw { code: 'P2002', clientVersion: '5.0.0', meta: { target: ['email'] } };
    });
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Database constraint');
    expect(body.code).toBe('DATABASE_ERROR');
  });

  it('handles unknown errors as 500', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1' });

    const handler = apiHandler(async () => {
      throw new Error('Something broke');
    });
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    expect(body.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('includes details for object-like errors in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1' });

    const handler = apiHandler(async () => {
      throw { statusCode: 400, message: 'Bad', code: 'BAD', details: { x: 1 } };
    });
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    const body = await res.json();
    expect(body.details).toEqual({ x: 1 });
  });

  it('does NOT include details for object-like errors in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1' });

    const handler = apiHandler(async () => {
      throw { statusCode: 400, message: 'Bad', code: 'BAD', details: { x: 1 } };
    });
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    const body = await res.json();
    expect(body.details).toBeUndefined();
  });

  /* ── Security headers ────────────────────────────────── */

  it('injects security headers on success response', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1' });

    const handler = apiHandler(async () => NextResponse.json({ ok: true }));
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('injects security headers on error response', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1' });

    const handler = apiHandler(async () => {
      throw new Error('fail');
    });
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('injects rate limit headers on success', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1' });

    mockCheckRateLimit.mockReturnValue({
      allowed: true, limit: 50, remaining: 48, resetAt: 99999,
    });

    const handler = apiHandler(async () => NextResponse.json({ ok: true }));
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    const res = await handler(req, defaultContext);

    expect(res.headers.get('X-RateLimit-Limit')).toBe('50');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('48');
    expect(res.headers.get('X-RateLimit-Reset')).toBe('99999');
  });

  /* ── Parameter pollution detection ───────────────────── */

  it('detects companyId mismatch between URL and body', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');

    const handler = apiHandler(async () => NextResponse.json({ ok: true }));
    const req = createRequest('http://localhost/api/test?companyId=url-company', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: 'body-company' }),
    });
    const res = await handler(req, defaultContext);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Parameter pollution');
  });

  /* ── Context storage ─────────────────────────────────── */

  it('runs handler inside requestContext with userId and companyId', async () => {
    mockGetSessionUserId.mockResolvedValue('user-123');
    mockDbUserFindUnique.mockResolvedValue({ role: 'company_admin' });
    mockDbCompanyMemberFindUnique.mockResolvedValue({ id: 'member-1' });
    mockRequestContextRun.mockImplementation(async (_ctx, fn) => fn());

    const handler = apiHandler(async () => NextResponse.json({ ok: true }));
    const req = createRequest('http://localhost/api/test?companyId=company-1');
    await handler(req, defaultContext);

    expect(mockRequestContextRun).toHaveBeenCalledWith(
      { userId: 'user-123', companyId: 'company-1' },
      expect.any(Function),
    );
  });
});
