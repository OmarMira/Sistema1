/**
 * Canonical normalization for all matching operations.
 * Pure function: trims, lowercases, collapses whitespace, strips ASCII punctuation.
 * Preserves & (common in business names like "LQ&OM") and # (common in addresses).
 * Does NOT strip bank metadata prefixes — callers pre-process separately.
 */
const PUNCTUATION_REGEX = /[.,;:!?"'()\[\]{}\/\\|`~@%^*\-+=<>¡¿\u2013\u2014\u2018\u2019\u201C\u201D]/g;

export function normalizePattern(input: string): string {
  let s = input.trim();
  s = s.replace(/\s+/g, ' ');
  s = s.toLowerCase();
  s = s.replace(PUNCTUATION_REGEX, '');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

// ── sanitizeDescriptionForDetection and sanitizeDescriptionForAdaptive ──
// Removed in PR #4a. All callers migrated to normalizePattern() with
// caller-specific pre-processing.
