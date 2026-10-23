import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { IdentityService } from '../../src/lib/identity/service';
import { PostgresIdentityRepository } from '../../src/lib/identity/repository';
import { IdentityMailer } from '../../src/lib/identity/mail';
import * as identityCrypto from '../../src/lib/identity/crypto';

// Fail BEFORE the application singleton or Prisma construction. The launcher
// supplies a newly owned, disposable loopback database, never ambient .env.
const state = vi.hoisted(() => {
  const url = new URL(process.env.DATABASE_URL || 'http://invalid');
  const port = process.env.CLEAN_IDENTITY_TEST_PORT;
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' || !port || url.port !== port || port === '5432' || url.pathname !== '/clean_identity_test' || url.username !== 'clean_identity_test' || process.env.CLEAN_IDENTITY_TEST_OWNED !== '01a1602d') {
    throw new Error('Only the explicitly owned disposable clean_identity_test database is allowed');
  }
  return { url: url.toString(), db: undefined as unknown as PrismaClient, identity: undefined as unknown as IdentityService,
    cookie: undefined as string | undefined, code: 100000, messages: [] as Array<{ type: string; to: string; code?: string; token?: string }> };
});
vi.mock('@/lib/db', () => ({ get db() { return state.db; } }));
vi.mock('@/lib/identity/runtime', () => ({ createIdentityService: () => state.identity }));
vi.mock('@/lib/security/rate-limiter', () => ({ checkRateLimit: () => ({ allowed: true, limit: 100, remaining: 99, resetAt: new Date(0) }) }));
vi.mock('@/lib/rate-limiter', () => ({ authRateLimiter: { check: () => ({ success: true }), reset: vi.fn(), increment: vi.fn() } }));
vi.mock('@/lib/security/client-ip', () => ({ getClientIp: () => null }));
vi.mock('@/lib/uploads/logo-service', () => ({ saveLogo: vi.fn(), deleteLogo: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
import { POST as register } from '../../src/app/api/auth/register/route';
import { POST as verify } from '../../src/app/api/auth/verify/route';
import { POST as resend } from '../../src/app/api/auth/resend-verification/route';
import { POST as login } from '../../src/app/api/auth/login/route';
import { GET as me } from '../../src/app/api/auth/me/route';
import { DELETE as remove, PATCH as patch } from '../../src/app/api/admin/users/[id]/route';
import { createSession, getSessionCookieName } from '../../src/lib/sessions';
import { hashPassword } from '../../src/lib/auth';

const profile = (email: string, firstName = 'Original', password = 'original-password-123') => ({ email, firstName, lastName: 'Owner', password, companyName: `${firstName} Company`, entityType: 'BUSINESS' as const, taxId: null });
const authHeaders = (): Record<string, string> => state.cookie ? { cookie: `${getSessionCookieName()}=${state.cookie}` } : {};
const call = (handler: typeof register, path: string, body: object) => handler(new NextRequest(`http://localhost/api/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) }), { params: Promise.resolve({}) });
const erase = (id: string) => remove(new NextRequest(`http://localhost/api/admin/users/${id}`, { method: 'DELETE', headers: authHeaders() }), { params: Promise.resolve({ id }) });
const lastCode = (email: string) => state.messages.filter(message => message.to === email && message.type === 'verification').at(-1)!.code!;
const cookieOf = (response: Response) => decodeURIComponent(response.headers.get('set-cookie')!.split(';')[0].slice(getSessionCookieName().length + 1));
async function account(email: string) {
  const data = profile(email);
  expect((await call(register, 'register', data)).status).toBe(200);
  const code = lastCode(email);
  const response = await call(verify, 'verify', { ...data, code });
  expect(response.status).toBe(200);
  const body = await response.json();
  return { id: body.user.id as string, data, code, cookie: cookieOf(response), company: body.companies[0] };
}
beforeAll(async () => {
  state.db = new PrismaClient({ datasourceUrl: state.url });
  const rows = await state.db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  expect(rows[0].name).toBe('clean_identity_test');
  state.identity = new IdentityService({ enabled: true, key: Buffer.alloc(32, 9) }, new PostgresIdentityRepository(state.db), new IdentityMailer({ send: async message => { state.messages.push(message); } }));
  vi.spyOn(identityCrypto, 'createCode').mockImplementation(() => String(++state.code));
});
beforeEach(async () => {
  await state.db.$executeRawUnsafe('TRUNCATE "IdentitySecurityEvent", "IdentityRateLimit", "IdentityChallenge", "IdentityPendingRegistration", "User", "Company" CASCADE');
  state.cookie = undefined; state.messages.length = 0;
});
afterAll(async () => { await state.db?.$disconnect(); vi.restoreAllMocks(); });

it('deletes access and permits a fresh same-email account with new data, never old codes, passwords or sessions', async () => {
  const owner = await account('owner@example.test');
  const old = await account('reuse@example.test');
  await state.identity.requestRecovery(old.data.email);
  const recovery = state.messages.find(message => message.type === 'recovery')!.token!;
  state.cookie = owner.cookie;
  const deleted = await erase(old.id);
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ message: 'User deleted successfully', selfDeleted: false });
  state.cookie = old.cookie;
  expect((await erase(owner.id)).status).toBe(401);
  expect((await call(login, 'login', old.data)).status).toBe(401);
  expect(await state.identity.completeRecovery(recovery, 'unused-test-hash')).toBeNull();
  state.cookie = undefined;
  const data = profile(old.data.email, 'Replacement', 'replacement-password-123');
  const issued = await call(register, 'register', data);
  expect(issued.status).toBe(200);
  expect(await issued.json()).toEqual({ requiresVerification: true, deliveryFailed: false, email: data.email });
  const code = lastCode(data.email);
  expect(code).not.toBe(old.code);
  expect((await call(verify, 'verify', { ...data, code: old.code })).status).toBe(400);
  const fresh = await call(verify, 'verify', { ...data, code });
  expect(fresh.status).toBe(200);
  const body = await fresh.json();
  expect(body.user.id).not.toBe(old.id);
  expect(body.user.firstName).toBe('Replacement');
  expect(body.user.role).toBe('user');
  expect(body.companies[0].legalName).toBe('Replacement Company');
  expect((await call(login, 'login', old.data)).status).toBe(401);
  expect((await call(login, 'login', data)).status).toBe(200);
  expect(await state.identity.completeRecovery(recovery, 'unused-test-hash')).toBeNull();
  const retained = await me(new NextRequest('http://localhost/api/auth/me', { headers: { cookie: `${getSessionCookieName()}=${owner.cookie}` } }), { params: Promise.resolve({}) });
  expect(retained.status).toBe(200);
  expect((await retained.json()).companies).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: owner.company.id }), expect.objectContaining({ id: old.company.id }),
  ]));
});
it.each([false, true])('repairs an already-deleted legacy orphan on register/resend=%s without a 24-hour wait', async useResend => {
  const old = await account('orphan@example.test');
  // Isolated legacy fixture: simulate deletion by the old implementation, which
  // left its confirmed pending request. Assertions use public auth handlers.
  await state.db.user.delete({ where: { id: old.id } });
  state.cookie = undefined;
  const data = profile(old.data.email);
  const response = await call(useResend ? resend : register, useResend ? 'resend-verification' : 'register', useResend ? { email: data.email } : data);
  expect(response.status).toBe(200);
  const code = lastCode(data.email);
  expect(code).not.toBe(old.code);
  expect((await call(verify, 'verify', { ...data, code: old.code })).status).toBe(400);
  const fresh = await call(verify, 'verify', { ...data, code });
  expect(fresh.status).toBe(200);
  const body = await fresh.json();
  expect(body.user.id).not.toBe(old.id);
  expect(body.user.firstName).toBe(data.firstName);
  expect(body.companies[0].legalName).toBe(data.companyName);
});
it('rolls back cleanup and session revocation if deletion cannot commit', async () => {
  const owner = await account('owner@example.test');
  const old = await account('rollback@example.test');
  await state.identity.requestRecovery(old.data.email);
  const token = state.messages.find(message => message.type === 'recovery')!.token!;
  state.cookie = owner.cookie;
  await state.db.$executeRawUnsafe(`CREATE FUNCTION reject_test_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated deletion failure'; END $$`);
  await state.db.$executeRawUnsafe(`CREATE TRIGGER reject_test_delete BEFORE DELETE ON "User" FOR EACH ROW EXECUTE FUNCTION reject_test_delete()`);
  try {
    const response = await erase(old.id);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' });
    state.cookie = old.cookie;
    expect((await erase(owner.id)).status).toBe(403); // Session still valid, role still ordinary.
    expect((await call(login, 'login', old.data)).status).toBe(200);
    const password = 'isolated-restored-password-123';
    expect(await state.identity.completeRecovery(token, await hashPassword(password))).toBe(old.id);
    expect((await erase(owner.id)).status).toBe(401); // Recovery revoked the old session.
    expect((await call(login, 'login', old.data)).status).toBe(401);
    expect((await call(login, 'login', { email: old.data.email, password })).status).toBe(200);
  } finally {
    await state.db.$executeRawUnsafe('DROP TRIGGER reject_test_delete ON "User"');
    await state.db.$executeRawUnsafe('DROP FUNCTION reject_test_delete()');
  }
});
it('serializes deletion ahead of recovery without a deadlock or token revival', async () => {
  const owner = await account('owner@example.test');
  const old = await account('race@example.test');
  await state.identity.requestRecovery(old.data.email);
  const token = state.messages.find(message => message.type === 'recovery')!.token!;
  state.cookie = owner.cookie;
  let unlock!: () => void;
  let ready!: () => void;
  const held = new Promise<void>(resolve => { ready = resolve; });
  const release = new Promise<void>(resolve => { unlock = resolve; });
  const gate = state.db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id=${old.id} FOR UPDATE`;
    ready(); await release;
  }, { timeout: 15_000 });
  await held;
  async function waiters(minimum: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await state.db.$queryRaw<Array<{ n: number }>>`SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted AND l.locktype IN ('transactionid','tuple')`;
      if (rows[0].n >= minimum) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Expected isolated transaction waiters were not observed');
  }
  let deletion!: Promise<Response>;
  let recovery!: Promise<string | null>;
  try {
    deletion = erase(old.id);
    await waiters(1);
    recovery = state.identity.completeRecovery(token, 'unused-test-hash');
    await waiters(2);
  } finally { unlock(); await gate; }
  const [response, restored] = await Promise.all([deletion, recovery]);
  expect(response.status).toBe(200);
  expect(restored).toBeNull();
  expect(await state.identity.completeRecovery(token, 'unused-test-hash')).toBeNull();
});
it('preserves prior public contracts for registration, verification, administration and recovery', async () => {
  const data = profile('compat@example.test');
  await state.db.user.create({ data: { id: 'compat-owner', email: data.email, firstName: data.firstName, lastName: data.lastName, passwordHash: await hashPassword(data.password), platformRole: 'super_admin', emailVerifiedAt: new Date('2026-01-01Z') } });
  await state.db.company.create({ data: { legalName: 'Retained Company', entityType: 'BUSINESS' } });
  state.cookie = await createSession('compat-owner');
  const transcript: unknown[] = [];
  async function record(name: string, response: Response) {
    transcript.push({ name, status: response.status, body: await response.json(), contentType: response.headers.get('content-type'), cookie: response.headers.get('set-cookie') });
  }
  await record('register-existing', await call(register, 'register', data));
  await record('resend-existing', await call(resend, 'resend-verification', { email: data.email }));
  await record('verify-invalid', await call(verify, 'verify', { ...data, code: '000000' }));
  await record('login-wrong', await call(login, 'login', { email: data.email, password: 'wrong-password-123' }));
  await record('delete-last-admin', await erase('compat-owner'));
  await record('patch-profile', await patch(new NextRequest('http://localhost/api/admin/users/compat-owner', { method: 'PATCH', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify({ firstName: 'Renamed' }) }), { params: Promise.resolve({ id: 'compat-owner' }) }));
  transcript.push({ name: 'request-recovery', body: await state.identity.requestRecovery(data.email) });
  const token = state.messages.find(message => message.type === 'recovery')!.token!;
  transcript.push({ name: 'complete-recovery', body: await state.identity.completeRecovery(token, await hashPassword('replacement-password-123')) });
  transcript.push({ name: 'replay-recovery', body: await state.identity.completeRecovery(token, 'unused-hash') });
  expect((transcript.slice(0, 6) as Array<{ status: number }>).map(row => row.status)).toEqual([200, 200, 400, 401, 409, 200]);
  expect(transcript.at(-2)).toEqual({ name: 'complete-recovery', body: 'compat-owner' });
  expect(transcript.at(-1)).toEqual({ name: 'replay-recovery', body: null });
  console.log('PUBLIC_IDENTITY_COMPAT=' + JSON.stringify(transcript));
});
