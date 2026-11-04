/**
 * S9 — one confidence vocabulary.
 *
 * Three incompatible confidence scales were in use at once: free 0-1 floats
 * returned by the LLM, the stored `ConfidenceLevel` enum
 * (`certain | tentative | uncertain`, prisma/schema.prisma) used by the memory
 * layer, and literal `0.95` / `'high'` pairs hardcoded at some call sites.
 * Anything that needs to compare, display or persist a confidence goes through
 * `normalizeConfidence` so a score and its level can never be derived from
 * different scales.
 *
 * Documented mapping (the only contract callers may rely on):
 *   - number in [0, 1]  → score is the value itself, level is bucketed:
 *                         < 0.5 low | < 0.75 medium | < 0.9 high | ≥ 0.9 certain
 *   - numeric string    → the same 0-1 scale (models occasionally quote it)
 *   - ConfidenceLevel   → its documented score below (certain 0.95,
 *                         tentative 0.70, uncertain 0.30), case-insensitive
 *   - anything else     → { score: 0, level: 'low' } — FAIL CLOSED, so a
 *                         malformed score can never unlock an automatic action.
 *
 * Decision-engine thresholds are deliberately NOT redefined here (S9 scope).
 */

/** The four buckets every score collapses into. */
export type ConfidenceLevelName = 'low' | 'medium' | 'high' | 'certain';

export interface NormalizedConfidence {
  /** Comparable 0-1 score. */
  score: number;
  /** Bucket the score falls into. */
  level: ConfidenceLevelName;
}

/**
 * Documented score of each stored `ConfidenceLevel` enum member. `certain` is
 * the grade the KE/memory layer treats as authoritative; `tentative` is valid
 * but not final evidence; `uncertain` is questioned knowledge.
 */
export const CONFIDENCE_LEVEL_SCORES = {
  certain: 0.95,
  tentative: 0.7,
  uncertain: 0.3,
} as const;

/** Bucket boundary table: lower bound (inclusive) → level. */
export function confidenceLevelForScore(score: number): ConfidenceLevelName {
  if (score < 0.5) return 'low';
  if (score < 0.75) return 'medium';
  if (score < 0.9) return 'high';
  return 'certain';
}

/**
 * Collapse the four buckets onto the three labels the rules/AI UI already
 * renders (`'high' | 'medium' | 'low'`): the top bucket reads as high there.
 */
export function toConfidenceLabel(level: ConfidenceLevelName): 'high' | 'medium' | 'low' {
  return level === 'certain' ? 'high' : level;
}

function isConfidenceLevelName(value: string): value is keyof typeof CONFIDENCE_LEVEL_SCORES {
  return Object.prototype.hasOwnProperty.call(CONFIDENCE_LEVEL_SCORES, value);
}

function fromScore(score: number): NormalizedConfidence {
  return { score, level: confidenceLevelForScore(score) };
}

/**
 * Normalize any confidence value onto the single 0-1 + level vocabulary.
 * Fail-closed: unknown input yields `{ score: 0, level: 'low' }`.
 */
export function normalizeConfidence(raw: unknown): NormalizedConfidence {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
      return { score: 0, level: 'low' };
    }
    return fromScore(raw);
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return { score: 0, level: 'low' };

    const enumKey = trimmed.toLowerCase();
    if (isConfidenceLevelName(enumKey)) {
      return fromScore(CONFIDENCE_LEVEL_SCORES[enumKey]);
    }

    // Same 0-1 scale, just quoted by the model.
    if (/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(trimmed)) {
      return normalizeConfidence(Number(trimmed));
    }
  }

  return { score: 0, level: 'low' };
}
