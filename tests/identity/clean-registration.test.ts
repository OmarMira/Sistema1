import { expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { IdentityService } from '../../src/lib/identity/service';
import { PostgresIdentityRepository } from '../../src/lib/identity/repository';
import { IdentityMailer } from '../../src/lib/identity/mail';

const now = new Date('2026-10-23T12:00:00Z');
const oldId = '00000000-0000-0000-0000-000000000001';
const email = 'deleted@example.test';
function fixture(options: { confirmed?: boolean; existing?: boolean; pending?: boolean; limited?: boolean } = {}) {
  const old = { id: oldId, expiresAt: new Date(now.getTime() + 60_000), confirmedAt: options.confirmed === false ? null : now, resends: 3 };
  const query = vi.fn(async (parts: TemplateStringsArray) => {
    const sql = parts.join('?');
    if (sql.includes('FROM "User"')) return options.existing ? [{ emailVerifiedAt: now, isActive: true, legacyUser: false }] : [];
    if (sql.includes('FROM "IdentityPendingRegistration"')) return options.pending === false ? [] : [old];
    if (sql.includes('INSERT INTO "IdentityRateLimit"')) return options.limited ? [] : [{ attempts: 1 }];
    if (sql.includes('SELECT generation')) return [];
    throw new Error('Unexpected isolated query');
  });
  const execute = vi.fn(async () => 1);
  const tx = { $queryRaw: query, $executeRaw: execute };
  const db = { $transaction: async (work: (client: typeof tx) => unknown) => work(tx) } as unknown as PrismaClient;
  const send = vi.fn(async () => undefined);
  const service = new IdentityService({ enabled: true, key: Buffer.alloc(32, 9) }, new PostgresIdentityRepository(db), new IdentityMailer({ send }), () => now);
  return { service, send, execute, query };
}

it.each([false, true])('starts a fresh request after a deleted account, including resend=%s and exhausted old resends', async resend => {
  const test = fixture();
  expect(await test.service.requestRegistrationCode(email, resend)).toEqual({ issued: true, delivered: true });
  expect(test.send).toHaveBeenCalledTimes(1);
  expect(test.send).toHaveBeenCalledWith({ type: 'verification', to: email, code: expect.stringMatching(/^\d{6}$/) });
  const inserts = test.execute.mock.calls as unknown as Array<[TemplateStringsArray, ...unknown[]]>;
  const pending = inserts.find(call => call[0].join('?').includes('INSERT INTO "IdentityPendingRegistration"'));
  expect(pending).toBeDefined();
  expect(pending!.slice(1)).not.toContain(oldId);
});
it('keeps ordinary first registration working', async () => {
  const test = fixture({ pending: false });
  expect(await test.service.requestRegistrationCode(email)).toEqual({ issued: true, delivered: true });
  expect(test.send).toHaveBeenCalledTimes(1);
});
it('does not replace a still-pending request on a repeated initial registration', async () => {
  const test = fixture({ confirmed: false });
  expect(await test.service.requestRegistrationCode(email)).toEqual({ issued: false, delivered: false });
  expect(test.send).not.toHaveBeenCalled();
  expect(test.execute.mock.calls).toHaveLength(1); // Advisory lock only.
});
it('does not issue registration codes for an existing verified user', async () => {
  const test = fixture({ existing: true });
  expect(await test.service.requestRegistrationCode(email, true)).toEqual({ issued: false, delivered: false });
  expect(test.send).not.toHaveBeenCalled();
  expect(test.query).toHaveBeenCalledTimes(1);
});
it('preserves the anti-abuse budget before clearing orphaned requests', async () => {
  const test = fixture({ limited: true });
  expect(await test.service.requestRegistrationCode(email)).toEqual({ issued: false, delivered: false });
  expect(test.send).not.toHaveBeenCalled();
  const calls = test.execute.mock.calls as unknown as Array<[TemplateStringsArray]>;
  expect(calls.some(call => /DELETE|UPDATE|INSERT/.test(call[0].join('?')))).toBe(false);
});
