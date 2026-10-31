import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMaintenanceGate } from '../../src/lib/backup-maintenance.mjs';
import type { MaintenanceGate } from '../../src/lib/backup-maintenance.mjs';

const state = vi.hoisted(() => ({ gate: null as unknown as MaintenanceGate, root: '', effects: [] as string[], pause: null as Promise<void> | null, result: {} as any }));
vi.mock('../../src/lib/config/paths', () => ({
  get RUNTIME_DIR() { return state.root; }, get DATA_ROOT() { return state.root; },
  get RUNTIME_FILES() { return { companyConfig: path.join(state.root, 'company-config.json') }; },
  get LEGACY_FILES() { return { companyConfig: path.join(state.root, 'legacy.json') }; },
  get DEFAULT_TEMPLATES() { return { companyConfig: path.join(state.root, 'default.json') }; },
}));
vi.mock('../../src/lib/backup-runtime-maintenance', () => ({
  acquireNormalOperation: () => state.gate.acquireNormalOperation(),
  withNormalOperation: (fn: any) => state.gate.withNormalOperation(fn),
  withRuntimeOperation: (fn: any) => state.gate.withRuntimeOperation(fn),
  withRuntimeOperationSync: (fn: any) => state.gate.withRuntimeOperationSync(fn),
}));
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), slowQuery: vi.fn() } }));
vi.mock('../../src/lib/metrics', () => ({ trackQueryDuration: vi.fn(), resetMetrics: () => state.effects.push('metrics') }));
vi.mock('../../src/lib/sessions', () => ({ getSessionToken: () => { state.effects.push('token'); return 'owned'; }, destroySession: async () => { state.effects.push('logout'); } }));
vi.mock('../../src/lib/ai-config', () => ({ checkAiConfigIntegrity: async () => ({ code: 'AI_CONFIG_OK' }) }));
vi.mock('../../src/lib/audit', () => ({ createAuditLogWithRetry: async () => {} }));
vi.mock('../../src/lib/journal-chain', () => ({ appendEntryToJournalChain: async () => {} }));
vi.mock('../../src/lib/chart-of-accounts', () => ({ CHART_OF_ACCOUNTS: [], seedChartOfAccounts: vi.fn() }));
vi.mock('../../src/lib/fiscal-period/strategies', () => ({ getPeriodStrategy: () => ({ calculate: () => [] }) }));
vi.mock('@sentry/nextjs', () => ({ init: () => state.effects.push('sentry'), captureRequestError: vi.fn() }));
vi.mock('../../src/lib/env/server', () => ({ validateEnv: () => state.effects.push('validate') }));
vi.mock('../../src/lib/pdf-worker', () => ({ initPdfWorker: async () => { state.effects.push('pdf'); } }));
vi.mock('../../src/lib/crypto', () => ({ decrypt: () => 'unused' }));
vi.mock('@prisma/client', () => {
  // Unlike Promise.resolve mocks, this models lazy execution and batch binding.
  function lazy(effect: () => Promise<any>, transaction?: string): any {
    let promise: Promise<any> | undefined;
    const run = () => promise ??= effect();
    return {
      [Symbol.toStringTag]: 'PrismaPromise',
      then: (...args: any[]) => run().then(...args),
      catch: (...args: any[]) => run().catch(...args),
      finally: (...args: any[]) => run().finally(...args),
      requestTransaction: (tx: string) => lazy(async () => { state.effects.push('batch:' + tx); return effect(); }, tx),
    };
  }
  class PrismaClient {
    $on() {}
    $extends(options: any) { state.result = options.result; return this; }
    $queryRaw(..._args: any[]) { return this.$executeRawUnsafe(); }
    $queryRawUnsafe(..._args: any[]) { return this.$executeRawUnsafe(); }
    $executeRaw(..._args: any[]) { return this.$executeRawUnsafe(); }
    $executeRawUnsafe(..._args: any[]) { return lazy(async () => { state.effects.push('raw'); await state.pause; return 1; }); }
    $transaction(input: any) {
      state.effects.push('transaction:start');
      const work = typeof input === 'function' ? input(this) : Promise.all(input.map((p: any) => p.requestTransaction('owned')));
      return Promise.resolve(work).then(result => { state.effects.push('transaction:commit'); return result; });
    }
    company = { findUnique: () => lazy(async () => ({ id: 'c' })), update: () => lazy(async () => { state.effects.push('company'); return { id: 'c', legalName: 'Company' }; }) };
    fiscalPeriod = { findUnique: () => lazy(async () => null), create: () => lazy(async () => ({})) };
    glAccount = { count: () => lazy(async () => 0) };
    session = { deleteMany: () => lazy(async () => { state.effects.push('session'); await state.pause; return { count: 1 }; }) };
    bankTransaction = { findMany: () => lazy(async () => [{ amount: state.result.bankTransaction.amount.compute({ amount: '12.50' }) }]) };
  }
  return { PrismaClient, Prisma: {} };
});
let root: string;
beforeEach(() => {
  const scratch = path.resolve('tests/backup-company/.scratch'); fs.mkdirSync(scratch, { recursive: true });
  root = fs.mkdtempSync(path.join(scratch, 'writers-')); state.root = root;
  state.gate = createMaintenanceGate(path.join(root, 'gate')); state.effects = []; state.pause = null;
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic/accountexpress_test');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const dbModule = () => import('../../src/lib/db');
const paused = () => { let resume!: () => void; const promise = new Promise<void>(r => { resume = r; }); return { promise, resume }; };

it('DB promises stay lazy; marked model/raw/array/callback operations have zero effects', async () => {
  const { db } = await dbModule();
  const lazy = db.session.deleteMany(); expect(state.effects).toEqual([]);
  expect(Object.prototype.toString.call(lazy)).toBe('[object PrismaPromise]');
  const owner = state.gate.beginMaintenance(); await owner.drain({ timeoutMs: 0 });
  for (const work of [() => lazy, () => db.$queryRaw`SELECT 1`, () => db.$executeRaw`SELECT 1`, () => db.$queryRawUnsafe('SELECT 1'), () => db.$executeRawUnsafe('SELECT 1'), () => db.$transaction([db.session.deleteMany()]), () => db.$transaction(async tx => tx.session.deleteMany())]) {
    await expect(Promise.resolve().then(work)).rejects.toMatchObject({ code: 'BACKUP_MAINTENANCE' });
    expect(state.effects).toEqual([]);
  }
  expect(state.gate.status()).toEqual({ marked: true, leases: 0 }); owner.release();
});
it('holds the entire interactive transaction, including non-DB awaits and nested work after publication', async () => {
  const { db } = await dbModule(); const wait = paused(); let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const work = db.$transaction(async tx => { await tx.session.deleteMany(); entered(); await wait.promise; await tx.$executeRawUnsafe('SELECT 1'); return 7; });
  await ready; const owner = state.gate.beginMaintenance();
  try { await expect(owner.drain({ timeoutMs: 0 })).rejects.toThrow('timed out'); expect(state.gate.status().leases).toBe(1); }
  finally { wait.resume(); }
  expect(await work).toBe(7); expect(state.effects).toEqual(['transaction:start', 'session', 'raw', 'transaction:commit']);
  await owner.drain({ timeoutMs: 0 }); owner.release();
});
it('preserves array transaction binding, raw results and Number UI computed fields', async () => {
  const { db } = await dbModule();
  expect(await db.$transaction([db.session.deleteMany(), db.$executeRawUnsafe('SELECT 1')])).toEqual([{ count: 1 }, 1]);
  expect(state.effects).toEqual(['transaction:start', 'batch:owned', 'session', 'batch:owned', 'raw', 'transaction:commit']);
  expect(await db.bankTransaction.findMany()).toEqual([{ amount: 12.5 }]);
  expect(state.gate.status().leases).toBe(0);
});
it('holds a direct DB operation while suspended and fences detached calls after request expiry', async () => {
  const { db } = await dbModule(); const wait = paused(); state.pause = wait.promise;
  const work = Promise.resolve(db.session.deleteMany()); await vi.waitFor(() => expect(state.effects).toEqual(['session']));
  const owner = state.gate.beginMaintenance();
  try { await expect(owner.drain({ timeoutMs: 0 })).rejects.toThrow('timed out'); }
  finally { wait.resume(); await work; }
  await owner.drain({ timeoutMs: 0 }); owner.release();
  let detached!: () => Promise<any>;
  await state.gate.withNormalOperation(async () => { detached = () => Promise.resolve(db.session.deleteMany()); });
  const next = state.gate.beginMaintenance(); await next.drain({ timeoutMs: 0 });
  const before = [...state.effects]; await expect(detached()).rejects.toThrow('Maintenance'); expect(state.effects).toEqual(before); next.release();
});
it('live owned recovery permits runtime writers only; expired inherited recovery refuses', async () => {
  const gate = state.gate; const owner = gate.beginMaintenance(); await owner.drain({ timeoutMs: 0 });
  const wait = paused(); let detached!: Promise<unknown>;
  await owner.runRecovery(async () => {
    await gate.withRuntimeOperation(async () => { state.effects.push('recovery'); });
    expect(gate.withRuntimeOperationSync(() => 42)).toBe(42);
    await expect(gate.withNormalOperation(async () => true)).rejects.toThrow('Maintenance');
    expect(() => gate.acquireNormalOperation()).toThrow('Maintenance');
    detached = wait.promise.then(() => gate.withRuntimeOperation(async () => state.effects.push('expired')));
  });
  wait.resume(); await expect(detached!).rejects.toThrow('Recovery');
  expect(state.effects).toEqual(['recovery']); expect(gate.status()).toEqual({ marked: true, leases: 0 }); owner.release();
});
it('already-started nested work keeps admission after its caller returns, but late normal callbacks reacquire', async () => {
  const gate = state.gate; const wait = paused(); let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const work = gate.withNormalOperation(async () => {
    void gate.withRuntimeOperation(async () => { started(); await wait.promise; state.effects.push('finished'); });
  });
  await ready; const owner = gate.beginMaintenance();
  try { await expect(owner.drain({ timeoutMs: 0 })).rejects.toThrow('timed out'); }
  finally { wait.resume(); await work; }
  expect(state.effects).toEqual(['finished']); await owner.drain({ timeoutMs: 0 }); owner.release();
  const late = paused(); let detached!: Promise<unknown>;
  await gate.withNormalOperation(async () => { detached = late.promise.then(() => gate.withRuntimeOperation(async () => state.effects.push('unsafe'))); });
  const next = gate.beginMaintenance(); await next.drain({ timeoutMs: 0 }); late.resume();
  await expect(detached).rejects.toThrow('Maintenance'); expect(state.effects).toEqual(['finished']); next.release();
});
it('array transaction retains admission through its slowest batch operation', async () => {
  const { db } = await dbModule(); const wait = paused(); state.pause = wait.promise;
  const work = db.$transaction([db.session.deleteMany(), db.$executeRawUnsafe('SELECT 1')]);
  await vi.waitFor(() => expect(state.effects).toContain('raw')); const owner = state.gate.beginMaintenance();
  try { await expect(owner.drain({ timeoutMs: 0 })).rejects.toThrow('timed out'); }
  finally { wait.resume(); await work; }
  expect(state.effects.at(-1)).toBe('transaction:commit'); await owner.drain({ timeoutMs: 0 }); owner.release();
});
it('owned recovery DB/files remain guarded and expired contexts fail even after reopening', async () => {
  const { db } = await dbModule(); const { FileResource } = await import('../../src/internal/operation-controller/resources/file-resource');
  const resource = new FileResource(root); const owner = state.gate.beginMaintenance(); await owner.drain({ timeoutMs: 0 });
  const late = paused(); let detached!: Promise<unknown>;
  await owner.runRecovery(async () => {
    await db.session.deleteMany();
    expect(resource.execute({ intentId: 'owned', target: 'recovered.txt', resourceType: 'file', operation: 'create', allowedEffects: ['create'], forbiddenEffects: [], budget: { maxChanges: 1 }, expectedState: { 'recovered.txt': 'safe' }, verificationScope: 'scoped' })).toEqual({ success: true });
    detached = late.promise.then(async () => { await db.session.deleteMany(); });
  });
  owner.release(); late.resume(); await expect(detached).rejects.toThrow('Recovery');
  expect(state.effects).toEqual(['session']); expect(fs.readFileSync(path.join(root, 'recovered.txt'), 'utf8')).toBe('safe');
});
it('sync runtime guard keeps return timing and refuses promise misuse without releasing inflight work', async () => {
  expect(state.gate.withRuntimeOperationSync(() => 4)).toBe(4);
  const wait = paused();
  expect(() => state.gate.withRuntimeOperationSync(() => wait.promise)).toThrow('Synchronous');
  const owner = state.gate.beginMaintenance();
  await expect(owner.drain({ timeoutMs: 0 })).rejects.toThrow('timed out');
  wait.resume(); await vi.waitFor(() => expect(state.gate.status().leases).toBe(0));
  await owner.drain({ timeoutMs: 0 }); owner.release();
});
it('file resource stays synchronous, preserves unmarked operations and denies all mutations unchanged', async () => {
  const { FileResource } = await import('../../src/internal/operation-controller/resources/file-resource');
  const resource = new FileResource(root);
  const contract = (operation: any) => ({ intentId: 'owned', target: 'owned.txt', resourceType: 'file', operation, allowedEffects: [operation], forbiddenEffects: [], budget: { maxChanges: 1 }, expectedState: { 'owned.txt': 'new' }, verificationScope: 'scoped' as const });
  expect(resource.execute(contract('create'))).toEqual({ success: true }); expect(resource.readFile('owned.txt')).toBe('new');
  const owner = state.gate.beginMaintenance(); await owner.drain({ timeoutMs: 0 });
  for (const operation of ['modify', 'create', 'delete']) {
    expect(resource.execute(contract(operation))).toEqual({ success: false, error: 'Maintenance admission unavailable' });
    expect(fs.readFileSync(path.join(root, 'owned.txt'), 'utf8')).toBe('new');
  }
  expect(resource.execute(contract('read'))).toEqual({ success: true, detail: 'new' }); owner.release();
  expect(resource.execute(contract('delete'))).toEqual({ success: true });
});
it('onboarding holds one lease across its DB and configuration effects; deny changes neither', async () => {
  const { completeOnboarding } = await import('../../src/lib/services/onboarding.service');
  const owner = state.gate.beginMaintenance(); await owner.drain({ timeoutMs: 0 });
  await expect(completeOnboarding('c', 'Company', 'USD', 1, 2026, 'CALENDAR')).rejects.toThrow('Maintenance');
  expect(state.effects).toEqual([]); expect(fs.existsSync(path.join(root, 'company-config.json'))).toBe(false); owner.release();
  await completeOnboarding('c', 'Company', 'USD', 1, 2026, 'CALENDAR');
  expect(JSON.parse(fs.readFileSync(path.join(root, 'company-config.json'), 'utf8')).companies.c.currency).toBe('USD');
  expect(state.effects).toEqual(['transaction:start', 'company', 'company', 'transaction:commit']); expect(state.gate.status().leases).toBe(0);
});
it('logo writer denies before consuming input or touching bytes and holds admission across file awaits', async () => {
  const { saveLogo, deleteLogo } = await import('../../src/lib/uploads/logo-service');
  const file = new File(['owned'], 'owned.png', { type: 'image/png' }); const input = vi.spyOn(file, 'arrayBuffer');
  const owner = state.gate.beginMaintenance(); await owner.drain({ timeoutMs: 0 });
  await expect(saveLogo(file)).rejects.toThrow('Maintenance'); await expect(deleteLogo('/uploads/logos/owned.png')).rejects.toThrow('Maintenance');
  expect(input).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(root, 'uploads'))).toBe(false); owner.release();
  const wait = paused(); input.mockImplementation(async () => { await wait.promise; return new TextEncoder().encode('owned').buffer; });
  const work = saveLogo(file); await vi.waitFor(() => expect(input).toHaveBeenCalledOnce()); const next = state.gate.beginMaintenance();
  try { await expect(next.drain({ timeoutMs: 0 })).rejects.toThrow('timed out'); } finally { wait.resume(); }
  const saved = await work; expect(fs.readFileSync(path.join(root, saved), 'utf8')).toBe('owned');
  await next.drain({ timeoutMs: 0 }); next.release(); await deleteLogo(saved); expect(fs.existsSync(path.join(root, saved))).toBe(false);
});
it('an admitted mixed logo/DB unit keeps its one lease after maintenance publishes between effects', async () => {
  const { saveLogo } = await import('../../src/lib/uploads/logo-service'); const { db } = await dbModule();
  const file = new File(['owned'], 'owned.png', { type: 'image/png' }); let owner!: ReturnType<typeof state.gate.beginMaintenance>;
  vi.spyOn(file, 'arrayBuffer').mockImplementation(async () => {
    owner = state.gate.beginMaintenance();
    await expect(owner.drain({ timeoutMs: 0 })).rejects.toThrow('timed out');
    return new TextEncoder().encode('owned').buffer;
  });
  await state.gate.withNormalOperation(async () => {
    const logo = await saveLogo(file);
    expect(state.gate.status()).toEqual({ marked: true, leases: 1 });
    await db.company.update({ where: { id: 'c' }, data: { logo } });
    expect(fs.readFileSync(path.join(root, logo), 'utf8')).toBe('owned');
  });
  expect(state.effects).toEqual(['company']); await owner.drain({ timeoutMs: 0 }); owner.release();
});
it('startup refuses before runtime files, imports with effects or cleanup timers; normal startup still runs', async () => {
  const { initRuntimeData } = await import('../../src/lib/init-runtime');
  const { register } = await import('../../src/instrumentation'); vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  const owner = state.gate.beginMaintenance(); await owner.drain({ timeoutMs: 0 });
  expect(() => initRuntimeData()).toThrow('Maintenance'); await expect(register()).rejects.toThrow('Maintenance');
  expect(state.effects).toEqual([]); expect(fs.existsSync(path.join(root, 'company-config.json'))).toBe(false); owner.release();
  const interval = vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as any);
  expect(initRuntimeData()).toBeUndefined(); await register();
  expect(fs.readFileSync(path.join(root, 'company-config.json'), 'utf8')).toBe(''); expect(interval).toHaveBeenCalledOnce();
  expect(state.effects).toContain('pdf'); expect(state.effects).toContain('metrics');
});
it('direct logout acquires before token/session changes and preserves unmarked response/cookie', async () => {
  const { POST } = await import('../../src/app/api/auth/logout/route'); const { NextRequest } = await import('next/server');
  const request = new NextRequest('http://owned.test/api/auth/logout');
  const owner = state.gate.beginMaintenance(); await owner.drain({ timeoutMs: 0 });
  const denied = await POST(request); expect(denied.status).toBe(503); expect(await denied.json()).toEqual({ error: 'Maintenance admission unavailable', code: 'BACKUP_MAINTENANCE' });
  expect(denied.headers.get('set-cookie')).toBeNull(); expect(state.effects).toEqual([]); owner.release();
  const response = await POST(request); expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true });
  expect(response.cookies.get('session')?.value).toBe(''); expect(state.effects).toEqual(['token', 'logout']);
});
it('background cleanup refuses effects while marked and retains normal logging/count behavior', async () => {
  const { cleanupExpiredSessions, startSessionCleanupInterval } = await import('../../src/lib/maintenance/cleanupSessions');
  const owner = state.gate.beginMaintenance(); await owner.drain({ timeoutMs: 0 }); await cleanupExpiredSessions();
  expect(state.effects).toEqual([]);
  const interval = vi.spyOn(globalThis, 'setInterval').mockReturnValue(0 as any);
  expect(() => startSessionCleanupInterval()).toThrow('Maintenance'); expect(interval).not.toHaveBeenCalled();
  owner.release(); await cleanupExpiredSessions(); expect(state.effects).toEqual(['session']);
});
it('standalone deletion script fences before Prisma construction using the same persisted root (mock copy only)', async () => {
  const gateDir = path.join(root, '.data', 'backup-maintenance'); const gate = createMaintenanceGate(gateDir);
  const owner = gate.beginMaintenance(); await owner.drain({ timeoutMs: 0 });
  const moduleUrl = new URL('../../src/lib/backup-maintenance.mjs', import.meta.url).href;
  const source = fs.readFileSync('scripts/delete-company.mjs', 'utf8')
    .replace("import { PrismaClient } from '@prisma/client';", "class PrismaClient { constructor() { process.stdout.write('CONSTRUCTED\\n'); } }")
    .replace(/(['"])\.\.\/src\/lib\/backup-maintenance\.mjs\1/g, JSON.stringify(moduleUrl));
  const copy = path.join(root, 'delete-copy.mjs'); fs.writeFileSync(copy, source);
  const result = spawnSync(process.execPath, [copy, 'owned'], { cwd: root, env: { DATABASE_URL: 'synthetic_test' }, encoding: 'utf8', timeout: 3000, input: 'NO\n' });
  expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).toBe('Maintenance admission unavailable\n');
  expect(gate.status()).toEqual({ marked: true, leases: 0 }); owner.release();
  const normal = spawnSync(process.execPath, [copy, 'owned'], { cwd: root, env: { DATABASE_URL: 'synthetic_test' }, encoding: 'utf8', timeout: 3000, input: 'NO\n' });
  expect(normal.status).toBe(0); expect(normal.stderr).toBe(''); expect(normal.stdout).toBe('CONSTRUCTED\n⚠️  ¿Borrar TODA la empresa owned? (escribe "SI" para confirmar): Cancelado.\n'); expect(gate.status().leases).toBe(0);
});
