import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { expect, it } from 'vitest';
import { db, testUrl } from './setup.integration';
import { PostgresIdentityRepository as Repo } from '../../src/lib/identity/repository';
import { IdentityService } from '../../src/lib/identity/service';
import { codeDigest, opaqueSubject, tokenDigest } from '../../src/lib/identity/crypto';
import { POLICY } from '../../src/lib/identity/contracts';

// Derived independently from S1-S4/S6; verified first in the authorized scratch.
const key = Buffer.alloc(32, 61);
const origin = Date.UTC(2037, 0, 1);
const at = (offset = 0) => new Date(origin + offset);
const digest = (code: string) => (id: string, generation: number) => codeDigest(key, id, generation, code);
const budgets = (email: string, purpose = 'verify') => [{
  subject: opaqueSubject(key, `${purpose}:email`, email), maximum: 5,
}];
const fresh = () => `${randomUUID()}@example.test`;
function issue(repo: Repo, email: string, offset = 0, resend = false, code = '123456') {
  return repo.issueVerification(email, at(offset), resend, digest(code), budgets(email, 'issue-verification'));
}
async function snapshot() {
  const tables = ['User', 'Company', 'CompanyMember', 'Session', 'IdentityPendingRegistration',
    'IdentityChallenge', 'IdentityRateLimit', 'IdentitySecurityEvent'];
  const data = [];
  for (const table of tables) {
    data.push(await db.$queryRawUnsafe(`SELECT row_to_json(t)::text AS row FROM "${table}" t ORDER BY row_to_json(t)::text`));
  }
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

it('S1: malformed attempts count, valid fifth attempt succeeds, expiry boundary is exact', async () => {
  const repo = new Repo(db), email = fresh();
  await issue(repo, email);
  const service = new IdentityService({ enabled: true, key }, repo, undefined, () => at());
  for (const bad of ['', '12345', '１２３４５６', '123456\n']) {
    expect(await service.verifyCode(email, bad)).toBe(false);
  }
  expect(await service.verifyCode(email, '123456')).toBe(true);
  const early = fresh();
  await issue(repo, early);
  expect(await repo.attemptCode(early, at(POLICY.codeMs - 1), digest('123456'), budgets(early))).toBe(true);
  const expired = fresh();
  await issue(repo, expired);
  const before = await snapshot();
  expect(await repo.attemptCode(expired, at(POLICY.codeMs), digest('123456'), budgets(expired))).toBe(false);
  expect(await snapshot()).toBe(before);
});

it('S1/S2/S4: resend preserves the email budget across clients and window boundaries', async () => {
  const other = new PrismaClient({ datasources: { db: { url: testUrl } }, log: [] });
  try {
    const a = new Repo(db), b = new Repo(other), email = fresh();
    await issue(a, email);
    for (let i = 0; i < 4; i++) {
      expect(await a.attemptCode(email, at(), digest('000000'), budgets(email))).toBe(false);
    }
    expect(await issue(b, email, 0, true, '654321')).toBe(true);
    expect(await b.attemptCode(email, at(), digest('000000'), budgets(email))).toBe(false);
    expect(await b.attemptCode(email, at(), digest('654321'), budgets(email))).toBe(false);
    expect(await issue(a, email, POLICY.windowMs, true, '111111')).toBe(true);
    expect(await b.attemptCode(email, at(POLICY.windowMs), digest('111111'), budgets(email))).toBe(true);
  } finally { await other.$disconnect(); }
});

it('S2: expiry renewal keeps pending ID and rejects a fourth resend', async () => {
  const repo = new Repo(db), email = fresh();
  await issue(repo, email);
  const rows = () => db.$queryRaw<Array<{ id: string }>>`SELECT id FROM "IdentityPendingRegistration" WHERE email=${email}`;
  const before = await rows();
  for (let i = 0; i < 3; i++) expect(await issue(repo, email, i + 1, true)).toBe(true);
  expect(await issue(repo, email, 4, true)).toBe(false);
  expect(await issue(repo, email, POLICY.pendingMs)).toBe(true);
  expect(await rows()).toEqual(before);
});

it('S3/S4: recovery budgets, digest storage, concurrent one-use and inactive restrictions hold', async () => {
  const email = fresh(), id = randomUUID(), repo = new Repo(db);
  await db.$executeRaw`INSERT INTO "User" (id,email,"isActive","passwordHash") VALUES (${id},${email},true,'unchanged')`;
  const other = new PrismaClient({ datasources: { db: { url: testUrl } }, log: [] });
  try {
    const b = new Repo(other), token = randomBytes(32).toString('hex'), hashed = tokenDigest(token);
    for (let i = 0; i < 5; i++) {
      expect(await (i % 2 ? repo : b).issueRecovery(email, hashed, at(), budgets(email, 'issue-recovery'))).toBe(true);
    }
    expect(await b.issueRecovery(email, tokenDigest('b'.repeat(64)), at(), budgets(email, 'issue-recovery'))).toBe(false);
    const stored = await db.$queryRaw<Array<{ digest: string }>>`SELECT digest FROM "IdentityChallenge" WHERE "subjectId"=${id}`;
    expect(stored).toEqual([{ digest: hashed }]);
    expect(hashed).not.toBe(token);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? repo : b).consumeRecovery(hashed, at(POLICY.recoveryMs - 1))));
    expect(results.filter(Boolean)).toEqual([id]);
    expect(await repo.issueRecovery(email, hashed, at(POLICY.windowMs), budgets(email, 'issue-recovery'))).toBe(true);
    expect(await repo.consumeRecovery(hashed, at(POLICY.windowMs + POLICY.recoveryMs))).toBe(null);
    await db.$executeRaw`UPDATE "User" SET "isActive"=false WHERE id=${id}`;
    expect(await repo.issueRecovery(email, hashed, at(POLICY.windowMs * 2), budgets(email, 'issue-recovery'))).toBe(false);
  } finally { await other.$disconnect(); }
});

it('S1/S4/S6: audit failure rolls back confirmation, attempts, budgets and other tables', async () => {
  const email = fresh(), repo = new Repo(db);
  await issue(repo, email);
  const before = await snapshot();
  const broken = {
    $transaction: (work: (tx: unknown) => Promise<unknown>, options: object) => db.$transaction(tx =>
      work(new Proxy(tx, {
        get(target, property) {
          if (property === '$executeRaw') {
            return (parts: TemplateStringsArray, ...args: unknown[]) => {
              if (parts.join('').includes('INSERT INTO "IdentitySecurityEvent"')) throw Error('synthetic audit failure');
              return target.$executeRaw(parts, ...args);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })), options),
  } as unknown as PrismaClient;
  await expect(new Repo(broken).attemptCode(email, at(), digest('123456'), budgets(email))).rejects.toThrow('synthetic audit failure');
  expect(await snapshot()).toBe(before);
  expect(await repo.attemptCode(email, at(), digest('123456'), budgets(email))).toBe(true);
});
