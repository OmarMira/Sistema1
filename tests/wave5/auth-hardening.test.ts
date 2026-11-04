/**
 * S4 (Wave 5) — auth hardening bundle.
 *
 * Contract pinned here:
 *  (1) a SUCCESSFUL login clears only the per-email failure bucket; the IP
 *      bucket survives, so one valid account on an IP cannot launder a
 *      password spray coming from that same IP;
 *  (2) the per-email bucket is still cleared on success (a user who mistyped
 *      nine times is not locked out by their own correct password);
 *  (3) the password minimum is 8 characters for the admin invite/create flow,
 *      with the same Spanish message style used by every other password rule;
 *  (4) an unknown/inactive email still pays one bcrypt comparison against a
 *      precomputed hash, so login timing does not enumerate accounts — the
 *      error text, status and code stay byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { authRateLimiter } from '@/lib/rate-limiter';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { AuthService } from '@/lib/services/auth.service';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { createAdminUserSchema, createUserSchema } from '@/lib/validations/admin';
import { clearDatabase } from '../helpers/factories';

// Spy on the exact bcrypt comparison entry point: `AuthService.login` and the
// dummy-compare path both go through `verifyPassword`.
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const CORRECT = 'CorrectPass1!';
const WRONG = 'WrongPass1!';
const RATE_LIMIT_MESSAGE = 'Demasiados intentos de inicio de sesión. Intente nuevamente más tarde.';

async function createVerifiedUser(email: string, password: string = CORRECT) {
  return db.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      firstName: 'Wave',
      lastName: 'Five',
      platformRole: 'user',
      emailVerifiedAt: new Date(),
      legacyUser: false,
    },
    select: { id: true, email: true, passwordHash: true },
  });
}

async function login(ip: string | null, email: string, password: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ip !== null) headers['x-forwarded-for'] = ip;
  const request = new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
  });
  const res = await loginPOST(request, { params: Promise.resolve({}) });
  return { status: res.status, body: await res.json() };
}

async function dropRateLimitRows() {
  await db.rateLimit.deleteMany({ where: { key: { startsWith: 'ip:203.0.113.' } } }).catch(() => {});
  await db.rateLimit.deleteMany({ where: { key: { startsWith: 'ip:198.51.100.' } } }).catch(() => {});
  await db.rateLimit.deleteMany({ where: { key: { startsWith: 'email:wave5-s4' } } }).catch(() => {});
}

describe('S4 (1) — a successful login never clears the IP failure bucket', () => {
  const IP = '203.0.113.9';
  const EMAIL = 'wave5-s4-ip-bucket@example.com';

  beforeEach(async () => {
    process.env.CLIENT_IP_SOURCE = 'trusted-x-forwarded-for';
    authRateLimiter.clear();
    vi.mocked(verifyPassword).mockClear();
    await dropRateLimitRows();
    await clearDatabase();
  });

  afterEach(async () => {
    delete process.env.CLIENT_IP_SOURCE;
    authRateLimiter.clear();
    await dropRateLimitRows();
    await clearDatabase();
  });

  it('keeps the IP counter: after a successful login the next failures still exhaust the IP budget', async () => {
    await createVerifiedUser(EMAIL);

    // 4 failed attempts from the same IP for a VALID email (IP limit is 5).
    const failures: number[] = [];
    for (let i = 0; i < 4; i++) failures.push((await login(IP, EMAIL, WRONG)).status);
    expect(failures).toEqual([401, 401, 401, 401]);

    // The attacker proves the account is valid: successful login, same IP.
    expect((await login(IP, EMAIL, CORRECT)).status).toBe(200);

    // 5th failure still fits the IP budget...
    expect((await login(IP, EMAIL, WRONG)).status).toBe(401);

    // ...and the 6th is rejected for the IP bucket, which a success must NOT have reset.
    const blocked = await login(IP, EMAIL, CORRECT);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: RATE_LIMIT_MESSAGE, code: 'RATE_LIMIT_EXCEEDED' });
  });

  // PRESERVE: the endpoint contract that tests/identity/registration-atomic
  // .integration.test.ts pins ({error, code}) is unchanged by the rate-limit fix.
  it('PRESERVE: a failed login still answers 401 with the unchanged {error, code} body', async () => {
    await createVerifiedUser(EMAIL);

    const failed = await login(IP, EMAIL, WRONG);
    expect(failed.status).toBe(401);
    expect(failed.body).toEqual({
      error: 'Correo electrónico o contraseña inválidos',
      code: 'UNAUTHORIZED',
    });
  });

  it('PRESERVE: a successful login still clears the per-email bucket', async () => {
    await createVerifiedUser(EMAIL);

    // 9 failures from 9 distinct IPs: the email budget (10/hour) is one away
    // from exhaustion and no IP bucket is touched twice.
    for (let i = 0; i < 9; i++) {
      expect((await login(`198.51.100.${i + 1}`, EMAIL, WRONG)).status).toBe(401);
    }

    // A correct password from a fresh IP still gets in and must reset the email counter.
    expect((await login('198.51.100.99', EMAIL, CORRECT)).status).toBe(200);

    // Two more wrong passwords stay under the email limit only if it was cleared
    // (if it had merely been decremented, the second one would answer 429).
    expect((await login('198.51.100.100', EMAIL, WRONG)).status).toBe(401);
    expect((await login('198.51.100.101', EMAIL, WRONG)).status).toBe(401);
  });
});

describe('S4 (2) — password minimum is 8 characters in the admin invite flow', () => {
  const invite = (password: string) => ({
    email: 'nueva.persona@example.com',
    firstName: 'Ana',
    lastName: 'Pérez',
    password,
    role: 'employee' as const,
  });

  it('rejects a 7-character invite password with the Spanish 8-character message', () => {
    const rejected = createUserSchema.safeParse(invite('Abc1234'));
    if (rejected.success) throw new Error('a 7-character password must not be accepted');
    expect(rejected.error.issues.map((issue) => issue.message)).toContain(
      'La contraseña debe tener al menos 8 caracteres',
    );
  });

  it('PRESERVE: an 8-character password is accepted, and the admin variant shares the rule', () => {
    expect(createUserSchema.safeParse(invite('Abcd1234')).success).toBe(true);

    const adminOk = createAdminUserSchema.safeParse({ ...invite('Abcd1234'), role: 'user' });
    expect(adminOk.success).toBe(true);

    const adminRejected = createAdminUserSchema.safeParse({ ...invite('Abc1234'), role: 'user' });
    expect(adminRejected.success).toBe(false);
  });
});

describe('S4 (3) — unknown-user login pays a dummy bcrypt comparison', () => {
  beforeEach(async () => {
    vi.mocked(verifyPassword).mockClear();
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('compares the attempted password against a precomputed hash for an unknown email', async () => {
    await expect(
      AuthService.login({ email: 'wave5-s4-ghost@example.com', password: WRONG }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
      message: 'Correo electrónico o contraseña inválidos',
    });

    const compare = vi.mocked(verifyPassword);
    expect(compare).toHaveBeenCalledTimes(1);
    const [attempted, hash] = compare.mock.calls[0]!;
    expect(attempted).toBe(WRONG);
    // A real bcrypt digest (cost 12), never the stored user hash (there is none).
    expect(hash).toMatch(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
  });

  it('PRESERVE: a wrong password for a known user compares exactly once against the stored hash', async () => {
    const user = await createVerifiedUser('wave5-s4-known@example.com');

    await expect(
      AuthService.login({ email: 'wave5-s4-known@example.com', password: WRONG }),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
      message: 'Correo electrónico o contraseña inválidos',
    });

    const compare = vi.mocked(verifyPassword);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0]![1]).toBe(user.passwordHash);
  });
});
