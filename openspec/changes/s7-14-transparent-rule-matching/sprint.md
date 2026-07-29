# S7-14 — Transparent Rule Matching

**Date**: 2026-07-28
**Status**: ✅ COMPLETED

---

## Sprint Type

```
☐ Architecture
☐ Feature
☑ UX Hardening
```

---

## Goal

Make the V2 rule matching engine transparent by surfacing match confidence (HIGH/MEDIUM/LOW) per rule in the Apply All response, and showing candidate details when the engine returns AMBIGUOUS — without changing selection logic.

---

## Scope

- Add `confidenceLabel: 'high' | 'medium' | 'low'` to `RankedCandidate` in V2 engine.
- Derive it from `matchQuality` via a dedicated `toMatchConfidenceLabel()` function — semantically distinct from decision-engine's `toConfidenceLabel()`.
- Propagate through adapters, resolver, engine, use case, API route.
- Return `confidenceDistribution { high, medium, low }` per rule in `rulesApplied[]` (not a single modal label).
- On AMBIGUOUS: candidates carry `confidenceLabel`, `matchQuality`, `specificityScore`, `ruleId`.
- UI: render colored badges (green/amber/red) per rule in the Apply All result dialog.
- i18n keys for ES and EN.

## Out of Scope

- No changes to automatic selection logic.
- No tiebreakers for AMBIGUOUS.
- No changes to V1 legacy path.
- No changes to decision-engine thresholds.

---

## Exit Criteria

- ✅ `toMatchConfidenceLabel()` with documented thresholds (0.8/0.5), separate from decision-engine
- ✅ `RankedCandidate.confidenceLabel` populated on all V2 candidates
- ✅ `ApplyAllRuleResolution` carries `confidenceLabel?`, `matchQuality?`, `specificityScore?`
- ✅ `MatchResult.matchedRules` includes `confidenceDistribution`
- ✅ `POST /api/bank-rules/apply-all` returns `confidenceDistribution` per rule
- ✅ Apply All result dialog shows per-rule badges (Alta/Media/Baja)
- ✅ AMBIGUOUS response includes full candidate info
- ✅ Invariant: `high + medium + low === txIds.length` for every matched rule
- ✅ All existing tests green
- ✅ TypeScript clean (`tsc --noEmit`)
- ✅ Build passes (`npm run build`)

---

## Architecture

### toMatchConfidenceLabel

```typescript
const MATCH_CONFIDENCE_HIGH = 0.8;
const MATCH_CONFIDENCE_MEDIUM = 0.5;

export function toMatchConfidenceLabel(matchQuality: number): 'high' | 'medium' | 'low' {
  if (matchQuality >= MATCH_CONFIDENCE_HIGH) return 'high';
  if (matchQuality >= MATCH_CONFIDENCE_MEDIUM) return 'medium';
  return 'low';
}
```

### Data flow

```
evaluateTransactionAgainstRules()
  → RankedCandidate { ..., confidenceLabel }
  → applyAllAdapter() → ApplyAllRuleResolution { ..., confidenceLabel }
  → resolveApplyAllRule() → ...
  → executeMatching(): winnerMap accumulates confidenceDistribution per ruleId
  → MatchResult.matchedRules[] → { ..., confidenceDistribution }
  → POST route → rulesApplied[] → { ..., confidenceDistribution }
  → BankRulesPage UI → colored badges per rule
```

### Confidence distribution per rule (not modal)

Each transaction matched by a rule tracks its individual `confidenceLabel`. The aggregation per rule is:

```typescript
confidenceDistribution: { high: number; medium: number; low: number }
// high + medium + low === txIds.length  (invariant)
```

This preserves information about the spread of match quality, unlike a single modal label that could hide weak matches.

---

## Files Changed

| File | Change |
|------|--------|
| `src/lib/services/rule-precedence-engine.ts` | `toMatchConfidenceLabel()`, `RankedCandidate.confidenceLabel` |
| `src/lib/services/rule-precedence-adapters.ts` | `ApplyAllRuleResolution` + optional confidence fields |
| `src/lib/services/apply-all-engine.ts` | `MatchResult.confidenceDistribution`, winnerMap accumulation |
| `src/app/api/bank-rules/apply-all/route.ts` | `rulesApplied[]` includes `confidenceDistribution` |
| `src/components/spa/BankRulesPage.tsx` | Type + UI rendering with colored badges |
| `src/i18n/locales/es.ts` | 4 keys: `rulesApplied`, `confidenceHigh/Medium/Low` |
| `src/i18n/locales/en.ts` | 4 keys: `rulesApplied`, `confidenceHigh/Medium/Low` |
| `tests/unit/rule-precedence-engine.test.ts` | 10 tests (boundaries, confidenceLabel on candidates/ambiguous) |
| `tests/unit/apply-all-engine-characterization.test.ts` | 1 invariant test (high+medium+low === count) |
| `tests/unit/apply-all-enforcement.test.ts` | Updated mock factories |
| `tests/unit/apply-all-use-case.test.ts` | Updated mock factories |

---

## Verification

| Metric | Value |
|--------|-------|
| Test files | 153 passed |
| Tests | 1963 passed, 5 skipped |
| `tsc --noEmit` | 0 errors |
| `npm run build` | OK |
