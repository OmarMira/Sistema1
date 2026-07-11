// Sprint 0 — Compatibility Audit
//
// This file is an INVENTORY, not an implementation.
// It documents the gap between legacy BankRule and ADR-009 contract.
// No translation logic or default mappings here — findings only.
// Each gap must be resolved before compat.ts becomes an active adapter.

/**
 * Legacy BankRule fields (prisma/schema.prisma:245)
 *
 * conditionType: string        // "contains" | "equals" | "starts_with" | "ends_with" | "amount_greater" | "amount_less"
 * conditionValue: string       // free text or numeric string
 * conditions: Json?            // array of { field, operator, value } — partial V2 migration
 * isActive: boolean
 * priority: Int (default 10)
 */

/**
 * ADR-009 condition types
 *
 * entity_eq | amount_eq | description_matches (regex) | description_contains
 * | amount_range | amount_lt | date_before | date_after
 *
 * GAPS:
 * - legacy "equals"         → no direct match in ADR-009 (closest: amount_eq for amounts, but equals on description is unmapped)
 * - legacy "starts_with"    → no direct match (could be regex ^pattern via description_matches — needs approval)
 * - legacy "ends_with"      → same as starts_with
 * - legacy "amount_greater" → no direct match (amount_lt is "less than", not "greater than")
 * - legacy "amount_less"    → closest: amount_lt but semantics differ (legacy uses abs values)
 * - ADR-009 entity_eq       → no legacy equivalent (new capability)
 * - ADR-009 amount_range    → no legacy equivalent
 * - ADR-009 date_before/after → no legacy equivalent
 */

export const COMPAT_INVENTORY = {
  conditionTypes: {
    // legacy → new engine
    contains: { mapsTo: 'description_contains', confidence: 'high' },
    equals: { mapsTo: null, confidence: 'none', note: 'No ADR-009 equivalent for description equality' },
    starts_with: { mapsTo: null, confidence: 'none', note: 'Candidate: regex ^pattern via description_matches. Needs ADR amendment.' },
    ends_with: { mapsTo: null, confidence: 'none', note: 'Candidate: regex pattern$ via description_matches. Needs ADR amendment.' },
    amount_greater: { mapsTo: null, confidence: 'none', note: 'No ADR-009 equivalent. Legacy uses absolute values.' },
    amount_less: { mapsTo: null, confidence: 'none', note: 'No exact match. amount_lt needs validation with real data.' },
  },
  lifecycle: {
    // legacy isActive → ADR-009 lifecycle mapping
    isActive_true: { mapsTo: 'active (tentative)', confidence: 'medium', note: 'Could also be testing if rule was recently created' },
    isActive_false: { mapsTo: null, confidence: 'none', note: 'Could be deprecated, archived, or disabled. No data to distinguish.' },
  },
  priority: {
    note: 'Legacy default=10. ADR-009 uses priority as tie-break only (after specificity + match quality). Semantic change — existing rules with equal priority will behave differently.',
  },
  pendingDecisions: [
    'Add description_matches (regex) to ADR-009 with starts_with/ends_with support?',
    'Add amount_gt or amount_range for amount_greater legacy rules?',
    'Define lifecycle mapping for isActive=false → which ADR-009 state?',
    'Define engineVersion format and where it lives (only after v2 engine exists).',
  ] as string[],
} as const;
