import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { db, testUrl } from './setup.integration';
import { PostgresIdentityRepository } from '../../src/lib/identity/repository';
import { IdentityService, NEUTRAL_RESPONSE } from '../../src/lib/identity/service';
import { IdentityMailer, type IdentityMessage } from '../../src/lib/identity/mail';
import { POLICY } from '../../src/lib/identity/contracts';

function fixture(client = db) {
  let time = Date.UTC(2030, 0, 1);
  const messages: IdentityMessage[] = [];
  const service = new IdentityService({ enabled: true, key: Buffer.alloc(32, 43) }, new PostgresIdentityRepository(client),
    new IdentityMailer({ send: async m => { messages.push(m); } }), () => new Date(time));
  const email = `${randomUUID()}@example.test`;
  return { service, email, messages, advance(ms: number) { time += ms; }, code() {
    const m = messages.filter(m => m.type === 'verification').at(-1);
    if (!m || m.type !== 'verification') throw Error('No verification delivered'); return m.code;
  }, token() {
    const m = messages.filter(m => m.type === 'recovery').at(-1);
    if (!m || m.type !== 'recovery') throw Error('No recovery delivered'); return m.token;
  } };
}
async function existingUser(email: string, active = true) {
  const id = randomUUID();
  await db.$executeRaw`INSERT INTO "User" (id,email,"isActive","passwordHash") VALUES (${id},${email},${active},'synthetic-unchanged')`;
  return id;
}

describe('isolated dormant identity primitives', () => {
  it('resumes pending registration without duplicates and consumes correct code once', async () => {
    const f = fixture();
    expect(await f.service.beginRegistration(f.email)).toBe(NEUTRAL_RESPONSE);
    const code = f.code();
    expect(await f.service.beginRegistration(f.email.toUpperCase())).toBe(NEUTRAL_RESPONSE);
    expect(f.messages).toHaveLength(1);
    expect(await f.service.verifyCode(f.email, code)).toBe(true);
    expect(await f.service.verifyCode(f.email, code)).toBe(false);
    const rows = await db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM "IdentityPendingRegistration" WHERE email=${f.email}`;
    expect(rows[0].count).toBe(1);
    const users = await db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM "User" WHERE email=${f.email}`;
    expect(users[0].count).toBe(0);
  });
  it('rejects incorrect codes and locks at five persistent attempts, including malformed input', async () => {
    const f = fixture(); await f.service.beginRegistration(f.email);
    const wrong = f.code() === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect(await f.service.verifyCode(f.email, i === 0 ? 'invalid' : wrong, `ip-${i}`)).toBe(false);
    expect(await f.service.verifyCode(f.email, f.code(), 'new-ip')).toBe(false);
    f.advance(POLICY.windowMs);
    expect(await f.service.verifyCode(f.email, f.code())).toBe(false);
  });
  it('expires at ten minutes, invalidates old generations and permits at most three resends', async () => {
    const f = fixture(); await f.service.beginRegistration(f.email); const old = f.code();
    f.advance(POLICY.codeMs);
    expect(await f.service.verifyCode(f.email, old)).toBe(false);
    await f.service.resendVerification(f.email);
    expect(await f.service.verifyCode(f.email, old)).toBe(false);
    expect(await f.service.verifyCode(f.email, f.code())).toBe(true);
    const g = fixture(); await g.service.beginRegistration(g.email);
    for (let i = 0; i < 4; i++) await g.service.resendVerification(g.email);
    expect(g.messages).toHaveLength(4);
  });
  it('renews an expired abandoned pending identity in the same record after 24 hours', async () => {
    const f = fixture(); await f.service.beginRegistration(f.email); const old = f.code();
    const before = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM "IdentityPendingRegistration" WHERE email=${f.email}`;
    f.advance(POLICY.pendingMs); await f.service.beginRegistration(f.email);
    const after = await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM "IdentityPendingRegistration" WHERE email=${f.email}`;
    expect(after).toEqual(before);
    expect(await f.service.verifyCode(f.email, old)).toBe(false);
    expect(await f.service.verifyCode(f.email, f.code())).toBe(true);
  });
  it('does not enumerate or recover inactive/nonexistent accounts; rechecks activity at consumption', async () => {
    const f = fixture(); await existingUser(f.email, false);
    expect(await f.service.requestRecovery(f.email)).toBe(NEUTRAL_RESPONSE);
    expect(await f.service.requestRecovery(`missing-${f.email}`)).toBe(NEUTRAL_RESPONSE);
    expect(f.messages).toHaveLength(0);
    await db.$executeRaw`UPDATE "User" SET "isActive"=true WHERE email=${f.email}`;
    await f.service.requestRecovery(f.email); const token = f.token();
    await db.$executeRaw`UPDATE "User" SET "isActive"=false WHERE email=${f.email}`;
    expect(await f.service.consumeRecovery(token)).toBe(null);
  });
  it('rejects invalid/expired/reused tokens; new issuance supersedes previous token', async () => {
    const f = fixture(); const user = await existingUser(f.email);
    await f.service.requestRecovery(f.email); const first = f.token();
    await f.service.requestRecovery(f.email); const second = f.token();
    expect(await f.service.consumeRecovery('invalid')).toBe(null);
    expect(await f.service.consumeRecovery('a'.repeat(64))).toBe(null);
    expect(await f.service.consumeRecovery(first)).toBe(null);
    f.advance(POLICY.recoveryMs);
    expect(await f.service.consumeRecovery(second)).toBe(null);
    await f.service.requestRecovery(f.email); const third = f.token();
    expect(await f.service.consumeRecovery(third)).toBe(user);
    expect(await f.service.consumeRecovery(third)).toBe(null);
  });
  it('permits only one token consumer across independent database connections', async () => {
    const f = fixture(); const user = await existingUser(f.email); await f.service.requestRecovery(f.email);
    const other = new PrismaClient({ datasources: { db: { url: testUrl } }, log: [] });
    try {
      const g = fixture(other);
      const results = await Promise.all([f.service.consumeRecovery(f.token()), g.service.consumeRecovery(f.token())]);
      expect(results.filter(Boolean)).toEqual([user]);
      expect(results.filter(r => r === null)).toHaveLength(1);
    } finally { await other.$disconnect(); }
  });
  it('shares brute-force budgets across instances and preserves existing business/session/password data', async () => {
    const f = fixture(); const user = await existingUser(`${randomUUID()}@example.test`);
    const company = randomUUID();
    await db.$executeRaw`INSERT INTO "Company" (id,marker) VALUES (${company},'business-unchanged')`;
    await db.$executeRaw`INSERT INTO "CompanyMember" ("userId","companyId") VALUES (${user},${company})`;
    await db.$executeRaw`INSERT INTO "Session" (id,"userId") VALUES (${randomUUID()},${user})`;
    const before = await db.$queryRaw`SELECT u.id,u."passwordHash",c.marker,m."companyId",s.id AS session FROM "User" u JOIN "CompanyMember" m ON m."userId"=u.id JOIN "Company" c ON c.id=m."companyId" JOIN "Session" s ON s."userId"=u.id WHERE u.id=${user}`;
    await f.service.beginRegistration(f.email);
    const other = new PrismaClient({ datasources: { db: { url: testUrl } }, log: [] });
    try {
      const g = fixture(other); const wrong = f.code() === '000000' ? '111111' : '000000';
      await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? f : g).service.verifyCode(f.email, wrong, `ip-${i}`)));
      expect(await g.service.verifyCode(f.email, f.code(), 'different-ip')).toBe(false);
      const stored = await db.$queryRaw<Array<{ attempts: number }>>`SELECT c.attempts FROM "IdentityChallenge" c JOIN "IdentityPendingRegistration" p ON c."subjectId"=p.id::text WHERE p.email=${f.email}`;
      expect(stored[0].attempts).toBe(5);
    } finally { await other.$disconnect(); }
    const after = await db.$queryRaw`SELECT u.id,u."passwordHash",c.marker,m."companyId",s.id AS session FROM "User" u JOIN "CompanyMember" m ON m."userId"=u.id JOIN "Company" c ON c.id=m."companyId" JOIN "Session" s ON s."userId"=u.id WHERE u.id=${user}`;
    expect(after).toEqual(before);
    const logs = await db.$queryRaw<Array<{ action: string; subject: string }>>`SELECT action,subject FROM "IdentitySecurityEvent"`;
    expect(logs.length).toBeGreaterThan(0);
    for (const event of logs) {
      expect(event.subject).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(event)).not.toContain(f.code());
      expect(JSON.stringify(event)).not.toContain(f.email);
    }
  });
});
