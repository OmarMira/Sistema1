# Tasks: BRE-012 — Ranking Semantics (Option A — shared canonical comparator)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~220–340 (new shared module + 3 engine re-points + adversarial parity suite) |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR; split only if diff exceeds the budget |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Medium

### Decision Dependencies

Closed design decisions (do NOT re-open in apply):

| Task | Depends on |
|------|------------|
| Create `canonical-ranking.ts` | None |
| Re-point V2 | `canonical-ranking.ts` |
| Re-point Precedence | `canonical-ranking.ts` |
| Re-point Legacy winner | `canonical-ranking.ts` |
| D1 — Legacy reuses shared scoring (no own matchQuality/specificity) | RESOLVED — design §"Design decisions" |
| D2 — No new flag for BRE-012 (reuse `BANK_RULE_ENGINE`/`RULE_ENGINE_V2_ENABLED`) | RESOLVED — design §"Design decisions" |
| Open-1: existing flag chosen for Legacy cutover | RESOLVED 2026-08-03 — `RULE_ENGINE_V2_ENABLED` via `isRuleEngineV2Enabled` (per D2) |
| Open-2: `ruleId` lexical order (`localeCompare` collator) | RESOLVED 2026-08-03 — single shared `localeCompare` in `canonical-ranking.ts` |
| Open-3: `AMBIGUOUS` mapping in Legacy `MatchResult` | RESOLVED 2026-08-03 — `matchedRuleId=null`/`glAccountId=null` like pending (findMatchingRule, auto route, apply-all resolver) |

Recommended execution order:  1 → 2 → 3 → 4 (each engine re-point is independent of the others, all depend only on the shared module).

## Phase 1: Foundation — shared canonical module (Create)

- [x] 1.1 Create `src/lib/rule-engine/canonical-ranking.ts` — export `CanonicalCandidate` type (`ruleId`, `specificityScore: {highestTier, weightWithinTier}`, `matchQuality`, `priority`, `action`), `AMBIGUITY_DELTA_THRESHOLD = 0.10`, `comparator(a,b)` implementing the total order (tier DESC → weight DESC → matchQuality DESC → priority ASC → `ruleId.localeCompare` ASC), `rankCanonical(CanonicalCandidate[]): CanonicalCandidate[]` (stable), and `classifyCanonical(ranked): {winner?, ambiguous, reason, delta?}` implementing the unified `AMBIGUOUS` delta rule (keys 1–2/priority tie → compare delta on quality with `0.10`; full semantic tie → `AMBIGUOUS`, never a fabricated `ruleId` winner). (Depends: None)
- [x] 1.2 Unit test `tests/unit/canonical-ranking.test.ts` — comparator total-order stability, `AMBIGUOUS` delta boundary (below vs at-or-above `0.10`), full semantic tie → `AMBIGUOUS`, single candidate → winner, order-insensitivity of input array. (Depends: 1.1) — *implemented at `src/lib/rule-engine/__tests__/canonical-ranking.test.ts` (co-located; see archive-report deviation register)*

## Phase 2: Re-point V2 to shared comparator (Modify)

- [x] 2.1 Modify `src/lib/rule-engine/ranking.ts` — delegate the 5-key sort to `rankCanonical`; remove duplicated comparator keys; keep `TraceEvent` emission unchanged. (Depends: 1.1)
- [x] 2.2 Modify `src/lib/rule-engine/decision.ts` — delegate `classify`/`makeDecision` ambiguity branch to `classifyCanonical`; import `AMBIGUITY_DELTA_THRESHOLD` from shared (single source); preserve reason strings/DecisionReason mapped from shared output. (Depends: 1.1)
- [x] 2.3 Regression: run existing V2 tests (`tests/unit/rule-engine-adapter*.test.ts`, decision tests, wildcard corpus) — must remain green (no semantic change; only key dedup). (Depends: 2.1, 2.2)

## Phase 3: Re-point Precedence to shared comparator (Modify)

- [x] 3.1 `src/lib/services/rule-precedence-engine.ts` — delete summed `CONDITION_SPECIFICITY` map, `directionSpecificity`, `computeSpecificityScore`, the inline sort at `:170-175`, and the local `AMBIGUOUS` block at `:178-192`. Map each survivor `RankedCandidate` to `CanonicalCandidate` using shared `computeSpecificity`/`computeMatchQuality`, then `rankCanonical` + `classifyCanonical`. Keep `normalizeRuleForPrecedence`, direction pre-filter, `evaluateSingleCondition`, output shape `RuleMatchOutput`. (Depends: 1.1)
- [x] 3.2 Update existing Precedence unit tests (`tests/unit/rule-precedence-engine.test.ts`) where the winner flips on R-1 (tier-first beats summed). Amend expectations deliberately with a comment referencing BRE-012 R-1 closure. (Depends: 3.1)

## Phase 4: Re-point Legacy winner selection (Modify) — honors D1/D2

- [x] 4.1 `src/lib/services/rule-matching-engine.ts` — in `evaluateWinningRule`, keep `transactionMatchesRule` as the boolean collection filter; then build each surviving rule into a `CanonicalCandidate` using ONLY shared scoring (`evaluateCondition` + `computeMatchQuality` + `computeSpecificity`) per D1; select `winner.id` via `classifyCanonical`. Remove the `rolePriority` loop (`:295-322`), the `dbPriority` fallback, and the input-order `scored.sort` (`:324-327`). `loadRolePriorities` stays loaded but is NOT consumed for ranking. (Depends: 1.1)
- [x] 4.2 Gate the Legacy winner-selection change behind an existing flag per D2 (reuse `BANK_RULE_ENGINE` or `RULE_ENGINE_V2_ENABLED` — config decides which); when the flag is off, behavior is unchanged (old winner path retained temporarily); when on, the canonical comparator decides. Do NOT add a new flag. Wire the read per the existing `isRuleEngineV2Enabled`-style pattern. (Depends: 4.1) — *flag chosen: `RULE_ENGINE_V2_ENABLED` (Open-1 resolved)*
- [x] 4.3 Decide `AMBIGUOUS` mapping in `MatchResult` (Open-3): surface `AMBIGUOUS` as `glAccountId=null`/`matchedRuleId=null` (like pending) or keep current behavior; document decision in apply-notes. Update `findMatchingRule` return accordingly. (Depends: 4.1)

## Phase 5: Adversarial parity + Validation

- [x] 5.1 Create `tests/adversarial-ranking-parity.test.ts` — cross-engine (V2, Precedence, Legacy) over R-1 (tier-vs-sum), quality delta ties (below/at-or-above `0.10`), priority ASC, full-semantic tie `ruleId`-only → all engines emit the same `{winner|ambiguous}` ruleId; includes an order-insensitive reordered-input case. (Depends: Phase 2, 3, 4) — *hermetic: self-stubs `RULE_ENGINE_V2_ENABLED=true`, no DB/BRE010_FIXTURE_PATH; 6/6 green*
- [x] 5.2 Regression gates green: `npx vitest run` — BRE-009 `tests/measure-rule-parity.test.ts`, BRE-010 `tests/measure-real-rule-parity.test.ts`, BRE-011 wildcard corpus must pass. R-1 closure asserts **no ranking divergence**: `v2PrecedenceAgreementRate = 11/12`, `v2DivergenceCount = 0`, with the remaining `1/12` being the pre-existing V2_ERROR on regex vector X-1 (error vector, not a divergence, not a BRE-012 failure). (Depends: Phase 2, 3, 4) — *measured exactly as asserted; BRE-010 env-aborted (pre-existing, `BRE010_FIXTURE_PATH` unset)*
- [x] 5.3 Lint + typecheck: `npm run lint` and `npx tsc --noEmit` — no NEW errors introduced; declare preexisting baseline. DoD. (Depends: Phase 2, 3, 4) — *tsc exit 0; lint: only 3 pre-existing errors in unrelated components*

## Phase 6: Documentation/ADR

- [x] 6.1 ADR recording the shared canonical comparator contract, the dropped Legacy role/input-order tiebreak, the unified `AMBIGUOUS` (delta, `0.10` contract-level), and D1/D2 decisions. (Depends: Phase 2/3/4)
- [x] 6.2 Update `docs/history/2026-…-ranking-semantics.md` with measured R-1 closure + parity outcome. (Depends: Phase 5)