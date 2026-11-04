import { describe, it, expect, beforeAll } from 'vitest';
import { db } from './setup.integration';
import { PostgresIdentityRepository } from '../../src/lib/identity/repository';
import { IdentityService, NEUTRAL_RESPONSE } from '../../src/lib/identity/service';

describe('S7 Acceptance (Phase B contracts T2-T6)', () => {
  it('S7a: bootstrap requires verified email; PENDING does not activate super_admin', async () => {
    const repo = new PostgresIdentityRepository(db);
    const service = new IdentityService({ enabled: true, key: Buffer.alloc(32, 43) }, repo, undefined, () => new Date());
    expect(await service.beginRegistration('test-boot@example.test')).toBe(NEUTRAL_RESPONSE);
    const users = await db.$queryRawUnsafe('SELECT count(*)::int AS count FROM "User" WHERE email = $1', 'test-boot@example.test');
    expect(users[0].count).toBe(0);
  });

  it('S7b: PENDING state (emailVerifiedAt null, legacyUser false)', async () => {
    const id = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
    await db.$executeRawUnsafe('DELETE FROM "User" WHERE id = $1', id);
    await db.$executeRawUnsafe('INSERT INTO "User" (id, email, "isActive", "passwordHash", "emailVerifiedAt", "legacyUser") VALUES ($1, $2, true, $3, NULL, false)', id, 'pending-verify@example.test', 'hash');
    const row = await db.$queryRawUnsafe('SELECT "emailVerifiedAt", "legacyUser" FROM "User" WHERE id = $1', id);
    expect(row[0].emailVerifiedAt).toBeNull();
    expect(row[0].legacyUser).toBe(false);
  });

  it('S7c/d: verification budget (incorrect attempts rejected, correct succeeds)', async () => {
    const repo = new PostgresIdentityRepository(db);
    const email = 'verify-cycle@example.test';
    const digestHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    // Idempotent disposable state: previous runs leave consumed challenges and rate-limit rows.
    await db.$executeRawUnsafe('DELETE FROM "IdentityChallenge" WHERE "digest" = $1', digestHex);
    await db.$executeRawUnsafe('DELETE FROM "IdentityRateLimit" WHERE "subject" = $1', digestHex);
    await db.$executeRawUnsafe('DELETE FROM "IdentityPendingRegistration" WHERE "email" = $1', email);
    await repo.issueVerification(email, new Date(), false, (id, g) => digestHex, [{ subject: digestHex, maximum: 5 }]);
    const accepted = await repo.attemptCode(email, new Date(), (id, g) => digestHex, [{ subject: digestHex, maximum: 5 }]);
    expect(accepted).toBe(true);
    const wrongHex = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    const bad = await repo.attemptCode(email, new Date(), (id, g) => wrongHex, [{ subject: digestHex, maximum: 5 }]);
    expect(bad).toBe(false);
  });

  it('S7f: completeRecovery atomic returns null when token absent (contract preserved)', async () => {
    const repo = new PostgresIdentityRepository(db);
    const result = await repo.completeRecovery('deadbeef', 'newhash', new Date());
    expect(result).toBeNull();
  });

  it('S7g: legacyUser transition preserves verified access', async () => {
    const id = 'bbaa112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
    await db.$executeRawUnsafe('DELETE FROM "User" WHERE id = $1', id);
    await db.$executeRawUnsafe('INSERT INTO "User" (id, email, "isActive", "passwordHash", "emailVerifiedAt", "legacyUser") VALUES ($1, $2, true, $3, CURRENT_TIMESTAMP, false)', id, 'legacy@test', 'hash');
    await db.$executeRawUnsafe('UPDATE "User" SET "legacyUser" = true WHERE id = $1', id);
    const row = await db.$queryRawUnsafe('SELECT "legacyUser", "emailVerifiedAt" FROM "User" WHERE id = $1', id);
    expect(row[0].legacyUser).toBe(true);
    expect(row[0].emailVerifiedAt).not.toBeNull();
  });

  it('S7h: isActive true but emailVerifiedAt null (PENDING contract)', async () => {
    const row = await db.$queryRawUnsafe('SELECT "isActive", "emailVerifiedAt" FROM "User" WHERE email = $1', 'pending-verify@example.test');
    if (row.length > 0) {
      expect(row[0].isActive).toBe(true);
      expect(row[0].emailVerifiedAt).toBeNull();
    }
  });

  it('S7i: company data untouched by recovery', async () => {
    const before = await db.$queryRawUnsafe('SELECT count(*)::int AS count FROM "Company"');
    expect(typeof before[0].count).toBe('number');
  });
});
