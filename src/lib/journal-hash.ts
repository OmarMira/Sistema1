import { createHmac } from 'crypto';

/**
 * Cryptographic audit chain service.
 * Each posted JournalEntry and AuditLog is chained via HMAC-SHA-256.
 * Any tampering with the database breaks the chain and is detectable.
 */

const HMAC_SECRET = process.env.HMAC_SECRET || 'default-dev-secret-change-in-production';

/**
 * Compute HMAC-SHA-256 hash for a journal entry, chaining with the previous entry's hash.
 */
export function computeEntryHash(payload: {
  id: string;
  companyId: string;
  date: string;
  description: string;
  reference: string | null;
  status: string;
  totalDebit: number;
  totalCredit: number;
  previousHash: string | null;
}): string {
  const data = [
    payload.id,
    payload.companyId,
    payload.date,
    payload.description,
    payload.reference ?? '',
    payload.status,
    payload.totalDebit.toFixed(2),
    payload.totalCredit.toFixed(2),
    payload.previousHash ?? '',
  ].join('|');

  return createHmac('sha256', HMAC_SECRET).update(data).digest('hex');
}

/**
 * Compute HMAC-SHA-256 hash for an audit log entry, chaining with the previous log's hash.
 */
export function computeAuditHash(payload: {
  id: string;
  companyId: string | null;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  details: string | null;
  previousHash: string | null;
}): string {
  const data = [
    payload.id,
    payload.companyId ?? '',
    payload.userId ?? '',
    payload.action,
    payload.entity,
    payload.entityId ?? '',
    payload.details ?? '',
    payload.previousHash ?? '',
  ].join('|');

  return createHmac('sha256', HMAC_SECRET).update(data).digest('hex');
}

/**
 * Verify the integrity of the entire journal entry hash chain for a company.
 * Returns { valid, totalChecked, firstBreak }.
 */
export interface IntegrityResult {
  valid: boolean;
  totalChecked: number;
  firstBreak: {
    entryId: string;
    entryDate: string;
    description: string;
    expectedHash: string;
    actualHash: string;
  } | null;
}

export async function verifyJournalChain(
  companyId: string,
): Promise<IntegrityResult> {
  const { db } = await import('@/lib/db');

  // Get all posted entries ordered by creation date (chain order)
  const entries = await db.journalEntry.findMany({
    where: { companyId, status: 'posted' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      companyId: true,
      date: true,
      description: true,
      reference: true,
      status: true,
      hash: true,
      previousHash: true,
      createdAt: true,
      lines: {
        select: { debit: true, credit: true },
      },
    },
  });

  if (entries.length === 0) {
    return { valid: true, totalChecked: 0, firstBreak: null };
  }

  // Entries without hash are considered legacy (pre-HMAC) — skip them
  const entriesWithHash = entries.filter((e) => e.hash);
  const legacyCount = entries.length - entriesWithHash.length;

  let previousHash: string | null = null;

  for (let i = 0; i < entriesWithHash.length; i++) {
    const entry = entriesWithHash[i];
    const totalDebit = entry.lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = entry.lines.reduce((s, l) => s + l.credit, 0);

    const expectedHash = computeEntryHash({
      id: entry.id,
      companyId: entry.companyId,
      date: entry.date.toISOString(),
      description: entry.description,
      reference: entry.reference,
      status: entry.status,
      totalDebit,
      totalCredit,
      previousHash,
    });

    if (entry.hash !== expectedHash) {
      return {
        valid: false,
        totalChecked: legacyCount + i + 1,
        firstBreak: {
          entryId: entry.id,
          entryDate: entry.date.toISOString(),
          description: entry.description,
          expectedHash,
          actualHash: entry.hash,
        },
      };
    }

    previousHash = entry.hash;
  }

  return { valid: true, totalChecked: entries.length, firstBreak: null };
}

/**
 * Verify the integrity of the entire audit log hash chain.
 */
export async function verifyAuditChain(): Promise<IntegrityResult> {
  const { db } = await import('@/lib/db');

  const logs = await db.auditLog.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      companyId: true,
      userId: true,
      action: true,
      entity: true,
      entityId: true,
      details: true,
      hash: true,
      previousHash: true,
    },
  });

  if (logs.length === 0) {
    return { valid: true, totalChecked: 0, firstBreak: null };
  }

  const logsWithHash = logs.filter((l) => l.hash);
  const legacyCount = logs.length - logsWithHash.length;

  let previousHash: string | null = null;

  for (let i = 0; i < logsWithHash.length; i++) {
    const log = logsWithHash[i];

    const expectedHash = computeAuditHash({
      id: log.id,
      companyId: log.companyId,
      userId: log.userId,
      action: log.action,
      entity: log.entity,
      entityId: log.entityId,
      details: log.details,
      previousHash,
    });

    if (log.hash !== expectedHash) {
      return {
        valid: false,
        totalChecked: legacyCount + i + 1,
        firstBreak: {
          entryId: log.id,
          entryDate: log.action,
          description: `${log.entity}${log.entityId ? `:${log.entityId}` : ''}`,
          expectedHash,
          actualHash: log.hash,
        },
      };
    }

    previousHash = log.hash;
  }

  return { valid: true, totalChecked: logs.length, firstBreak: null };
}
