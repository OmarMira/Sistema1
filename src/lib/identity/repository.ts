import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { POLICY, type Budget, type DigestForCode, type IdentityRepository } from './contracts';
import { tokenDigest } from './crypto';

type Tx = Prisma.TransactionClient;
type Pending = { id: string; expiresAt: Date; confirmedAt: Date | null; resends: number };
type Challenge = { id: string; subjectId: string; digest: string; generation: number; attempts: number; expiresAt: Date; usedAt: Date | null };
type Action = 'verification_issued' | 'verification_rejected' | 'verification_confirmed' | 'recovery_issued' | 'recovery_consumed' | 'delivery_ok' | 'delivery_failed';

// This class is never instantiated by the application in Phase A. All access is
// injected, parameterized and transaction-scoped; no application db import.
export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly db: PrismaClient) {}
  private transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.$transaction(work, { maxWait: 10000, timeout: 10000 });
  }
  private async lock(tx: Tx, namespace: string, subject: string): Promise<void> {
    const key = `${namespace}:${tokenDigest(subject)}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`;
  }
  private async audit(tx: Tx, action: Action, subject: string, now: Date): Promise<void> {
    // Fixed columns, no arbitrary details/provider payload, email, code or token.
    await tx.$executeRaw`INSERT INTO "IdentitySecurityEvent" (id,action,subject,"createdAt") VALUES (${randomUUID()}::uuid,${action},${subject},${now})`;
  }
  private async admit(tx: Tx, budgets: Budget[], now: Date): Promise<boolean> {
    const window = new Date(Math.floor(now.getTime() / POLICY.windowMs) * POLICY.windowMs);
    for (const budget of [...budgets].sort((a, b) => a.subject.localeCompare(b.subject))) {
      const rows = await tx.$queryRaw<Array<{ attempts: number }>>`
        INSERT INTO "IdentityRateLimit" (subject,"windowStart",attempts,"expiresAt")
        VALUES (${budget.subject},${window},1,${new Date(window.getTime() + POLICY.windowMs)})
        ON CONFLICT (subject,"windowStart") DO UPDATE SET attempts="IdentityRateLimit".attempts+1
        WHERE "IdentityRateLimit".attempts < ${budget.maximum} RETURNING attempts`;
      if (!rows.length) return false;
    }
    return true;
  }
  private async storeChallenge(tx: Tx, subject: string, purpose: string, generation: number, digest: string, expires: Date, now: Date): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "IdentityChallenge" (id,"subjectId",purpose,generation,digest,"expiresAt",attempts,"createdAt")
      VALUES (${randomUUID()}::uuid,${subject},${purpose},${generation},${digest},${expires},0,${now})
      ON CONFLICT ("subjectId",purpose) DO UPDATE
      SET generation=EXCLUDED.generation,digest=EXCLUDED.digest,"expiresAt"=EXCLUDED."expiresAt",attempts=0,"usedAt"=NULL`;
  }
  async issueVerification(email: string, now: Date, resend: boolean, digest: DigestForCode, budgets: Budget[]): Promise<boolean> {
    return this.transaction(async tx => {
      await this.lock(tx, 'registration', email);
      const existing = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE lower(email)=${email} LIMIT 1`;
      if (existing.length) return false;
      const found = await tx.$queryRaw<Pending[]>`SELECT id,"expiresAt","confirmedAt",resends FROM "IdentityPendingRegistration" WHERE email=${email} FOR UPDATE`;
      const pending = found[0];
      const expired = pending && pending.expiresAt.getTime() <= now.getTime();
      if (pending && !expired && (!resend || pending.confirmedAt || pending.resends >= POLICY.resends)) return false;
      if (!pending && resend) return false;
      if (!await this.admit(tx, budgets, now)) return false;
      const id = pending?.id ?? randomUUID();
      if (!pending) {
        await tx.$executeRaw`INSERT INTO "IdentityPendingRegistration" (id,email,"expiresAt",resends,"createdAt") VALUES (${id}::uuid,${email},${new Date(now.getTime() + POLICY.pendingMs)},0,${now})`;
      } else if (expired) {
        await tx.$executeRaw`UPDATE "IdentityPendingRegistration" SET "expiresAt"=${new Date(now.getTime() + POLICY.pendingMs)},resends=0,"confirmedAt"=NULL WHERE id=${id}::uuid`;
      } else {
        await tx.$executeRaw`UPDATE "IdentityPendingRegistration" SET resends=resends+1 WHERE id=${id}::uuid`;
      }
      const previous = await tx.$queryRaw<Array<{ generation: number }>>`SELECT generation FROM "IdentityChallenge" WHERE "subjectId"=${id} AND purpose='VERIFICATION'`;
      const generation = (previous[0]?.generation ?? 0) + 1;
      await this.storeChallenge(tx, id, 'VERIFICATION', generation, digest(id, generation), new Date(now.getTime() + POLICY.codeMs), now);
      await this.audit(tx, 'verification_issued', budgets[0].subject, now);
      return true;
    });
  }
  async attemptCode(email: string, now: Date, digest: DigestForCode, budgets: Budget[]): Promise<boolean> {
    return this.transaction(async tx => {
      await this.lock(tx, 'registration', email);
      const pending = (await tx.$queryRaw<Pending[]>`SELECT id,"expiresAt","confirmedAt",resends FROM "IdentityPendingRegistration" WHERE email=${email} FOR UPDATE`)[0];
      if (!pending || pending.confirmedAt || pending.expiresAt.getTime() <= now.getTime()) return false;
      const challenge = (await tx.$queryRaw<Challenge[]>`SELECT * FROM "IdentityChallenge" WHERE "subjectId"=${pending.id} AND purpose='VERIFICATION' FOR UPDATE`)[0];
      if (!challenge || challenge.usedAt || challenge.attempts >= POLICY.attempts || challenge.expiresAt.getTime() <= now.getTime()) return false;
      if (!await this.admit(tx, budgets, now)) return false;
      const expected = Buffer.from(challenge.digest, 'hex');
      const candidate = Buffer.from(digest(pending.id, challenge.generation), 'hex');
      const matches = expected.length === candidate.length && timingSafeEqual(expected, candidate);
      await tx.$executeRaw`UPDATE "IdentityChallenge" SET attempts=attempts+1 WHERE id=${challenge.id}::uuid`;
      if (!matches) {
        await this.audit(tx, 'verification_rejected', budgets[0].subject, now);
        return false;
      }
      const updated = await tx.$executeRaw`UPDATE "IdentityChallenge" SET "usedAt"=${now} WHERE id=${challenge.id}::uuid AND "usedAt" IS NULL AND "expiresAt">${now} AND attempts<=${POLICY.attempts}`;
      if (updated !== 1) return false;
      await tx.$executeRaw`UPDATE "IdentityPendingRegistration" SET "confirmedAt"=${now} WHERE id=${pending.id}::uuid`;
      await this.audit(tx, 'verification_confirmed', budgets[0].subject, now);
      return true;
    });
  }
  async issueRecovery(email: string, digest: string, now: Date, budgets: Budget[]): Promise<boolean> {
    return this.transaction(async tx => {
      await this.lock(tx, 'recovery-email', email);
      if (!await this.admit(tx, budgets, now)) return false;
      const user = (await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE lower(email)=${email} AND "isActive"=true FOR UPDATE`)[0];
      if (!user) return false;
      const previous = await tx.$queryRaw<Array<{ generation: number }>>`SELECT generation FROM "IdentityChallenge" WHERE "subjectId"=${user.id} AND purpose='RECOVERY' FOR UPDATE`;
      await this.storeChallenge(tx, user.id, 'RECOVERY', (previous[0]?.generation ?? 0) + 1, digest, new Date(now.getTime() + POLICY.recoveryMs), now);
      await this.audit(tx, 'recovery_issued', budgets[0].subject, now);
      return true;
    });
  }
  async consumeRecovery(digest: string, now: Date): Promise<string | null> {
    return this.transaction(async tx => {
      // Lock account before challenge, matching issuance lock ordering. The
      // digest CAS below also prevents replay when a concurrent issuer rotates it.
      const candidate = (await tx.$queryRaw<Array<{ subjectId: string }>>`SELECT "subjectId" FROM "IdentityChallenge" WHERE digest=${digest} AND purpose='RECOVERY'`)[0];
      if (!candidate) return null;
      const user = (await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE id=${candidate.subjectId} AND "isActive"=true FOR UPDATE`)[0];
      if (!user) return null;
      const changed = await tx.$executeRaw`UPDATE "IdentityChallenge" SET "usedAt"=${now} WHERE "subjectId"=${user.id} AND purpose='RECOVERY' AND digest=${digest} AND "usedAt" IS NULL AND "expiresAt">${now}`;
      if (changed !== 1) return null;
      await this.audit(tx, 'recovery_consumed', tokenDigest(`recovery-user:${user.id}`), now);
      // Infrastructure grant only. No password/session/business changes in A.
      // Phase C must integrate consumption + password + sessions in one TX;
      // this standalone primitive must NOT be wired directly into a reset route.
      return user.id;
    });
  }
  async recordDelivery(subject: string, success: boolean, now: Date): Promise<void> {
    await this.transaction(tx => this.audit(tx, success ? 'delivery_ok' : 'delivery_failed', subject, now));
  }

  async completeRecovery(digest: string, passwordHash: string, now: Date): Promise<string | null> {
    return this.transaction(async tx => {
      const userRow = (await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE id = (SELECT "subjectId" FROM "IdentityChallenge" WHERE digest=${digest} AND purpose='RECOVERY' AND "usedAt" IS NULL AND "expiresAt">${now})`)[0];
      if (!userRow) return null;
      const updated = await tx.$executeRaw`UPDATE "IdentityChallenge" SET "usedAt"=${now} WHERE digest=${digest} AND purpose='RECOVERY' AND "usedAt" IS NULL AND "expiresAt">${now}`;
      if (updated !== 1) return null;
      await tx.$executeRaw`UPDATE "User" SET "passwordHash"=${passwordHash} WHERE id=${userRow.id}::uuid`;
      await tx.$executeRaw`DELETE FROM "Session" WHERE "userId"=${userRow.id}`;
      await this.audit(tx, 'recovery_consumed', tokenDigest('recovery-user:' + userRow.id), now);
      return userRow.id;
    });
  }

}