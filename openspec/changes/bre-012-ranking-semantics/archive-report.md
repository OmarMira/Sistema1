# Archive Report: BRE-012 — Ranking Semantics (Option A — shared canonical comparator)

- **Change**: bre-012-ranking-semantics
- **Repo**: Sistema1
- **Main SHA**: 351d050 (HEAD)
- **Date**: 2026-08-03
- **Result**: PASS

## Decision

`option-a-shared-canonical-comparator`

## Resolved Decisions

1. **D1 — Legacy reuses the shared scoring pipeline.** `evaluateWinningRule` builds a `CanonicalCandidate` using ONLY `evaluateCondition` + `computeSpecificity` + `computeMatchQuality` from `src/lib/rule-engine/*`. No separate Legacy scoring implementation exists.
2. **D2 — No new flag.** The Legacy winner cutover is gated behind the existing `RULE_ENGINE_V2_ENABLED` flag (`src/lib/rule-engine/flag.ts` — still exactly 5 `*_KEY` entries). `BANK_RULE_ENGINE` (global engine-mode selector) is NOT reused for this internal branch. Flag OFF preserves `selectLegacyWinner` (`rolePriority → dbPriority → input order`); flag ON uses the canonical comparator.
3. **Open-1 RESOLVED — flag chosen for the Legacy cutover**: `RULE_ENGINE_V2_ENABLED`, read via the existing `isRuleEngineV2Enabled()` pattern.
4. **Open-2 RESOLVED — `ruleId` lexical order**: single shared `localeCompare` in `canonical-ranking.ts` (all three engines share the comparator).
5. **Open-3 RESOLVED — `AMBIGUOUS` mapping in Legacy output**: surfaced as `matchedRuleId=null` / `glAccountId=null` (like V2's pending path). Wired in `findMatchingRule` (`rule-matching-engine.ts`), the auto-reconciliation route (`if (!winner) continue`), and `resolveApplyAllRule` (`null/null`).
6. **Direction is a pre-filter, not a ranking key.** Two rules differing only by declared direction are now a full semantic tie → `AMBIGUOUS` (BRE-012), replacing the previous "defined direction adds specificity" behavior.

## Final State

- `sdd-verify`: PASS — 0 CRITICAL, all tasks 1.1→6.2 green (fresh verify sub-agent, read-only, run against the current tree after the adversarial suite landed).
- Adversarial parity suite (`tests/adversarial-ranking-parity.test.ts`): hermetic (no DB, no `BRE010_FIXTURE_PATH`; self-stubs `RULE_ENGINE_V2_ENABLED=true` via `beforeAll`/`afterAll`), 6/6 — covers 3-engine winner equality, input-order invariance, `AMBIGUOUS` on full tie, single-winner propagation, R-1 closure.
- Gate tests: 38/38 in `tests/services/rule-matching-engine.test.ts` (incl. `BRE-012 D2 flag gate` describe: OFF→R-A, ON→R-B, unset→Legacy, AMBIGUOUS only on canonical path).
- **BRE-009 parity — there is NO ranking divergence.** `v2DivergenceCount = 0` and `v2PrecedenceAgreementRate = 11/12`. The remaining `1/12` is a single **pre-existing V2_ERROR on regex vector X-1** (the adapter raises `engine_execution_error` before ranking on that malformed fixture). It is an error vector, not a divergence, and it is NOT attributable to BRE-012 — BRE-012 neither introduces nor resolves it. Every ranking-relevant vector (11/11 ranked cases) agrees across engines.
- Typecheck `tsc --noEmit`: exit 0. `git diff --check`: clean (only pre-existing CRLF warnings).

## Deliberate Harness Expectation Change (documented per review)

`tests/measure-rule-parity.test.ts` (BRE-009 harness) **intentionally changed functional expectations** — this is the expected consequence of the approved unified contract, NOT a test made to pass:

- R-1 vector: `expectedAxisB` `DIFFERENT_WINNER` → `SAME`. Rationale: R-1 was designed to expose V2-vs-Precedence divergence (Precedence summed condition weights and picked R-A; V2 tier-first picked R-B). Precedence now adopts the shared canonical tier-first comparator, so both engines converge on R-B.
- Axis B metrics: `10/12 → 11/12` agreements, `v2DivergenceCount 1 → 0`, `v2ErrorRate` unchanged at `1/12`.
- R-1 legacy order test: expected winner `R-A` → `R-B` (canonical comparator replaces the input-order tiebreak).

This deviates from a line in `design.md` (the design's file map stated `measure-rule-parity.test.ts` would "not be modified"), but the deviation is required and deliberate: the harness MUST exercise the flag-gated canonical path (self-stub) and reflect the closed R-1 divergence, otherwise it would assert the obsolete pre-BRE-012 contract. The expectation change is accompanied by inline comments referencing the BRE-012 R-1 closure.

## Deviation Register

| Design statement | Actual | Rationale |
|---|---|---|
| `design.md` file map: `measure-rule-parity.test.ts` "not modified" | Modified: R-1 axis B `DIFFERENT_WINNER→SAME`, metrics `10/12→11/12`, div `1→0`, R-1 winner `R-A→R-B`, flag self-stub added | Harness must measure the canonical comparator and the gated Legacy path; expectations updated to the approved contract (see above) |
| Task 1.2 path `tests/unit/canonical-ranking.test.ts` | Implemented at `src/lib/rule-engine/__tests__/canonical-ranking.test.ts` | Co-located with the module under test; vitest resolves it; harmless |

## Non-Blockers / Pre-existing

- BRE-010 real-parity harness (`tests/measure-real-rule-parity.test.ts`) env-aborts (17 skipped) — `BRE010_FIXTURE_PATH` unset. Pre-existing environment-block, not a BRE-012 regression.
- `lint` reports only 3 pre-existing errors in unrelated components.
- A `.env` file is tracked in the repo (pre-existing, outside this diff). Purging it is a separate task; BRE-012 does not touch it.

## Published Specs / Artifacts

- `openspec/changes/bre-012-ranking-semantics/specs/rule-ranking-contract/spec.md` — delta spec
- `docs/adr/ADR-012-bre-012-ranking-semantics.md`
- `docs/history/2026-08-ranking-semantics.md`

## Next

Change fully closed. No pending `sdd-verify` or `sdd-archive` work items. Legacy winner cutover remains flag-gated (`RULE_ENGINE_V2_ENABLED`) — enabling it in production is a separate, deliberate release step.
