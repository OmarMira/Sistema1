import { loadConfig, extractComponents } from '@/lib/services/entity-detector';
import { normalizePattern } from '@/lib/services/pattern-normalizer';
import { db } from '@/lib/db';

// ── Types ─────────────────────────────────────────────────────────────────

export interface ConflictResult {
  conflict: boolean;
  socioEntity?: { id: string; pattern: string; role: string };
  merchantEntity?: { id: string; pattern: string; role: string };
  reason?: string;
}

export interface ConflictSyncResult {
  conflict: boolean;
  socioWins: boolean;
  hasMerchant: boolean;
  hasSocioInIndn: boolean;
  merchantName: string | null;
  socioIndnName: string | null;
}

// ── Sync core: pure function, no DB — works with pre-loaded data ─────────

/**
 * Core synchronous conflict detection — uses pre-loaded known SOCIO patterns
 * and entityFirstMode flag. No DB calls. Safe for use in synchronous contexts
 * like `transactionMatchesRule()` and `resolveContextRole()`.
 */
export function detectConflictSync(
  description: string,
  knownSocioPatterns: string[],
  entityFirstMode?: boolean,
): ConflictSyncResult {
  const config = loadConfig();
  const components = extractComponents(description, config);

  const hasMerchant = components.merchant !== null;
  const socioIndnName = components.indnName;

  const hasSocioInIndn =
    socioIndnName !== null &&
    knownSocioPatterns.some((p) => socioIndnName!.toLowerCase().includes(p.toLowerCase()));

  const conflict = hasMerchant && hasSocioInIndn;
  const efMode = entityFirstMode ?? false; // coerce undefined to false

  return {
    conflict,
    socioWins: conflict && efMode, // SOCIO wins only when conflict AND entityFirstMode
    hasMerchant,
    hasSocioInIndn,
    merchantName: components.merchant,
    socioIndnName,
  };
}

// ── Async: loads from DB, then uses sync core ─────────────────────────────

/**
 * Full conflict detector — loads entity context and company settings from DB.
 * Checks for SOCIO vs non-SOCIO entity conflicts and applies entityFirstMode.
 *
 * I9 fix: the old detectEntityConflict() and hasSocioConflict() did NOT check
 * entityFirstMode. This function ALWAYS checks it.
 */
export async function detectConflict(
  companyId: string,
  pattern: string,
  description: string,
): Promise<ConflictResult> {
  // 1. Load company's entityFirstMode flag
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { entityFirstMode: true },
  });
  const entityFirstMode = company?.entityFirstMode ?? false;

  // 2. Load active EntityContext records for company
  const entities = await db.entityContext.findMany({
    where: { companyId },
    select: { id: true, pattern: true, role: true, glAccountId: true },
  });

  // 3. Extract SOCIO patterns for the sync function
  const knownSocioPatterns = entities
    .filter((e) => e.role === 'SOCIO')
    .map((e) => e.pattern.toLowerCase());

  // 4. Use sync core for component-based conflict detection
  const syncResult = detectConflictSync(description, knownSocioPatterns, entityFirstMode);

  if (!syncResult.conflict) {
    // No conflict — but check if pattern or description matches any single entity
    const matchingEntities = entities.filter((e) => {
      const patLower = normalizePattern(pattern).toLowerCase();
      const patternMatch = patLower.includes(normalizePattern(e.pattern).toLowerCase());
      const descMatch =
        syncResult.merchantName &&
        normalizePattern(syncResult.merchantName).toLowerCase().includes(normalizePattern(e.pattern).toLowerCase());
      const indnMatch =
        syncResult.socioIndnName &&
        normalizePattern(syncResult.socioIndnName).toLowerCase().includes(normalizePattern(e.pattern).toLowerCase());
      return patternMatch || descMatch || indnMatch;
    });

    const socioEntities = matchingEntities.filter((e) => e.role === 'SOCIO');
    const merchantEntities = matchingEntities.filter((e) => e.role !== 'SOCIO');

    return {
      conflict: false,
      socioEntity: socioEntities.length > 0 ? { id: socioEntities[0].id, pattern: socioEntities[0].pattern, role: socioEntities[0].role } : undefined,
      merchantEntity: merchantEntities.length > 0 ? { id: merchantEntities[0].id, pattern: merchantEntities[0].pattern, role: merchantEntities[0].role } : undefined,
    };
  }

  // 5. Conflict detected — find the specific entities involved
  const socioEntities = entities.filter(
    (e) =>
      e.role === 'SOCIO' &&
      syncResult.socioIndnName &&
      normalizePattern(syncResult.socioIndnName).toLowerCase().includes(normalizePattern(e.pattern).toLowerCase()),
  );

  const merchantEntities = entities.filter(
    (e) =>
      e.role !== 'SOCIO' &&
      (normalizePattern(pattern).toLowerCase().includes(normalizePattern(e.pattern).toLowerCase()) ||
        (syncResult.merchantName &&
          normalizePattern(syncResult.merchantName).toLowerCase().includes(normalizePattern(e.pattern).toLowerCase()))),
  );

  if (socioEntities.length > 0 && merchantEntities.length > 0) {
    const socio = socioEntities[0];
    const merchant = merchantEntities[0];

    if (entityFirstMode) {
      return {
        conflict: true,
        socioEntity: { id: socio.id, pattern: socio.pattern, role: socio.role },
        merchantEntity: { id: merchant.id, pattern: merchant.pattern, role: merchant.role },
        reason: `entityFirstMode: SOCIO "${socio.pattern}" takes precedence over "${merchant.pattern}"`,
      };
    }

    return {
      conflict: true,
      socioEntity: { id: socio.id, pattern: socio.pattern, role: socio.role },
      merchantEntity: { id: merchant.id, pattern: merchant.pattern, role: merchant.role },
      reason: `Conflict: SOCIO "${socio.pattern}" vs merchant "${merchant.pattern}" — rule-first resolution`,
    };
  }

  // Should not reach here if syncResult.conflict is true, but handle edge case
  return { conflict: false };
}
