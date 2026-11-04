import { db } from './db';
import { Prisma } from '@prisma/client';
import { logger } from './logger';
import { computeAuditHash } from './journal-hash';

export interface AuditLogData {
  companyId?: string | null;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  details?: string | null;
}

/**
 * S12 — the audit chain is one global HMAC sequence (previousHash links are not
 * company-scoped). Tail selection is serialized with a transaction-scoped
 * advisory lock so two concurrent writers can never fork the chain.
 */
const AUDIT_CHAIN_LOCK_KEY = 'audit:chain-tail';

type AuditClient = Prisma.TransactionClient | typeof db;

/**
 * Creates the row and seals it into the existing hash chain.
 *
 * The tail is the member no other row links to ("has no successor"), never the
 * newest createdAt: the database timestamp is not an ordering authority for a
 * hash chain. Rows already persisted without a hash stay unsealed (legacy
 * history) — verifyAuditChain ignores them, so old and new rows coexist.
 */
async function createChainedAuditLog(client: AuditClient, data: AuditLogData) {
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${AUDIT_CHAIN_LOCK_KEY},0))`;

  const tails = await client.$queryRaw<Array<{ hash: string }>>`
    SELECT a."hash" AS hash
    FROM "AuditLog" a
    WHERE a."hash" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "AuditLog" s WHERE s."previousHash" = a."hash")
    LIMIT 1`;
  const previousHash = tails[0]?.hash ?? null;

  const created = await client.auditLog.create({
    data: {
      companyId: data.companyId || null,
      userId: data.userId || null,
      action: data.action,
      entity: data.entity,
      entityId: data.entityId || null,
      details: data.details || null,
    },
  });

  const hash = computeAuditHash({
    id: created.id,
    companyId: created.companyId,
    userId: created.userId,
    action: created.action,
    entity: created.entity,
    entityId: created.entityId,
    details: created.details,
    previousHash,
  });

  return client.auditLog.update({
    where: { id: created.id },
    data: { hash, previousHash },
  });
}

/**
 * Creates an AuditLog record with retry logic to handle PostgreSQL lock contentions.
 * Accepts an optional transaction client (`tx`).
 *
 * The insert and its chain seal share one transaction: a caller-supplied `tx`
 * keeps both inside the caller's atomic boundary; otherwise a short local
 * transaction is opened so a row is never persisted without its hash.
 */
export async function createAuditLogWithRetry(
  data: AuditLogData,
  tx?: Prisma.TransactionClient,
  maxAttempts = 3,
  delayMs = 100,
) {
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      if (tx) return await createChainedAuditLog(tx, data);
      // Prisma's dynamically extended client keeps its own delegate type; the
      // chained writer only uses the plain model + raw-query surface.
      return await db.$transaction(
        (inner) => createChainedAuditLog(inner as unknown as Prisma.TransactionClient, data),
        { maxWait: 10_000, timeout: 10_000 },
      );
    } catch (error: unknown) {
      const auditErr = error as { message?: string; code?: string };
      const isDatabaseLocked =
        auditErr.message?.includes('database is locked') ||
        auditErr.code === 'P2034' ||
        auditErr.code === 'P2002' ||
        auditErr.code === 'P2003';

      if (isDatabaseLocked && attempt < maxAttempts) {
        logger.warn(
          `⚠️ [AuditLog Retry] PostgreSQL locked on attempt ${attempt}/${maxAttempts}. Retrying in ${delayMs}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        // Exponential backoff
        delayMs *= 2;
        continue;
      }
      throw error;
    }
  }
}
