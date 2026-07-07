import { db } from './db';
import { Prisma } from '@prisma/client';
import { logger } from './logger';

export interface AuditLogData {
  companyId?: string | null;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  details?: string | null;
}

/**
 * Creates an AuditLog record with retry logic to handle PostgreSQL lock contentions.
 * Accepts an optional transaction client (`tx`).
 */
export async function createAuditLogWithRetry(
  data: AuditLogData,
  tx?: Prisma.TransactionClient,
  maxAttempts = 3,
  delayMs = 100,
) {
  const client = tx || db;
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      return await client.auditLog.create({
        data: {
          companyId: data.companyId || null,
          userId: data.userId || null,
          action: data.action,
          entity: data.entity,
          entityId: data.entityId || null,
          details: data.details || null,
        },
      });
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
