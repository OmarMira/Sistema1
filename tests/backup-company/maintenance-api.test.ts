import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { createMaintenanceGate } from '../../src/lib/backup-maintenance.mjs';
const mocks = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), access: vi.fn(), rate: vi.fn(), acquire: vi.fn() }));
vi.mock('../../src/lib/backup-maintenance.ts', () => ({ acquireNormalOperation: mocks.acquire }));
vi.mock('../../src/lib/sessions', () => ({ getSessionUserId: mocks.session }));
vi.mock('../../src/lib/db', () => ({ db: { user: { findUnique: mocks.user } } }));
vi.mock('../../src/lib/rbac', () => ({ requireActiveTenantAccess: mocks.access }));
vi.mock('../../src/lib/security/rate-limiter', () => ({ checkRateLimit: mocks.rate }));
vi.mock('../../src/lib/security/client-ip', () => ({ getClientIp: () => null }));
vi.mock('../../src/lib/logger', () => ({ logger: { error: vi.fn() } }));
import { apiHandler } from '../../src/lib/api-handler';
let root: string, gate: ReturnType<typeof createMaintenanceGate>;
const context = { params: Promise.resolve({}) };
const request = () => new NextRequest('http://owned.test/api/test?companyId=c', { headers: { 'x-maintenance-bypass': 'true' } });
beforeEach(() => {
  vi.clearAllMocks();
  const scratch = path.resolve('tests/backup-company/.scratch');
  fs.mkdirSync(scratch, { recursive: true });
  root = fs.mkdtempSync(path.join(scratch, 'company-maintenance-api-'));
  gate = createMaintenanceGate(path.join(root, 'gate'));
  mocks.acquire.mockImplementation(() => gate.acquireNormalOperation());
  mocks.session.mockResolvedValue('user');
  mocks.user.mockResolvedValue({ platformRole: 'user' });
  mocks.rate.mockReturnValue({ allowed: true, limit: 10, remaining: 9, resetAt: 123 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function security(response: NextResponse) {
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
}
it('marked requests reject 503 before sessions, auth, DB, rate counters or handler, including anonymous', async () => {
  const owner = gate.beginMaintenance();
  const handler = vi.fn(() => NextResponse.json({ ok: true }));
  for (const options of [{}, { allowAnonymous: true, requireMembership: false }, { requireSuperAdmin: true }]) {
    const response = await apiHandler(handler, options)(request(), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Maintenance admission unavailable', code: 'BACKUP_MAINTENANCE' });
    security(response);
  }
  for (const fn of [mocks.session, mocks.user, mocks.access, mocks.rate, handler]) expect(fn).not.toHaveBeenCalled();
  expect(gate.status()).toEqual({ marked: true, leases: 0 });
  await owner.drain({ timeoutMs: 0 }); owner.release();
});
it('holds admission before auth through the handler and prevents recovery until response completion', async () => {
  let owner: ReturnType<typeof gate.beginMaintenance> | undefined;
  mocks.session.mockImplementation(async () => {
    expect(gate.status().leases).toBe(1);
    owner = gate.beginMaintenance();
    return 'user';
  });
  const response = await apiHandler(async () => {
    await expect(owner!.runRecovery(async () => true)).rejects.toThrow('not drained');
    await gate.withNormalOperation(async () => expect(gate.status().leases).toBe(1));
    return NextResponse.json({ ok: true }, { status: 201 });
  })(request(), context);
  expect(response.status).toBe(201); expect(await response.json()).toEqual({ ok: true }); security(response);
  expect(gate.status()).toEqual({ marked: true, leases: 0 });
  await owner!.drain({ timeoutMs: 0 }); owner!.release();
});
it('does not inherit a recovery or normal-operation API bypass', async () => {
  const owner = gate.beginMaintenance();
  await owner.drain({ timeoutMs: 0 });
  await owner.runRecovery(async () => {
    const response = await apiHandler(() => NextResponse.json({ unsafe: true }), { allowAnonymous: true })(request(), context);
    expect(response.status).toBe(503);
    security(response);
    expect(mocks.session).not.toHaveBeenCalled();
  });
  owner.release();
});
it.each(['success', 'unauthorized', 'forbidden', 'rate', 'error'])('preserves unmarked %s responses and releases the lease', async mode => {
  if (mode === 'unauthorized') mocks.session.mockResolvedValue(null);
  if (mode === 'rate') mocks.rate.mockReturnValue({ allowed: false, limit: 10, remaining: 0, resetAt: 123 });
  const response = await apiHandler(() => {
    if (mode === 'error') throw new Error('owned error');
    return NextResponse.json({ ok: true }, { status: 202 });
  }, { requireSuperAdmin: mode === 'forbidden' })(request(), context);
  expect(response.status).toBe(({ success: 202, unauthorized: 401, forbidden: 403, rate: 429, error: 500 })[mode]);
  expect(await response.json()).toEqual(({
    success: { ok: true }, unauthorized: { error: 'Unauthorized', code: 'UNAUTHORIZED' },
    forbidden: { error: 'Forbidden', code: 'FORBIDDEN' },
    rate: { error: '429 Too Many Requests', retryAfter: 123 },
    error: { error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' },
  })[mode]);
  if (mode !== 'rate') security(response); // Existing early rate response deliberately unchanged.
  expect(gate.status()).toEqual({ marked: false, leases: 0 });
});
