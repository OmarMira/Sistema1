/**
 * Entity Resolution — Phase 1 of single-memory Knowledge Engine.
 *
 * Resolves a bank transaction description to a known entity identity
 * using CompanyKnowledge (canonical names + aliases).
 *
 * This module is READ-ONLY for identity resolution.
 * It does NOT produce GL accounts, treatments, or accounting decisions.
 * It does NOT write to any table.
 * It does NOT call AI.
 *
 * Contract:
 *   KNOWN  → exactly one entityId found (exact match on canonicalName or alias)
 *   UNKNOWN → no active entity matches this description
 *   ERROR  → persistence/reader failure, or ambiguous (>1 distinct entity matches)
 */

import { db } from '@/lib/db';

// ───────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────

export type EntityResolution =
  | { status: 'KNOWN'; entityId: string }
  | { status: 'UNKNOWN' }
  | { status: 'ERROR'; reason: string };

// ───────────────────────────────────────────────
// Normalization
// ───────────────────────────────────────────────

/**
 * Normalize a description for entity resolution comparison.
 *
 * Steps:
 *   1. Trim leading/trailing whitespace
 *   2. Collapse multiple whitespace characters into one
 *   3. Uppercase
 *
 * This is deterministic and tenant-agnostic.
 * The original persisted value is NEVER modified.
 */
export function normalizeForResolution(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toUpperCase();
}

// ───────────────────────────────────────────────
// Entity Resolution
// ───────────────────────────────────────────────

/**
 * Resolve a bank transaction description to a known entity identity.
 *
 * Searches CompanyKnowledge records for the given companyId,
 * matching against canonicalName and aliases using exact equality
 * after normalization.
 *
 * Collects ALL matching entityIds (deduped). If the same entity
 * matches via both canonicalName and alias, it counts as one.
 *
 *   0 distinct entities → UNKNOWN
 *   1 distinct entity   → KNOWN { entityId }
 *   >1 distinct entities → ERROR (ambiguous)
 *
 * @param companyId - Tenant scope (mandatory)
 * @param description - Raw bank transaction description
 * @returns EntityResolution: KNOWN, UNKNOWN, or ERROR
 */
export async function resolveEntity(
  companyId: string,
  description: string,
): Promise<EntityResolution> {
  // 1. Validate inputs
  if (!companyId || typeof companyId !== 'string') {
    return { status: 'ERROR', reason: 'Invalid companyId' };
  }

  if (!description || typeof description !== 'string') {
    return { status: 'ERROR', reason: 'Invalid description' };
  }

  // 2. Normalize the incoming description
  const normalized = normalizeForResolution(description);

  // 3. Load active CompanyKnowledge records for this tenant
  let records: Array<{
    id: string;
    canonicalName: string;
    aliases: string[];
    status: string;
  }>;

  try {
    records = await db.companyKnowledge.findMany({
      where: {
        companyId,
        status: 'active',
      },
      select: {
        id: true,
        canonicalName: true,
        aliases: true,
        status: true,
      },
    });
  } catch (error) {
    return {
      status: 'ERROR',
      reason: error instanceof Error ? error.message : 'Database read failed',
    };
  }

  // 4. Collect ALL matching entityIds (deduped)
  const matchedEntityIds = new Set<string>();

  for (const record of records) {
    // Match against canonicalName
    if (normalizeForResolution(record.canonicalName) === normalized) {
      matchedEntityIds.add(record.id);
      continue; // no need to check aliases for this record
    }

    // Match against aliases
    for (const alias of record.aliases ?? []) {
      if (normalizeForResolution(alias) === normalized) {
        matchedEntityIds.add(record.id);
        break; // one match per record is enough
      }
    }
  }

  // 5. Evaluate result
  if (matchedEntityIds.size === 0) {
    return { status: 'UNKNOWN' };
  }

  if (matchedEntityIds.size === 1) {
    const entityId = matchedEntityIds.values().next().value!;
    return { status: 'KNOWN', entityId };
  }

  // >1 distinct entity matches → ambiguous
  return {
    status: 'ERROR',
    reason: `Ambiguous entity identity: ${matchedEntityIds.size} distinct entities match "${description}"`,
  };
}
