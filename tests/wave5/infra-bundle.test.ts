/**
 * S8 (Wave 5) — infra bundle.
 *
 * Contract pinned here:
 *  (1) a SUCCESSFUL register / resend-verification clears ONLY the per-email
 *      failure bucket. The IP bucket survives, exactly like the login fix T4
 *      landed: otherwise an attacker can spray one attempt per account from the
 *      same IP and launder the IP counter with a single successful call.
 *  (2) the CSP sent by `src/proxy.ts` never ships 'unsafe-eval' to production
 *      (Next.js only needs it for the dev bundler / React Refresh) while
 *      'unsafe-inline' stays, because the app has no nonce infrastructure and
 *      Next injects inline bootstrap scripts. Dev keeps 'unsafe-eval'.
 *  (3) CORS never answers the literal `*`: an allowed origin is echoed, an
 *      unlisted origin gets no CORS header at all, and a request without an
 *      Origin (same-origin navigation/fetch) is untouched.
 *  (4) Prisma CONNECTION-class failures (P1001/P1008/P1010) map to
 *      503 DATABASE_UNAVAILABLE with a retryable hint instead of pretending a
 *      constraint violation happened (400 DATABASE_ERROR).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { authRateLimiter } from '@/lib/rate-limiter';
import { db } from '@/lib/db';
import es from '@/i18n/locales/es';
import en from '@/i18n/locales/en';
import { isTranslatedErrorCode, translateApiError } from '@/i18n/errors';
import { proxy } from '@/proxy';
import { POST as registerPOST } from '@/app/api/auth/register/route';
import { POST as resendPOST } from '@/app/api/auth/resend-verification/route';

// The identity delivery layer is the only external dependency of both routes; the
// rate-limit bookkeeping under test stays real.
vi.mock('@/lib/identity/runtime', () => ({
  createIdentityService: () => ({
    requestRegistrationCode: async () => ({ delivered: true }),
    resendVerification: async () => undefined,
  }),
}));

const RATE_LIMIT_MESSAGE = 'Demasiados intentos de registro. Intente nuevamente más tarde.';
const SETUP_TOKEN = 'wave5-s8-setup-token';

// ─── helpers ─────────────────────────────────────────────────────────

function jsonRequest(
  url: string,
  body: unknown,
  opts: { ip?: string; token?: string; cookie?: string } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  if (opts.token) headers['x-bootstrap-token'] = opts.token;
  if (opts.cookie) headers['cookie'] = opts.cookie;
  return new NextRequest(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function register(
  ip: string,
  email: string,
  opts: { token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = jsonRequest(
    'http://localhost/api/auth/register',
    {
      email,
      password: 'Sup3rSecret!',
      firstName: 'Wave',
      lastName: 'Eight',
      companyName: 'Wave5 S8',
    },
    { ip, token: opts.token },
  );
  const res = await registerPOST(request, { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json() };
}

async function resend(
  ip: string,
  email: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = jsonRequest('http://localhost/api/auth/resend-verification', { email }, { ip });
  const res = await resendPOST(request, { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json() };
}

async function dropRateLimitRows() {
  await db.rateLimit.deleteMany({ where: { key: { startsWith: 'ip:203.0.113.' } } }).catch(() => {});
  await db.rateLimit.deleteMany({ where: { key: { startsWith: 'email:wave5-s8' } } }).catch(() => {});
  await db.systemConfig
    .deleteMany({ where: { key: { startsWith: 'auth:first-admin-bootstrap:wave5-s8' } } })
    .catch(() => {});
}

/** The `script-src` directive of a served CSP header. */
function scriptSrcOf(csp: string | null): string {
  const directive = (csp ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src'));
  if (!directive) throw new Error(`no script-src directive in: ${csp}`);
  return directive;
}

function pageRequest(pathname: string, opts: { origin?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = { host: 'localhost:3000' };
  if (opts.origin) headers.origin = opts.origin;
  if (opts.cookie) headers.cookie = opts.cookie;
  return new NextRequest(`http://localhost:3000${pathname}`, { method: 'GET', headers });
}

// ─── (1) IP-reset residual: register + resend ────────────────────────

describe('S8 (1) — a successful register never clears the IP failure bucket', () => {
  const IP = '203.0.113.41';
  const EMAIL = 'wave5-s8-register@example.com';

  beforeEach(async () => {
    process.env.CLIENT_IP_SOURCE = 'trusted-x-forwarded-for';
    process.env.BOOTSTRAP_SETUP_TOKEN = SETUP_TOKEN;
    authRateLimiter.clear();
    await dropRateLimitRows();
  });

  afterEach(async () => {
    delete process.env.CLIENT_IP_SOURCE;
    delete process.env.BOOTSTRAP_SETUP_TOKEN;
    authRateLimiter.clear();
    await dropRateLimitRows();
  });

  it('keeps the IP counter: after a successful registration the IP budget is still exhaustible', async () => {
    // A registration attempt that fails authorization increments both buckets.
    for (let i = 0; i < 4; i++) {
      expect((await register(IP, EMAIL)).status, `attempt ${i + 1}`).toBe(403);
    }

    // The attacker then completes ONE legitimate registration from the same IP.
    const success = await register(IP, EMAIL, { token: SETUP_TOKEN });
    expect(success.status).toBe(200);
    expect(success.body).toEqual({
      requiresVerification: true,
      deliveryFailed: false,
      email: EMAIL,
    });

    // The 5th failure still fits the IP budget (limit is 5)...
    expect((await register(IP, EMAIL)).status).toBe(403);

    // ...and the 6th is rejected for the IP bucket, which a success must NOT have reset.
    const blocked = await register(IP, EMAIL, { token: SETUP_TOKEN });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      error: RATE_LIMIT_MESSAGE,
      code: 'RATE_LIMIT_EXCEEDED',
    });
  });

  it('PRESERVE: a successful registration still clears the per-email bucket', async () => {
    // 9 failures on the email budget (10/hour) from IPs that never repeat, so no
    // IP bucket is touched twice; the last slot is still usable.
    for (let i = 0; i < 9; i++) {
      expect((await register(`198.51.100.${i + 1}`, EMAIL)).status).toBe(403);
    }

    expect((await register('198.51.100.50', EMAIL, { token: SETUP_TOKEN })).status).toBe(200);

    // Two further failures stay under the email limit only if it was cleared:
    // a bucket that had merely been decremented would answer 429 on the second.
    expect((await register('198.51.100.51', EMAIL)).status).toBe(403);
    expect((await register('198.51.100.52', EMAIL)).status).toBe(403);
  });
});

describe('S8 (1) — a successful resend-verification never clears the IP failure bucket', () => {
  const IP = '203.0.113.62';
  const EMAIL = 'wave5-s8-resend@example.com';
  const OTHER = 'wave5-s8-resend-other@example.com';

  beforeEach(async () => {
    process.env.CLIENT_IP_SOURCE = 'trusted-x-forwarded-for';
    process.env.BOOTSTRAP_SETUP_TOKEN = SETUP_TOKEN;
    authRateLimiter.clear();
    await dropRateLimitRows();
  });

  afterEach(async () => {
    delete process.env.CLIENT_IP_SOURCE;
    delete process.env.BOOTSTRAP_SETUP_TOKEN;
    authRateLimiter.clear();
    await dropRateLimitRows();
  });

  it('keeps the IP counter built by earlier failures from the same IP', async () => {
    // Five failing registration attempts from this IP exhaust the shared IP bucket.
    for (let i = 0; i < 5; i++) {
      expect((await register(IP, OTHER)).status, `attempt ${i + 1}`).toBe(403);
    }

    // A successful resend from the same IP must not hand the bucket back.
    const ok = await resend(IP, EMAIL);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      message: 'Si hay una cuenta pendiente con ese email, recibirás el código.',
    });

    // Route-level proof: the IP is still exhausted.
    const blocked = await register(IP, OTHER, { token: SETUP_TOKEN });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('PRESERVE: a successful resend still clears the per-email bucket', async () => {
    for (let i = 0; i < 9; i++) authRateLimiter.increment(null, EMAIL);

    expect((await resend('198.51.100.70', EMAIL)).status).toBe(200);

    // The email bucket is empty again: nine more failures still fit under 10.
    expect(authRateLimiter.check(null, EMAIL).success).toBe(true);
  });
});

// ─── (2) CSP: no 'unsafe-eval' in production ─────────────────────────

describe('S8 (2) — CSP drops unsafe-eval outside development', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('production script-src keeps self + unsafe-inline and never unsafe-eval', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const res = await proxy(pageRequest('/dashboard'));
    const csp = res.headers.get('Content-Security-Policy');

    const scriptSrc = scriptSrcOf(csp);
    expect(scriptSrc).toContain("'self'");
    // Next.js injects inline bootstrap scripts and no nonce infrastructure exists.
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");

    // The rest of the policy must stay intact (it is what keeps the app framed-off
    // and same-origin only).
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('PRESERVE: development keeps unsafe-eval (webpack eval + React Refresh need it)', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    const res = await proxy(pageRequest('/dashboard'));
    const scriptSrc = scriptSrcOf(res.headers.get('Content-Security-Policy'));

    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'self'");
  });
});

// ─── (3) CORS: never the literal wildcard ────────────────────────────

describe('S8 (3) — CORS never answers the literal wildcard origin', () => {
  const API = '/api/journal';
  const COOKIE = 'session=abc123';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ALLOWED_ORIGINS=* echoes the request origin instead of "*"', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', '*');

    const res = await proxy(pageRequest(API, { origin: 'https://evil.example', cookie: COOKIE }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://evil.example');
    expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
    // A wildcard configuration never becomes a credentialed cross-site channel.
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('an explicitly allowed origin is echoed with credentials', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://app.example.com, https://admin.example.com');

    const res = await proxy(
      pageRequest(API, { origin: 'https://admin.example.com', cookie: COOKIE }),
    );

    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.example.com');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('an unlisted origin gets no CORS header at all', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://app.example.com');

    const res = await proxy(
      pageRequest(API, { origin: 'https://not-allowed.example', cookie: COOKIE }),
    );

    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });

  it('PRESERVE: same-origin requests (no Origin header) carry no CORS headers and still pass', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', '*');

    const res = await proxy(pageRequest(API, { cookie: COOKIE }));

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    // The security headers are still applied to the same-origin response.
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('PRESERVE: an OPTIONS preflight for an allowed origin still answers 204 with CORS headers', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://app.example.com');

    const request = new NextRequest('http://localhost:3000/api/journal', {
      method: 'OPTIONS',
      headers: {
        host: 'localhost:3000',
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
      },
    });
    const res = await proxy(request);

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});

// ─── (4) Prisma connection errors → 503 ──────────────────────────────

describe('S8 (4) — Prisma connection failures are 503 DATABASE_UNAVAILABLE', () => {
  // An anonymous route keeps this a pure test of the error mapper: no session,
  // no tenant, no rate-limit bucket (getClientIp is null without CLIENT_IP_SOURCE).
  const routeThrowing = (error: unknown) =>
    apiHandler(
      async () => {
        throw error;
      },
      { allowAnonymous: true, requireMembership: false },
    );

  const call = async (error: unknown) => {
    const handler = routeThrowing(error);
    const res = await handler(new NextRequest('http://localhost/api/test'), {
      params: Promise.resolve({}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('P1001 (cannot reach the database server) is a retryable 503', async () => {
    const res = await call({
      code: 'P1001',
      clientVersion: '5.19.1',
      message: "Can't reach database server at `127.0.0.1:5432`",
    });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('DATABASE_UNAVAILABLE');
    expect(res.body.retryable).toBe(true);
    expect(res.body.error).toBe(
      'La base de datos no está disponible en este momento. Intentá nuevamente en unos segundos.',
    );
  });

  it('P1008 (operation timed out) and P1010 (access denied) are also 503', async () => {
    for (const code of ['P1008', 'P1010']) {
      const res = await call({ code, clientVersion: '5.19.1', message: 'connection failure' });
      expect(res.status, code).toBe(503);
      expect(res.body.code, code).toBe('DATABASE_UNAVAILABLE');
    }
  });

  it('PRESERVE: a constraint violation (P2002) stays 400 DATABASE_ERROR with the pinned message', async () => {
    const res = await call({
      code: 'P2002',
      clientVersion: '5.19.1',
      meta: { target: ['email'] },
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Error de restricción o de base de datos.',
      code: 'DATABASE_ERROR',
    });
  });

  it('a 503 body translates in both locales through the shared error catalog', () => {
    const body = {
      error: 'La base de datos no está disponible en este momento. Intentá nuevamente en unos segundos.',
      code: 'DATABASE_UNAVAILABLE',
    };

    expect(isTranslatedErrorCode('DATABASE_UNAVAILABLE')).toBe(true);
    expect(translateApiError(body, (key) => key)).toBe('errors.DATABASE_UNAVAILABLE');
    expect((es.errors as Record<string, string>).DATABASE_UNAVAILABLE.trim().length).toBeGreaterThan(0);
    expect((en.errors as Record<string, string>).DATABASE_UNAVAILABLE.trim().length).toBeGreaterThan(0);
    expect((en.errors as Record<string, string>).DATABASE_UNAVAILABLE).not.toBe(
      (es.errors as Record<string, string>).DATABASE_UNAVAILABLE,
    );
  });
});
