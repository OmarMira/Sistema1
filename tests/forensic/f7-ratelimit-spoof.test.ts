import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { authRateLimiter } from '@/lib/rate-limiter';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as registerPOST } from '@/app/api/auth/register/route';
import { clearDatabase } from '../helpers/factories';

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

function buildRegisterRequest(ip: string, email: string): NextRequest {
  return new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({
      email,
      password: 'Passw0rd123!',
      firstName: 'F7',
      lastName: 'Test',
      companyName: `F7 Spoof Co ${email.split('@')[0]}`,
    }),
  });
}

async function loginAttempt(ip: string | null, email: string): Promise<number> {
  const res = await loginPOST(buildLoginRequest(ip, email), { params: Promise.resolve({}) });
  return res.status;
}

async function registerAttempt(ip: string, email: string): Promise<{ status: number; remaining: string | null }> {
  const res = await registerPOST(buildRegisterRequest(ip, email), { params: Promise.resolve({}) });
  return { status: res.status, remaining: res.headers.get('X-RateLimit-Remaining') };
}

describe('F-7 — Rate limiter keyed on client-controlled x-forwarded-for (dynamic PoC)', () => {
  beforeEach(async () => {
    authRateLimiter.clear();
    await clearDatabase();
  });

  afterEach(async () => {
    authRateLimiter.clear();
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'ip:10.9' } } }).catch(() => {});
    await db.rateLimit.deleteMany({ where: { key: 'ip:127.0.0.1' } }).catch(() => {});
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'email:f7-' } } }).catch(() => {});
    await db.auditLog.deleteMany({ where: { action: 'RATE_LIMIT_VIOLATION', companyId: 'global' } }).catch(() => {});
    await clearDatabase();
  });

  afterAll(async () => {
    const rateLimitRows = await db.rateLimit.count();
    const testUsers = await db.user.count({ where: { email: { contains: '@example.com' } } });
    log('AFTER-ALL DB STATE: rateLimit rows =', rateLimitRows, '| test users =', testUsers);
  });

  it('Q1: two different x-forwarded-for values produce independent counters (login)', async () => {
    // 5 failed logins with the SAME XFF -> the 6th must be 429 (IP limit = 5/15min)
    const sameIpStatuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      sameIpStatuses.push(await loginAttempt('10.9.0.1', `f7-a-${i}@example.com`));
    }
    log('Q1-CONTROL: 6 failed logins with fixed XFF=10.9.0.1 -> statuses =', sameIpStatuses.join(','));

    // A DIFFERENT XFF value starts a fresh counter -> first attempt must NOT be 429
    const freshIpStatus = await loginAttempt('10.9.0.2', 'f7-a-fresh@example.com');
    log('Q1: first attempt with XFF=10.9.0.2 (after 5 hits on 10.9.0.1) -> status =', freshIpStatus);

    expect(sameIpStatuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(sameIpStatuses[5]).toBe(429);
    expect(freshIpStatus).not.toBe(429);
  });

  it('Q2: the IP limit can be avoided by rotating x-forwarded-for on each attempt', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(await loginAttempt(`10.9.1.${i}`, `f7-b-${i}@example.com`));
    }
    const n429 = statuses.filter((s) => s === 429).length;
    log('Q2-SPOOF: 12 failed logins, XFF rotated on each -> statuses =', statuses.join(','));
    log('Q2-SPOOF: 429 responses =', n429, '(12 attempts against an IP limit of 5)');
    expect(n429).toBe(0);
  });

  it('Q3: a comma list "client, proxy1, proxy2" is truncated to its first element (login)', async () => {
    // 5 failed logins whose XFF always STARTS with 10.9.2.1 (varying tail) -> share the 10.9.2.1 bucket
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(await loginAttempt(`10.9.2.1, 203.0.113.${i}`, `f7-c-${i}@example.com`));
    }
    statuses.push(await loginAttempt('10.9.2.1, 198.51.100.9', 'f7-c-6th@example.com'));
    log('Q3-LIST: 5 logins XFF="10.9.2.1, <proxy>" then 6th -> statuses =', statuses.join(','));
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('Q4: an absent x-forwarded-for falls back to a shared 127.0.0.1 bucket (login)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(await loginAttempt(null, `f7-d-${i}@example.com`));
    }
    log('Q4-ABSENT: 6 failed logins with NO x-forwarded-for header -> statuses =', statuses.join(','));
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('Q5: apiHandler keys anonymous rate limiting on x-forwarded-for too', async () => {
    // 3 register calls (anonymous) across 2 XFF values -> buckets must be per-XFF
    const a1 = await registerAttempt('10.9.3.1', 'f7-api-a@example.com');
    const b = await registerAttempt('10.9.3.2', 'f7-api-b@example.com');
    const a2 = await registerAttempt('10.9.3.1', 'f7-api-c@example.com');
    log('Q5-APIHANDLER: XFF=10.9.3.1 remaining =', a1.remaining, '| XFF=10.9.3.2 remaining =', b.remaining, '| XFF=10.9.3.1 again =', a2.remaining);
    expect(a1.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a2.status).toBe(200);
    const ra1 = Number(a1.remaining);
    const rb = Number(b.remaining);
    const ra2 = Number(a2.remaining);
    expect(ra1).toBe(rb);
    expect(ra2).toBe(ra1 - 1);
  });
});
