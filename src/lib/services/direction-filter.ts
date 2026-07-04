import { EXPECTED_DIRECTION } from '@/lib/constants/entity-roles';
import type { EntityRole } from '@/lib/constants/entity-roles';

/**
 * Minimum decimal threshold (0–1) for a direction to be considered "pure".
 * At or above this threshold, the direction profile is classified as
 * pure credit or pure debit (not "ambas").
 */
export const DIRECTION_THRESHOLD = 0.8;

export type DirectionProfile = 'credit' | 'debit' | 'ambas';

/**
 * Roles that bypass direction filtering entirely.
 * These roles are valid regardless of the transaction direction profile.
 */
const BYPASS_ROLES = new Set<EntityRole>(['SOCIO', 'OTRO', 'IGNORADA']);

/**
 * Classify a direction profile into one of three categories.
 */
export function classifyDirection(profile: { creditPct: number; debitPct: number }): DirectionProfile {
  if (profile.creditPct >= DIRECTION_THRESHOLD) return 'credit';
  if (profile.debitPct >= DIRECTION_THRESHOLD) return 'debit';
  return 'ambas';
}

export interface DirectionFilterResult {
  valid: boolean;
  reason?: string;
}

/**
 * Determines whether the given entity role is valid for the transaction
 * direction profile of the associated GL account(s).
 *
 * @param role - The entity role to check (must be a valid ENTITY_ROLES value).
 * @param directionProfile - The direction profile with credit and debit percentages.
 * @returns An object with `valid` and optional `reason` if invalid.
 */
export function roleIsValidForDirection(
  role: string,
  directionProfile: { creditPct: number; debitPct: number },
): DirectionFilterResult {
  // Bypass roles always pass
  if (BYPASS_ROLES.has(role as EntityRole)) {
    return { valid: true };
  }

  const expectedDir = EXPECTED_DIRECTION[role as EntityRole];
  const profileDir = classifyDirection(directionProfile);

  // If profile is "ambas", every expected direction is compatible
  if (profileDir === 'ambas') {
    return { valid: true };
  }

  // profileDir is "credit" or "debit" — check for mismatch
  if (expectedDir === 'debit' && profileDir === 'credit') {
    return {
      valid: false,
      reason: `Role ${role} expects debit transactions but the account direction profile is pure credit (${directionProfile.creditPct}% credit, ${directionProfile.debitPct}% debit)`,
    };
  }

  if (expectedDir === 'credit' && profileDir === 'debit') {
    return {
      valid: false,
      reason: `Role ${role} expects credit transactions but the account direction profile is pure debit (${directionProfile.creditPct}% credit, ${directionProfile.debitPct}% debit)`,
    };
  }

  return { valid: true };
}
