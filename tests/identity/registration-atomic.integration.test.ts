import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';
import { IdentityService } from '../../src/lib/identity/service';
import { PostgresIdentityRepository } from '../../src/lib/identity/repository';
import { IdentityMailer } from '../../src/lib/identity/mail';
import { POLICY } from '../../src/lib/identity/contracts';
import { AuthService } from '../../src/lib/services/auth.service';
import { POST as register } from '../../src/app/api/auth/register/route';
import { POST as verify } from '../../src/app/api/auth/verify/route';
import { POST as resend } from '../../src/app/api/auth/resend-verification/route';
import { POST as login } from '../../src/app/api/auth/login/route';

// Reject the operative destination BEFORE importing/constructing any DB singleton.
const state = vi.hoisted(() => {
  const url = new URL(process.env.DATABASE_URL || 'http://invalid');
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || url.port !== '59521' || url.pathname !== '/registration_test') {
    throw new Error('Only authorized registration_test@127.0.0.1:59521 is allowed');
  }
  return { url: url.toString(), db: undefined as unknown as PrismaClient, identity: undefined as unknown as IdentityService,
    messages: [] as Array<{ to: string; code: string }>, mailFails: false, seedFails: false, now: new Date(), sessions: vi.fn() };
});
vi.mock('@/lib/db', () => ({ get db() { return state.db; } }));
vi.mock('@/lib/identity/runtime', () => ({ createIdentityService: () => state.identity }));
// Exercise the exported HTTP handlers and real services/repository, not unrelated guards.
vi.mock('@/lib/api-handler', () => ({ apiHandler: (handler: (request: NextRequest) => Promise<Response>) => async (request: NextRequest) => {
  try { return await handler(request); } catch (error) {
    const failure = error as { statusCode?: number; message?: string; code?: string; details?: unknown };
    return NextResponse.json({ error: failure.statusCode ? failure.message : 'Error interno del servidor', code: failure.code || 'INTERNAL_ERROR', details: failure.details }, { status: failure.statusCode || 500 });
  }
} }));
vi.mock('@/lib/rate-limiter', () => ({ authRateLimiter: { check: () => ({ success: true }), reset: vi.fn(), increment: vi.fn() } }));
vi.mock('@/lib/security/client-ip', () => ({ getClientIp: () => null }));
vi.mock('@/lib/sessions', () => ({ createSession: (...args: unknown[]) => state.sessions(...args) }));
vi.mock('@/lib/chart-of-accounts', async (original) => {
  const actual = await original<typeof import('../../src/lib/chart-of-accounts')>();
  return { ...actual, seedChartOfAccounts: async (...args: Parameters<typeof actual.seedChartOfAccounts>) => {
    if (state.seedFails) throw new Error('injected storage failure: private-provider-details');
    return actual.seedChartOfAccounts(...args);
  } };
});
const profile = (email = 'first@example.invalid') => ({ email, password: 'original-password-123', firstName: 'Original', lastName: 'Owner', companyName: 'Original Company', entityType: 'BUSINESS' as const, taxId: null });
const call = (handler: typeof register, path: string, body: object) => handler(new NextRequest(`http://localhost/api/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({}) });
const counts = async () => ({ users: await state.db.user.count(), companies: await state.db.company.count(), members: await state.db.companyMember.count() });
const lastCode = (email: string) => state.messages.filter(message => message.to === email).at(-1)!.code;
const finish = (email: string, code: string, fields: object = profile(email)) => call(verify, 'verify', { ...fields, email, code });

beforeAll(async () => {
  state.db = new PrismaClient({ datasourceUrl: state.url });
  const [destination] = await state.db.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
  expect(destination.database).toBe('registration_test');
  state.identity = new IdentityService({ enabled: true, key: Buffer.alloc(32, 7) }, new PostgresIdentityRepository(state.db), new IdentityMailer({ send: async message => {
    if (state.mailFails) throw new Error('private SMTP credential details');
    if (message.type === 'verification') state.messages.push({ to: message.to, code: message.code });
  } }), () => state.now);
});
beforeEach(async () => {
  await state.db.$executeRawUnsafe('TRUNCATE "IdentitySecurityEvent", "IdentityRateLimit", "IdentityChallenge", "IdentityPendingRegistration", "User", "Company" CASCADE');
  state.messages.length = 0; state.mailFails = false; state.seedFails = false; state.now = new Date();
  state.sessions.mockReset().mockImplementation(async (id: string) => {
    // A separate connection must already observe the complete committed account.
    const user = await state.db.user.findUniqueOrThrow({ where: { id } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await state.db.companyMember.count({ where: { userId: id } })).toBe(1);
    return 'isolated-test-session';
  });
});
afterAll(async () => { await state.db?.$disconnect(); });

describe('confirmed registration through public HTTP handlers and real PostgreSQL', () => {
  it('keeps definitive entities absent until confirmation, including a real transport rejection', async () => {
    state.mailFails = true;
    const response = await call(register, 'register', profile());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requiresVerification: true, deliveryFailed: true });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await counts()).toEqual({ users: 0, companies: 0, members: 0 });
    expect(state.sessions).not.toHaveBeenCalled();
  });
  it('creates a verified account and its company once, and cannot replay a consumed code', async () => {
    const data = profile();
    expect((await call(register, 'register', data)).status).toBe(200);
    expect(await counts()).toEqual({ users: 0, companies: 0, members: 0 });
    const code = lastCode(data.email);
    const response = await finish(data.email, code);
    expect(response.status).toBe(200);
    expect((await response.json()).user.role).toBe('super_admin');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(await counts()).toEqual({ users: 1, companies: 1, members: 1 });
    expect((await AuthService.login(data)).user.email).toBe(data.email);
    expect((await finish(data.email, code)).status).toBe(400);
    expect(await counts()).toEqual({ users: 1, companies: 1, members: 1 });
    expect(state.sessions).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong, expired and exhausted codes without creating accounts or sessions', async () => {
    const data = profile(); await call(register, 'register', data);
    const code = lastCode(data.email);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < POLICY.attempts; i++) {
      const response = await finish(data.email, wrong);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('INVALID_CODE');
    }
    expect((await finish(data.email, code)).status).toBe(400);
    await call(resend, 'resend-verification', { email: data.email });
    state.now = new Date(state.now.getTime() + POLICY.codeMs);
    expect((await finish(data.email, lastCode(data.email))).status).toBe(400);
    expect(await counts()).toEqual({ users: 0, companies: 0, members: 0 });
    expect(state.sessions).not.toHaveBeenCalled();
  });
  it('rolls back account creation AND code consumption when storage fails midway', async () => {
    const data = profile(); await call(register, 'register', data); const code = lastCode(data.email);
    state.seedFails = true;
    const failed = await finish(data.email, code);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('private-provider-details');
    expect(await counts()).toEqual({ users: 0, companies: 0, members: 0 });
    expect(state.sessions).not.toHaveBeenCalled();
    state.seedFails = false;
    expect((await finish(data.email, code)).status).toBe(200);
    expect(await counts()).toEqual({ users: 1, companies: 1, members: 1 });
  });
  it('serializes simultaneous confirmations: one first administrator and no same-code duplicates', async () => {
    const first = profile('first@example.invalid'), second = profile('second@example.invalid');
    await call(register, 'register', first); await call(register, 'register', second);
    const results = await Promise.all([finish(first.email, lastCode(first.email)), finish(first.email, lastCode(first.email)), finish(second.email, lastCode(second.email))]);
    expect(results.map(response => response.status).sort()).toEqual([200, 200, 400]);
    const roles = await Promise.all(results.filter(response => response.status === 200).map(async response => (await response.json()).user.role));
    expect(roles.sort()).toEqual(['super_admin', 'user']);
    expect(await counts()).toEqual({ users: 2, companies: 2, members: 2 });
    expect(state.sessions).toHaveBeenCalledTimes(2);
  });
  it('recovers an expired consumed request without replacing the prior account or company data', async () => {
    const data = profile(); const original = await AuthService.register(data);
    await state.identity.beginRegistration(data.email);
    expect(await state.identity.verifyCode(data.email, lastCode(data.email))).toBe(true);
    state.now = new Date(state.now.getTime() + POLICY.pendingMs + 1);
    expect((await call(resend, 'resend-verification', { email: data.email })).status).toBe(200);
    const response = await finish(data.email, lastCode(data.email), {});
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.user).toMatchObject({ id: original.user.id, firstName: 'Original' });
    expect(result.companies[0]).toMatchObject({ id: original.company.id, legalName: data.companyName });
    expect((await AuthService.login(data)).user.id).toBe(original.user.id);
    expect(await counts()).toEqual({ users: 1, companies: 1, members: 1 });
  });
  it('preserves prior password and business data even if a different profile is supplied on confirmation', async () => {
    const data = profile(); const original = await AuthService.register(data);
    await call(register, 'register', data);
    const response = await finish(data.email, lastCode(data.email), { ...data, password: 'replacement-attempt-123', firstName: 'Changed', companyName: 'Changed' });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.user).toMatchObject({ id: original.user.id, firstName: 'Original' });
    expect(result.companies[0].legalName).toBe(data.companyName);
    expect((await AuthService.login(data)).user.id).toBe(original.user.id);
    await expect(AuthService.login({ email: data.email, password: 'replacement-attempt-123' })).rejects.toThrow('Correo electrónico o contraseña inválidos');
  });
  it('rejects profile tampering and verified/inactive-account issuance without authentication bypass', async () => {
    const data = profile(); await call(register, 'register', data);
    const code = lastCode(data.email);
    expect((await finish(data.email, code, { ...data, entityType: 'ADMIN' })).status).toBe(400);
    expect(await counts()).toEqual({ users: 0, companies: 0, members: 0 });
    expect((await finish(data.email, code)).status).toBe(200);
    const messages = state.messages.length;
    await call(resend, 'resend-verification', { email: data.email });
    expect(state.messages).toHaveLength(messages);
    const inactive = await AuthService.register(profile('inactive@example.invalid'));
    await state.db.user.update({ where: { id: inactive.user.id }, data: { isActive: false } });
    await call(register, 'register', profile('inactive@example.invalid'));
    expect(state.messages).toHaveLength(messages);
    expect(state.sessions).toHaveBeenCalledTimes(1);
  });
});

it('reveals the pending verification path only after the correct password, preserves the account and creates no session', async () => {
  const data = profile('pending-login@example.invalid');
  const original = await AuthService.register(data);
  const before = await state.db.user.findUniqueOrThrow({ where: { id: original.user.id } });
  const oldCounts = await counts();
  await expect(AuthService.login(data)).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
  const wrong = await call(login, 'login', { email: data.email, password: 'wrong-password' });
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toEqual({ error: 'Correo electrónico o contraseña inválidos', code: 'UNAUTHORIZED' });
  const pending = await call(login, 'login', data);
  expect(pending.status).toBe(403);
  expect(await pending.json()).toEqual({
    error: 'Confirma tu correo electrónico para continuar.',
    code: 'EMAIL_VERIFICATION_REQUIRED', details: { email: data.email },
  });
  expect(pending.headers.get('set-cookie')).toBeNull();
  expect(state.sessions).not.toHaveBeenCalled();
  expect(await counts()).toEqual(oldCounts);
  expect(await state.db.user.findUniqueOrThrow({ where: { id: original.user.id } })).toEqual(before);
  expect(state.messages).toHaveLength(0);
  await call(resend, 'resend-verification', { email: data.email });
  const confirmed = await call(verify, 'verify', { email: data.email, code: lastCode(data.email) });
  expect(confirmed.status).toBe(200);
  expect((await confirmed.json()).user.id).toBe(original.user.id);
  expect(await counts()).toEqual(oldCounts);
  const after = await state.db.user.findUniqueOrThrow({ where: { id: original.user.id } });
  expect(after.passwordHash).toBe(before.passwordHash);
  expect(after.emailVerifiedAt).not.toBeNull();
  expect((await call(login, 'login', data)).status).toBe(200);
});
