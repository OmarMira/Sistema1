# Tasks: Rule Engine v2 — Sprint 2: Specificity, Ranking & Decision Engine

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~300-400 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR with work-unit commits |
| Delivery strategy | single-pr |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Low

## Phase 1: Foundation — Types, Errors & Fixtures

- [x] 1.1 Add `EntityResolution`, `EntityResolutionStatus`, `RawCandidate`, `ScoredCandidate`, `SpecificityScore`, `PipelineArtifacts` to `src/lib/rule-engine/types.ts`; add `entityResolution` field to `RuleInput.context`
- [x] 1.2 Add `MissingEntityIdError` (extends `ConditionEvalError`) and `InvalidPipelineStateError` (extends `RuleEngineError`) to `src/lib/rule-engine/errors.ts`
- [x] 1.3 Add factory functions (`makeRawCandidate`, `makeScoredCandidate`, `makeSpecificityScore`, `makePipelineArtifacts`, `makeEngineDecision`, `makeEntityResolution`) and presets (`ruleWithEntityCondition`, `entityResolved`, `entityNotFound`, `entityNotRun`, `twoIdenticalSpecCandidates`, `highLowTierCandidates`, `ambiguousScenarioInput`, `winnerScenarioInput`) to `__tests__/fixtures.ts`; update `makeRuleInput` to include `entityResolution`
- [x] 1.4 Write error tests: `MissingEntityIdError` chain + code (ERR-13→ERR-15), `InvalidPipelineStateError` chain + code (ERR-16→ERR-18) in `__tests__/errors.test.ts`

## Phase 2: Core Modules — Specificity, Scoring, Ranking, Decision

- [x] 2.1 Create `src/lib/rule-engine/specificity.ts` with tier/weight map and `computeSpecificity(conditions: EvaluatedCondition[]): SpecificityScore`
- [x] 2.2 Write `__tests__/specificity.test.ts` — 19 tier/weight tests (SP-01→SP-19)
- [x] 2.3 Create `src/lib/rule-engine/scoring.ts` with `MATCH_QUALITY_ALPHA = 0.25`, `computeMatchQuality(scores: number[]): number`, and `scoreCandidates(artifacts: PipelineArtifacts): ScoredCandidate[]`
- [x] 2.4 Write `__tests__/scoring.test.ts` — 12 scoring + match quality tests (SQ-01→SQ-12)
- [x] 2.5 Create `src/lib/rule-engine/ranking.ts` with `rankCandidates(scored: ScoredCandidate[]): ScoredCandidate[]` — 5-key lexicographic sort (tests RK-01→RK-12)
- [x] 2.6 Create `src/lib/rule-engine/decision.ts` with `AMBIGUITY_DELTA_THRESHOLD = 0.10` and `makeDecision(scored: ScoredCandidate[], classification?): EngineDecision` — DELTA logic + Candidate mapping + `classify()` helper that extracts classification from top candidate action. `classify()` is called by `index.ts` orchestrator and returns `classification` only when result is `'winner'` (tests DC-01→DC-19)

## Phase 3: Pipeline & Facade Updates

- [x] 3.1 Update `src/lib/rule-engine/pipeline.ts`: `produceCandidates` returns `PipelineArtifacts { rawCandidates, evaluations }`; `runPipeline` returns `PipelineArtifacts` instead of `Candidate[]` (tests PC-01→PC-07)
- [x] 3.2 Update `src/lib/rule-engine/conditions/entity.ts`: replace stub with real `evaluateEntityEq` reading `context.entityResolution` — `resolved` match, `not_found` → no match, `not_run` → throw `MissingEntityIdError` (tests EC-26→EC-31)
- [x] 3.3 Replace `entity_eq` evaluator implementation in `src/lib/rule-engine/conditions/entity.ts`. Keep it registered in the condition dispatch map — the dispatch path does NOT change, only the evaluator logic does
- [x] 3.4 Update `src/lib/rule-engine/index.ts`: add `discardInvalidConfiguration()` validation step; orchestrate 6 stages (pipeline → scoreCandidates → rankCandidates → makeDecision); add `InvalidPipelineStateError`, `MissingEntityIdError`, `EngineDecision`, `DecisionType`, `DecisionResult`, `EntityResolution`, `EntityResolutionStatus` to barrel exports (tests ER-01→ER-16)

## Phase 4: Tests

- [x] 4.1 Write `__tests__/ranking.test.ts` — 12 lexicographic sort tests (RK-01→RK-12)
- [x] 4.2 Write `__tests__/decision.test.ts` — 19 DELTA + Candidate mapping tests (DC-01→DC-19)
- [x] 4.3 Update `__tests__/pipeline.test.ts`: fix return type assertions for `PipelineArtifacts`; add `RawCandidate` shape tests (PC-01→PC-07); add `discardInvalid` tests (DI-01→DI-05)
- [x] 4.4 Update `__tests__/conditions/entity.test.ts`: replace 3 stub tests with 6 real `entity_eq` tests (EC-26→EC-31)
- [x] 4.5 Update `__tests__/conditions/dispatch.test.ts`: `entity_eq` no longer throws `UnsupportedConditionError`
- [x] 4.6 Update `__tests__/index.test.ts`: add 8 new tests for decision, orchestration, entityResolution, discardInvalidConfiguration integration (ER-07→ER-16)
- [x] 4.7 Write 11 integration tests in `pipeline.test.ts` (INT-01→INT-11) — full 5-stage pipeline flow
- [x] 4.8 Verify: `npx vitest run` exits 0, `npx tsc --noEmit` passes

## Dependency Graph

```
Phase 1 (types, errors, fixtures)
  ├──→ Phase 2 (specificity, scoring, ranking, decision)
  │     └──→ Phase 3 (pipeline updates, entity_eq, index orchestration)
  │           └──→ Phase 4 (tests)
  └──→ Phase 4 also depends on Phase 2 + 3 for test subject
```

Phase 1 has zero deps (pure additions). Phase 2 depends on Phase 1 types. Phase 3 depends on Phase 2 modules. Phase 4 depends on Phases 1-3.

## Rollback Strategy

| Phase | Rollback | Feature Flag Safe |
|-------|----------|-------------------|
| F1 (Foundation) | Revert commit | Yes — new types not used until Phase 2 |
| F2 (Core Modules) | Revert commit | Yes — modules not wired until Phase 3 |
| F3 (Pipeline & Facade) | Revert commit | Yes — `isRuleEngineV2Enabled()` gates full flow |
| F4 (Tests) | Revert commit | Yes — tests only |

The feature flag (`RULE_ENGINE_V2_ENABLED`) gates the entire Sprint 2 behavior. If disabled, `evaluateRules` returns `{ candidates: [], decision: undefined }` — unchanged from Sprint 1. All phases are safe to deploy incrementally with the flag off.

## Definition of Done

| Phase | DoD |
|-------|-----|
| 1 | All new types compile; error hierarchy validated via tests |
| 2 | Each new module passes its unit tests; `tsc --noEmit` clean |
| 3 | Full pipeline returns `RuleOutput` with populated `decision`; `PipelineArtifacts` no longer escapes the internal API; entity_eq handles all 3 resolution states |
| 4 | All ~136 tests pass; `npx vitest run` exits 0; `npx tsc --noEmit` clean; `npm run build` successful |
