# Tasks: BRE-011 — Wildcard Semantics (Option A)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~180–250 (engines + wildcard.ts + corpus test) |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR (all phases unblocked); split into two PRs only if diff exceeds the budget |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

### Decision Dependencies (all RESOLVED 2026-08-02)

| Task | Depends on |
|------|------------|
| Create `wildcard.ts` | None |
| Replace Legacy guard | None |
| Integrate V2 | None |
| Integrate Precedence | None |
| Amount `*` handling | RESOLVED — Decision #1 (runtime no-match + write/import rejection) |
| `description_matches` `*` handling | RESOLVED — Decision #1 |
| Validation-rejection placement | RESOLVED — Decision #1 (shared domain/API layer) |
| Case 4 (legacy-column passthrough) | RESOLVED — Decision #2 (conditions-first, fallback legacy → canonical) |

## Phase 1: Foundation

- [x] 1.1 Create `src/lib/rule-engine/wildcard.ts` — export `WILDCARD_SURFACE: Readonly<Record<string, boolean>>`, `isWildcardValue(value)`, `evaluateWildcardCondition(condition, transaction): EvaluatedCondition | null`. Surface: `description_contains`, `description_eq`, `description_starts_with`, `description_ends_with` → true; `description_matches`, `amount_*` → false. (Depends: None)
- [x] 1.2 Unit test `wildcard.ts` — surface membership, non-empty match, empty no-match, `null` for off-surface. (Depends: 1.1)

## Phase 2: Core Implementation

- [x] 2.1 Modify `src/lib/services/rule-matching-engine.ts:48-49` — replace inline wildcard guard with `evaluateWildcardCondition` call; preserve non-empty semantics. (Depends: 1.1)
- [x] 2.2 Modify `src/lib/rule-engine/conditions/description.ts` — short-circuit `*` via shared guard in `contains`/`eq`/`starts_with`/`ends_with`; leave literal path otherwise. (Depends: 1.1)
- [x] 2.3 Modify `src/lib/rule-engine/conditions/amount.ts` — route `*` to explicit no-match; never `Number('*')`. (Depends: 1.1)
- [x] 2.4 Modify `description_matches` — `*` → no-match via contract, not `InvalidRegex` throw. (Depends: 1.1)
- [x] 2.5 Verify Precedence inherits guard via `evaluateCondition` (`rule-precedence-engine.ts:50-61`); add explicit test. (Depends: 2.2)

## Phase 3: Validation (RESOLVED — Decision #1)

- [x] 3.1 Add validation rejection of `*` on amount operators at rule write/import in a shared domain/API layer (used by create AND import; UI shows message but is not the only barrier; no DB-level restriction). (Depends: 2.3)
- [x] 3.2 Add validation rejection of `*` on `description_matches` at write/import in the same shared layer. (Depends: 2.4)
- [x] 3.3 Tests: create/import rejected; shared layer enforced; UI-only message never the sole barrier. (Depends: 3.1, 3.2)

## Phase 4: Legacy-column normalization (RESOLVED — Decision #2)

- [x] 4.1 Implement adapter normalization: conditions-first, fallback legacy `conditionType`/`conditionValue` → canonical model, fail closed when neither normalizes. (Depends: 2.2)
- [x] 4.2 `equals / "*"` → canonical `description_eq("*")`, routed through shared wildcard contract; productive path does NOT preserve `conditions: null`. (Depends: 4.1)
- [x] 4.3 Tests for general normalization (not just `*`): conditions-first precedence, legacy fallback, fail-closed, null-not-preserved. (Depends: 4.1, 4.2)

## Phase 5: Testing / Verification

- [x] 5.1 Re-run `tests/bre011-wildcard-corpus.test.ts` (8 cases) asserting parity across Legacy/V2/Precedence. (Depends: Phase 2)
- [x] 5.2 Regression: BRE-009 parity harness — W-1 no longer diverges on bounded surface. (Depends: Phase 2)
- [x] 5.3 Lint: `npm run lint` — no NEW errors introduced by the change (declare preexisting). (Depends: Phase 2)

## Phase 6: Documentation

- [x] 6.1 ADR for the runtime contract (Decision #1) and legacy normalization (Decision #2). (Depends: Phase 2)
- [x] 6.2 Update `docs/history/2026-08-wildcard-semantics.md` with decisions and outcome. (Depends: Phase 2, decisions)
