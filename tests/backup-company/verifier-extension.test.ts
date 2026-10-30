import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createMaintenanceGate } from '../../src/lib/backup-maintenance.mjs';
import type { MaintenanceGate } from '../../src/lib/backup-maintenance.mjs';

const state = vi.hoisted(() => ({
  gate: null as unknown as MaintenanceGate,
  writes: 0,
  lifecycle: [] as string[],
}));
vi.mock('../../src/lib/backup-maintenance.ts', () => ({
  withRuntimeOperation: (operation: () => unknown) => state.gate.withRuntimeOperation(operation),
}));
vi.mock('../../src/lib/logger', () => ({
  logger: { slowQuery: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('../../src/lib/metrics', () => ({ trackQueryDuration: vi.fn() }));
vi.mock('@prisma/client', () => {
  class PrismaClient {
    private _engineToken = 'mock-engine';
    $on() {
      if (this._engineToken !== 'mock-engine') throw new Error('Wrong lifecycle receiver');
      state.lifecycle.push('on');
    }
    $connect() {
      if (this._engineToken !== 'mock-engine') throw new Error('Wrong lifecycle receiver');
      state.lifecycle.push('connect');
      return Promise.resolve();
    }
    $disconnect() {
      if (this._engineToken !== 'mock-engine') throw new Error('Wrong lifecycle receiver');
      state.lifecycle.push('disconnect');
      return Promise.resolve();
    }
    $extends(options: { client?: object }) {
      Object.assign(this, options.client);
      return this;
    }
    $transaction(operations: Array<{ requestTransaction: (id: string) => PromiseLike<unknown> }>) {
      return Promise.all(operations.map(operation => operation.requestTransaction('mock-batch')));
    }
    session = {
      deleteMany: () => ({
        [Symbol.toStringTag]: 'PrismaPromise',
        then(resolve: (value: { count: number }) => unknown, reject: (error: unknown) => unknown) {
          return Promise.resolve().then(() => {
            state.writes++;
            return { count: 1 };
          }).then(resolve, reject);
        },
        requestTransaction(id: string) {
          if (id !== 'mock-batch') throw new Error('Missing batch binding');
          return this;
        },
      }),
    };
  }
  return { PrismaClient, Prisma: {} };
});

let root: string;
beforeEach(() => {
  const scratch = path.resolve('tests/backup-company/.scratch');
  fs.mkdirSync(scratch, { recursive: true });
  root = fs.mkdtempSync(path.join(scratch, 'extension-'));
  state.gate = createMaintenanceGate(path.join(root, 'gate'));
  state.writes = 0;
  state.lifecycle = [];
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic/accountexpress_test');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each(['purge', '$purge'] as const)('verifier: custom client %s cannot escape marked admission through its receiver', async name => {
  const { db } = await import('../../src/lib/db');
  const extended = db.$extends({ client: {
    [name]: function (this: typeof db) { return this.session.deleteMany(); },
  } });
  const owner = state.gate.beginMaintenance();
  await owner.drain({ timeoutMs: 0 });
  const marker = path.join(root, 'gate', 'maintenance.json');
  const hash = () => createHash('sha256').update(fs.readFileSync(marker)).digest('hex');
  const before = hash();
  let outcome: unknown;
  try {
    outcome = await extended[name]();
  } catch (error) {
    outcome = { code: (error as { code: string }).code };
  }
  expect(hash()).toBe(before);
  expect(outcome).toEqual({ code: 'BACKUP_MAINTENANCE' });
  expect(state.writes).toBe(0);
  expect(state.gate.status()).toEqual({ marked: true, leases: 0 });
  owner.release();
});

it('preserves custom synchronous returns, lazy query/batch returns and native lifecycle receivers', async () => {
  const { db } = await import('../../src/lib/db');
  const synchronous = { label: 'unchanged' };
  const extended = db.$extends({ client: {
    value() { return synchronous; },
    $value() { return 7; },
    purge(this: typeof db) { return this.session.deleteMany(); },
    $purge(this: typeof db) { return this.session.deleteMany(); },
  } });
  expect(extended.value()).toBe(synchronous);
  expect(extended.$value()).toBe(7);
  const query = extended.purge();
  const dollarQuery = extended.$purge();
  expect(Object.prototype.toString.call(query)).toBe('[object PrismaPromise]');
  expect(Object.prototype.toString.call(dollarQuery)).toBe('[object PrismaPromise]');
  expect(state.writes).toBe(0);
  expect(await extended.$transaction([query, dollarQuery])).toEqual([{ count: 1 }, { count: 1 }]);
  expect(state.writes).toBe(2);
  state.lifecycle = [];
  expect(await extended.$connect()).toBeUndefined();
  expect(await extended.$disconnect()).toBeUndefined();
  // Extended real clients may omit $on; the mock keeps it to pin binding policy.
  (extended as unknown as { $on: () => void }).$on();
  expect(state.lifecycle).toEqual(['connect', 'disconnect', 'on']);
  expect(state.gate.status()).toEqual({ marked: false, leases: 0 });
});
