// Memory Core — Deterministic Contradiction Detector (C7)
//
// BLOCKED_REQUIREMENT: C7 — semantic contradiction detection requires reasoning capability
//
// This module implements ONLY deterministic contradiction detection:
// 1. Explicit negation patterns (e.g., "X is true" vs "X is false")
// 2. Structured claim/value contradictions (e.g., {claim: "paid", value: true} vs {claim: "paid", value: false})
//
// What this module does NOT implement:
// - Semantic contradiction detection (e.g., "company closed" vs "company sold on date")
// - Implicit contradictions requiring reasoning
// - AI/LLM-based contradiction analysis
// - External API calls for contradiction detection
//
// For semantic contradiction detection, a reasoning capability is required.
// This is a known limitation documented in the design phase.

import type { ContradictionResult } from './types';

// ─── Normalization ──────────────────────────────────────────────────

/**
 * Normalize text for pattern matching.
 * Lowercase, trim, collapse whitespace, remove common punctuation.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,;:!?'"()]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Extract the "core proposition" from a normalized text.
 * This is the part that both texts must share for it to be a genuine contradiction.
 *
 * Strategy depends on the predicate type:
 * - Copula/existence (is/exists): proposition = subject only
 *   "the transaction is true" → "the transaction"
 *   "account a exists" → "account a"
 * - Modal (can/could/will/etc.): proposition = subject + action (everything after the modal)
 *   "the system can process refunds" → "the system process refunds"
 *   "the system cannot process refunds" → "the system process refunds"
 *
 * For modals, the action after the auxiliary is part of the proposition because
 * "can do X" vs "cannot do Y" is NOT a contradiction (different actions),
 * while "can do X" vs "cannot do X" IS a contradiction (same action, opposite polarity).
 */
function extractProposition(normalizedText: string): string {
  // First, handle compound negation patterns (e.g., "does not exist", "cannot")
  // Strip them to expose the underlying structure
  let text = normalizedText
    .replace(/\b(cannot|can\s+not|couldn'?t|wouldn'?t|shouldn'?t|won'?t|didn'?t|doesn'?t|don'?t)\b/g, '')
    .replace(/\b(does|do|did|not|no)\b/g, '')
    .replace(/\b(can|could|will|would|shall|should)\b/g, '');

  // Now find the first copula/existence verb — everything before it is the proposition
  const copulaPattern = /\b(?:is|are|was|were|es|son|está|están|exists|exist|existed|existe|existen|existió)\b/;
  const copulaMatch = text.match(copulaPattern);

  if (copulaMatch && copulaMatch.index !== undefined) {
    return text.slice(0, copulaMatch.index).trim();
  }

  // No copula found — for modals, the entire stripped text is the proposition
  // (subject + action, with modal removed)
  return text.trim();
}

/**
 * Check if two normalized texts share the same core proposition.
 * Uses exact match of extracted proposition strings.
 * Both texts must have a non-empty proposition to compare.
 */
function sameProposition(normA: string, normB: string): boolean {
  const propA = extractProposition(normA);
  const propB = extractProposition(normB);

  // Both must have a proposition
  if (!propA || !propB) return false;

  // Exact proposition match
  return propA === propB;
}

// ─── Negation Patterns ─────────────────────────────────────────────

const NEGATION_PATTERNS: Array<{ positive: RegExp; negative: RegExp }> = [
  // English patterns
  { positive: /\b(is|are|was|were)\s+(true|yes|correct)\b/i, negative: /\b(is|are|was|were)\s+(false|no|incorrect)\b/i },
  { positive: /\b(exists|exist|existed)\b/i, negative: /\b(does\s+not\s+exist|do\s+not\s+exist|didn'?t\s+exist|does\s+not|do\s+not)\b/i },
  { positive: /\b(can|could|will|would|shall|should)\b/i, negative: /\b(cannot|can\s+not|could\s+not|won'?t|would\s+not|shall\s+not|should\s+not)\b/i },
  // Spanish patterns
  { positive: /\b(es|son|está|están)\s+(verdader[a-z]+|correcto[a-z]*|cierto[a-z]*)\b/i, negative: /\b(es|son|está|están)\s+(fals[a-z]+|incorrecto[a-z]*|incierto[a-z]*)\b/i },
  { positive: /\b(existe|existen|existió)\b/i, negative: /\b(no\s+existe|no\s+existen|no\s+existió)\b/i },
];

/**
 * Detect explicit negation contradictions.
 * Returns contradiction ONLY if one text affirms and the other negates THE SAME PROPOSITION.
 */
function detectNegation(textA: string, textB: string): ContradictionResult | null {
  const normA = normalize(textA);
  const normB = normalize(textB);

  // C7: both texts must be about the same core proposition
  if (!sameProposition(normA, normB)) return null;

  for (const { positive, negative } of NEGATION_PATTERNS) {
    const aHasPositive = positive.test(normA);
    const aHasNegative = negative.test(normA);
    const bHasPositive = positive.test(normB);
    const bHasNegative = negative.test(normB);

    // One affirms, the other negates — AND same topic (verified above)
    if (aHasPositive && bHasNegative) {
      return {
        isContradiction: true,
        evidence: `Item A affirms "${textA}" while item B negates "${textB}"`,
        confidence: 0.8,
        type: 'negation',
      };
    }
    if (aHasNegative && bHasPositive) {
      return {
        isContradiction: true,
        evidence: `Item A negates "${textA}" while item B affirms "${textB}"`,
        confidence: 0.8,
        type: 'negation',
      };
    }
  }

  return null;
}

// ─── Claim/Value Contradiction ─────────────────────────────────────

interface ClaimValuePair {
  claim: string;
  value: unknown;
}

/**
 * Try to parse content as a claim/value pair.
 * Supports JSON format: {"claim": "...", "value": ...}
 */
function parseClaimValue(content: string): ClaimValuePair | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.claim === 'string' && 'value' in parsed) {
      return { claim: parsed.claim, value: parsed.value };
    }
  } catch {
    // Not JSON — not a claim/value pair
  }
  return null;
}

/**
 * Detect claim/value contradictions.
 * Two items with the same claim but different values are contradictory.
 */
function detectClaimValue(
  contentA: string,
  contentB: string
): ContradictionResult | null {
  const pairA = parseClaimValue(contentA);
  const pairB = parseClaimValue(contentB);

  if (!pairA || !pairB) return null;

  // Same claim, different values
  if (pairA.claim === pairB.claim && pairA.value !== pairB.value) {
    return {
      isContradiction: true,
      evidence: `Claim "${pairA.claim}" has value ${JSON.stringify(pairA.value)} in item A but ${JSON.stringify(pairB.value)} in item B`,
      confidence: 1.0,
      type: 'claim_value',
    };
  }

  return null;
}

// ─── Main Detection Function ───────────────────────────────────────

/**
 * Deterministic contradiction detection.
 *
 * Checks:
 * 1. Explicit negation patterns
 * 2. Structured claim/value contradictions
 *
 * Does NOT check:
 * - Semantic contradictions (requires reasoning)
 * - Implicit contradictions (requires reasoning)
 *
 * @returns ContradictionResult with isContradiction=true if contradiction found,
 *          or isContradiction=false if no contradiction detected.
 */
export function detectDeterministic(
  itemA: { content: string },
  itemB: { content: string }
): ContradictionResult {
  // 1. Check negation patterns
  const negationResult = detectNegation(itemA.content, itemB.content);
  if (negationResult) return negationResult;

  // 2. Check claim/value pairs
  const claimValueResult = detectClaimValue(itemA.content, itemB.content);
  if (claimValueResult) return claimValueResult;

  // No contradiction found (deterministic scope)
  return {
    isContradiction: false,
    evidence: 'No deterministic contradiction detected',
    confidence: 0,
    type: 'none',
  };
}
