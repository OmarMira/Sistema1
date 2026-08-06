import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { authRateLimiter } from '@/lib/rate-limiter';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as meGET } from '@/app/api/auth/me/route';
import { GET as bootstrapCheckGET } from '@/app/api/bootstrap/check/route';
import { createSession } from '@/lib/sessions';
import { createTestUser, clearDatabase } from '../helpers/factories';

const log = (...args: unknown[]) => console.log('[EVIDENCE]', ...args);

function buildLoginRequest(ip: string | null, email: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ip !== null) headers['x-forwarded-for'] = ip;
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password: 'WrongPass1!' }),
  });
}

function authHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function loginAttempt(ip: string | null, email: string): Promise<number> {
  const res = await loginPOST(buildLoginRequest(ip, email), { params: Promise.resolve({}) });
  return res.status;
}

describe('F-7 — Rate limiter keyed on client-controlled x-forwarded-for (dynamic PoC, fixed policy)', () => {
  beforeEach(async () => {
    process.env.CLIENT_IP_SOURCE = 'none';
    authRateLimiter.clear();
    await clearDatabase();
  });

  afterEach(async () => {
    delete process.env.CLIENT_IP_SOURCE;
    authRateLimiter.clear();
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'ip:10.9' } } }).catch(() => {});
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'email:f7-' } } }).catch(() => {});
    await db.auditLog.deleteMany({ where: { action: 'RATE_LIMIT_VIOLATION' } }).catch(() => {});
    await clearDatabase();
  });

  afterAll(async () => {
    const rateLimitRows = await db.rateLimit.count();
    const testUsers = await db.user.count({ where: { email: { contains: '@example.com' } } });
    log('AFTER-ALL DB STATE: rateLimit rows =', rateLimitRows, '| test users =', testUsers);
  });

  it('REQUIRED (RED today): with CLIENT_IP_SOURCE=none, x-forwarded-for is ignored — same XFF never accrues an IP bucket', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(await loginAttempt('10.9.0.1', `f7-r1-${i}@example.com`));
    }
    log('S1: 6 failed logins, SAME XFF=10.9.0.1, DISTINCT emails -> statuses =', statuses.join(','));
    expect(statuses).toEqual([401, 401, 401, 401, 401, 401]);
  });

  it('REQUIRED: rotating x-forwarded-for does not create or change any IP bucket', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(await loginAttempt(`10.9.1.${i}`, 'f7-r2@example.com'));
    }
    log('S2: 5 failed logins, XFF rotated, SAME email -> statuses =', statuses.join(','));
    expect(statuses.every((s) => s === 401)).toBe(true);
  });

  it('REQUIRED: the email bucket still blocks at its own threshold (10/hour)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(await loginAttempt(`10.9.2.${i}`, 'f7-r3@example.com'));
    }
    log('S3: 11 failed logins, XFF rotated, SAME email -> statuses =', statuses.join(','));
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('REQUIRED: authenticated apiHandler requests are keyed by userId, independent of x-forwarded-for', async () => {
    const user = await createTestUser('f7-authed@example.com');
    const token = await createSession(user.id);

    const call = async (ip: string): Promise<Response> => {
      const res = await meGET(
        new NextRequest('http://localhost/api/auth/me', {
          method: 'GET',
          headers: { ...authHeaders(token), 'x-forwarded-for': ip },
        }),
        { params: Promise.resolve({}) },
      );
      return res;
    };

    const r1 = await call('10.9.3.1');
    const r2 = await call('10.9.3.2');
    log(
      'S4: authed /api/auth/me XFF=10.9.3.1 remaining =',
      r1.headers.get('X-RateLimit-Remaining'),
      '| XFF=10.9.3.2 remaining =',
      r2.headers.get('X-RateLimit-Remaining'),
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const remaining1 = Number(r1.headers.get('X-RateLimit-Remaining'));
    const remaining2 = Number(r2.headers.get('X-RateLimit-Remaining'));
    expect(remaining2).toBe(remaining1 - 1);
  });

  it('REQUIRED (RED today): anonymous request without a trusted IP creates NO bucket and reports NO XFF-derived rate-limit headers', async () => {
    const res = await bootstrapCheckGET(
      new NextRequest('http://localhost/api/bootstrap/check', {
        method: 'GET',
        headers: { 'x-forwarded-for': '10.9.4.1' },
      }),
      { params: Promise.resolve({}) },
    );
    log('S5: anonymous GET /api/bootstrap/check XFF=10.9.4.1 -> status =', res.status);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Remaining')).toBeNull();
    expect(res.headers.get('X-RateLimit-Reset')).toBeNull();
  });
});
