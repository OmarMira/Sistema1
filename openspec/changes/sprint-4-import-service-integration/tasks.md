# Tasks: Sprint 4 — Import Service Integration

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 500–650 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1: Foundation → PR 2: Adapter → PR 3: Integration |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units (Feature Branch Chain)

| Unit | Goal | Branch | Merges to |
|------|------|--------|-----------|
| 1 | Foundation (types + normalizer + tests) | `sprint4/foundation` from `main` | PR 1 → `sprint4/foundation` |
| 2 | Adapter (runRuleEngineV2 + tests) | `sprint4/adapter` from `sprint4/foundation` | PR 2 → `sprint4/foundation` |
| 3 | Integration (import.service.ts + E2E tests) | `sprint4/integration` from `sprint4/adapter` | PR 3 → `main` |

## Phase 1: Pre-work & Foundation

- [ ] 1.1 Physically verify `BankRule.conditions` storage format in production DB — confirm v1 shape before coding normalizer; document format decisions in ADR
- [ ] 1.2 TDD: write failing tests for types (`MatchResult`, `SkipReason`, `RuleEngineErrorCode`) and `detectFormat()` + `normalize()` first (`tests/services/rule-engine-adapter/conditions-normalizer.test.ts`)
- [ ] 1.3 Implement `src/lib/services/rule-engine-adapter/types.ts` — discriminated union with `matched`, `pending`, `skipped` outcomes
- [ ] 1.4 Implement `src/lib/services/rule-engine-adapter/conditions-normalizer.ts` — `detectFormat()` returns v1/v2/corrupt, `normalize()` maps v1→v2 or rejects
- [ ] 1.5 `vitest && tsc --noEmit && npm run build` — all green; atomic commit with revert hash logged

## Phase 2: Adapter Implementation

- [ ] 2.1 TDD: write adapter unit tests first (`tests/services/rule-engine-adapter/adapter.test.ts`) — mock engine, verify outcome mapping for matched, pending (winner-no-gl, ambiguous, no_match), engine_error; confirm zero Prisma calls
- [ ] 2.2 Implement `src/lib/services/rule-engine-adapter/index.ts` — `runRuleEngineV2()`: normalize conditions, build `RuleInput`, call `evaluateRules()`, map `EngineDecision` → `MatchResult`
- [ ] 2.3 `vitest && tsc --noEmit && npm run build` — all green; atomic commit with revert hash

## Phase 3: Integration into Import Service

- [ ] 3.1 Modify `src/lib/services/import.service.ts:~446` — add `RULE_ENGINE_V2_ENABLED` check; flag OFF → legacy `findMatchingRule()` (unchanged); flag ON → skip invariants then call `runRuleEngineV2()`
- [ ] 3.2 Wire adapter result into existing journal-creation loop at line 471: `matched` → set `glAccountId`/`matchedRuleId`; `pending` → store with `glAccountId=null`; `skipped` → skip
- [ ] 3.3 `vitest && tsc --noEmit && npm run build` — all green; atomic commit with revert hash

## Phase 4: Verification Tests

- [ ] 4.1 Write flag OFF integration tests — verify `findMatchingRule()` called, legacy behavior unchanged, existing tests still pass
- [ ] 4.2 Write flag ON integration tests covering all 6 scenarios: `matched`, `winner-without-glAccountId`, `ambiguous`, `no_match`, `engine_error`, `skipped`
- [ ] 4.3 Add assertion: `findMatchingRule()` called exactly zero times when flag ON (spy verification)
- [ ] 4.4 Add assertion: trace/audit NOT persisted — logger.debug output only, no DB writes
- [ ] 4.5 Final `vitest && tsc --noEmit && npm run build` — all green; atomic commit with revert hash

## Implementation Order

Foundation (types + normalizer) → Adapter → Integration → Verification. Each phase produces an atomic commit with `git revert` rollback. The normalizer is tested in isolation before any wiring. The import.service.ts change is the LAST code modification.
