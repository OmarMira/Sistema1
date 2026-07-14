# Verify Report: Sprint 4 — Import Service Integration

**Date**: 2026-07-14
**Target**: `main` at `69af81c`
**Suite**: 1330/1330 tests, tsc 0, build OK

**Status**: PASS WITH DEVIATIONS

---

## Spec Requirements

| # | Requirement | Status | Evidence |
|---|-------------|--------|----------|
| 1 | Flag OFF delegates to legacy `findMatchingRule()` | **PASS** ✅ | `import.service.ts:476-484` — `else` branch calls `findMatchingRule()`. Legacy tests pass; `mockFindMatchingRule` called. |
| 2 | Winner with valid `glAccountId` → matched + journal | **PASS** ✅ | Adapter `mapDecisionToResult()` checks `classification?.glAccountId && ruleId`. Integration test verifies matched outcome. |
| 3 | Winner without `glAccountId` → pending | **PASS** ✅ | Adapter returns `{ outcome: 'pending' }`. Import sets `glAccountId=null, matchedRuleId=null`. |
| 4 | Pending → `glAccountId=null`, `matchedRuleId=null`, no journal | **PASS** ✅ | Test verifies DB values are NULL and `journalEntry` has 0 entries. |
| 5 | `ambiguous` → pending | **PASS** ✅ | Adapter: non-winner decisions → `pending`. |
| 6 | `no_match` → pending | **PASS** ✅ | Same path as ambiguous. |
| 7 | Engine error → pending, warning logged, no legacy fallback | **PASS** ✅ | Adapter catches → pending with `errorCode`. Import logs `logger.warn`. Spy confirms `findMatchingRule` NOT called. |
| 8 | Protected transactions skipped (reconciled, journal-linked, classified, ignored, manually-edited) | **DEVIATION** ⚠️ | **Not implemented.** Every transaction in the import flow is new (not yet persisted), so none of these states are possible. The adapter has no invariant checks. This requirement applies to downstream consumers (apply-all, reconciliation, manual categorization) that operate on persisted transactions. **Spec should be amended or deferred to Sprint 5.** |
| 9 | Full `classification` preserved for manual review | **PARTIAL** ⚠️ | **Adapter preserves:** `MatchResult.pending` includes `classification`. **Import Service discards:** for any non-`matched` outcome, only `matchedRuleId=null, glAccountId=null` is stored. `classification` is not persisted or exposed downstream. Remains available in-memory only. **Spec should clarify that persistence/exposure of classification for pending transactions is out of Sprint 4 scope, or this must be implemented.** |
| 10 | Valid v1 conditions → normalized to v2 | **PASS** ✅ | `conditions-normalizer.ts` complete with 27 tests. |
| 11 | Invalid/corrupt conditions → rejected | **PASS** ✅ | `normalize()` throws `NormalizationError`. Adapter catches → `pending` with errorCode. |
| 12 | Mixed valid+invalid conditions → entire rule rejected | **PASS** ✅ | Normalizer rejects as corrupt. No partial application. |
| 13 | No fallback to legacy engine when flag ON | **PASS** ✅ | Spy test: `mockFindMatchingRule` called 0 times. |
| 14 | Trace/audit in-memory only, no DB persistence | **PASS** ✅ | Adapter has zero Prisma imports. No DB writes in adapter or in new import path. Code review confirms. *No explicit test for "no audit table writes" — structural coverage only.* |
| 15 | Adapter contains zero accounting logic | **PASS** ✅ | `index.ts`: mapping, orchestration, error handling only. |

---

## Summary

| Category | Count |
|----------|-------|
| PASS | 13 |
| PARTIAL | 1 (req #9 — classification discarded on pending) |
| DEVIATION | 1 (req #8 — protected transactions not implemented, structurally N/A) |
| Total | 15 |

---

## Open Deviations and Disposition

### Deviation 1: Protected transaction invariants (Req #8)

**Spec says**: "Transactions that are reconciled, journal-linked, classified, ignored, or manually-edited MUST be skipped before engine invocation."

**Reality**: The import flow receives only new, unpersisted transactions. None of these states can exist. The adapter has no invariant checks. The requirement as written applies to downstream consumers (apply-all, reconciliation) that operate on persisted records.

**Disposition**: Do NOT fix in Sprint 4. Defer to Sprint 5 with a spec amendment that scopes the invariant requirement to adapters operating on persisted transactions. Alternatively, amend the spec now to remove the requirement from the import-service integration scope.

### Deviation 2: Full classification for review (Req #9)

**Spec says**: "Adapter MUST return the full classification object in the result... If glAccountId is absent, the outcome MUST be pending and the full classification is preserved for manual review."

**Reality**: The adapter returns `classification` in `MatchResult`. However, `import.service.ts` only reads `outcome` and discards `classification` on pending results. It is preserved in memory but not persisted or exposed.

**Disposition**: Sprint 4 scope ends at the adapter boundary. Persisting classification for manual review requires a new DB field and UI work — out of Sprint 4 scope. Amend the spec to clarify that "preserved for review" means available at the adapter return boundary, not persisted.

---

## Accepted Dispositions

The following deviations are acknowledged and deferred. The original Sprint 4 spec remains unchanged as historical evidence.

| Ref | Issue | Disposition |
|-----|-------|-------------|
| Req #8 | Protected transaction invariants not implemented in import flow | Deferred to **Sprint 5 (S5-01)** — applies to consumers of persisted transactions |
| Req #9 | Classification discarded on pending — not persisted or exposed for review | Deferred to **Sprint 5 (S5-02)** — requires DB field + UI work |

### Sprint 5 references

- **S5-01** — Implement protected transaction invariant checks (reconciled, journal-linked, classified, ignored, manually-edited) for downstream consumers of persisted transactions
- **S5-02** — Persist and expose pending classification (entityId, category) for manual review

## Tasks Completion

| Task | Status |
|------|--------|
| Phase 1 (Foundation) — 1.1 to 1.5 | ✅ All complete |
| Phase 2 (Adapter) — 2.1 to 2.3 | ✅ All complete |
| Phase 3 (Integration) — 3.1 to 3.3 | ✅ All complete |
| Phase 4 (Verification) — 4.1 to 4.5 | Verification completed — **PASS WITH DEVIATIONS** |

---

## Final Checks

| Check | Result |
|-------|--------|
| `npx vitest run` | 1330/1330 (113 files) |
| `npx tsc --noEmit` | 0 errors |
| `npm run build` | OK (89 routes) |
| Flag OFF → legacy path | ✅ |
| Flag ON → no legacy fallback (spy) | ✅ |
| pending + errorCode → `logger.warn` | ✅ |
| pending without errorCode → no warning | ✅ |
| Transaction ID = SHA-256, not `pending-N` | ✅ |
| No journal entry on pending | ✅ |
| Adapter zero Prisma imports | ✅ |
