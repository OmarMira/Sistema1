# Sprint 2 — Test Strategy: Specificity, Ranking & Decision Engine

## 1. Testing Pyramid

| Level | Tools | Count | Focus |
|---|---|---|---|
| Unit (Vitest) | `vitest` | ~112 | Individual functions: specificity computation, match quality formula, lexicographic sort, DELTA decision logic, entity_eq (real), error constructors |
| Integration | `vitest` | ~10 | Full pipeline: `runPipeline(RuleInput) → PipelineArtifacts` + `scoreCandidates → rankCandidates → makeDecision → RuleOutput` |
| Property-based | — | 0 | Omitting in Sprint 2 (same decision as Sprint 1); defer to Sprint 3+ |
| E2E | N/A | 0 | No E2E in Sprint 2 — pipeline is pure, no I/O, no DB, no HTTP |

**Total estimated tests: ~122**

---

## 2. Unit Tests

### 2.1 Test File: `specificity.test.ts` (NEW)

#### `computeSpecificity`

| # | Test Name | Scenario | Expected |
|---|---|---|---|
| SP-01 | entity_eq maps to tier 5 weight 500 | Single condition `entity_eq` matched | `{ highestTier: 5, weightWithinTier: 500 }` |
| SP-02 | description_eq maps to tier 4 weight 400 | Single condition `description_eq` matched | `{ highestTier: 4, weightWithinTier: 400 }` |
| SP-03 | amount_eq maps to tier 4 weight 380 | Single condition `amount_eq` matched | `{ highestTier: 4, weightWithinTier: 380 }` |
| SP-04 | description_matches maps to tier 3 weight 300 | Single condition `description_matches` matched | `{ highestTier: 3, weightWithinTier: 300 }` |
| SP-05 | description_starts_with maps to tier 2 weight 220 | Single condition `description_starts_with` matched | `{ highestTier: 2, weightWithinTier: 220 }` |
| SP-06 | description_ends_with maps to tier 2 weight 220 | Single condition `description_ends_with` matched | `{ highestTier: 2, weightWithinTier: 220 }` |
| SP-07 | amount_range maps to tier 2 weight 200 | Single condition `amount_range` matched | `{ highestTier: 2, weightWithinTier: 200 }` |
| SP-08 | description_contains maps to tier 1 weight 120 | Single condition `description_contains` matched | `{ highestTier: 1, weightWithinTier: 120 }` |
| SP-09 | amount_gt maps to tier 1 weight 100 | Single condition `amount_gt` matched | `{ highestTier: 1, weightWithinTier: 100 }` |
| SP-10 | amount_gte maps to tier 1 weight 100 | Single condition `amount_gte` matched | `{ highestTier: 1, weightWithinTier: 100 }` |
| SP-11 | amount_lt maps to tier 1 weight 100 | Single condition `amount_lt` matched | `{ highestTier: 1, weightWithinTier: 100 }` |
| SP-12 | amount_lte maps to tier 1 weight 100 | Single condition `amount_lte` matched | `{ highestTier: 1, weightWithinTier: 100 }` |
| SP-13 | date_before maps to tier 1 weight 50 | Single condition `date_before` matched | `{ highestTier: 1, weightWithinTier: 50 }` |
| SP-14 | date_after maps to tier 1 weight 50 | Single condition `date_after` matched | `{ highestTier: 1, weightWithinTier: 50 }` |
| SP-15 | highest tier only — lower tiers excluded | entity_eq (tier 5) + amount_gt (tier 1) matched | `{ highestTier: 5, weightWithinTier: 500 }` — amount_gt does NOT contribute |
| SP-16 | highest tier only — multiple same-tier summed | description_eq (tier 4, weight 400) + amount_eq (tier 4, weight 380) | `{ highestTier: 4, weightWithinTier: 780 }` |
| SP-17 | empty conditions array | `[]` | `{ highestTier: 0, weightWithinTier: 0 }` |
| SP-18 | unmatched conditions contribute zero | Single unmatched condition | `{ highestTier: 0, weightWithinTier: 0 }` (condition not matched → not counted) |
| SP-19 | multi-tier — only highest tier counts, lower ignored | entity_eq (tier 5, 500) + amount_gte (tier 1, 100) + description_contains (tier 1, 120) | `{ highestTier: 5, weightWithinTier: 500 }` — tier 1 conditions contribute nothing |

### 2.2 Test File: `scoring.test.ts` (NEW)

#### `scoreCandidates`

| # | Test Name | Scenario | Expected |
|---|---|---|---|
| SQ-01 | valid PipelineArtifacts produces ScoredCandidate[] | 1 RawCandidate with matching evaluation entry | Array of 1 ScoredCandidate with specificityScore and matchQuality populated |
| SQ-02 | missing evaluation entry throws InvalidPipelineStateError | RawCandidate.ruleId not found in evaluations map | Throws `InvalidPipelineStateError` with code `ERR_INVALID_PIPELINE_STATE` |
| SQ-03 | RawCandidate fields preserved in ScoredCandidate | ruleId, priority, conditionScores, action | All fields copied to ScoredCandidate unchanged |
| SQ-04 | empty rawCandidates returns empty array | `PipelineArtifacts { rawCandidates: [], evaluations: new Map() }` | `[]` |
| SQ-05 | multiple candidates scored independently | 2 RawCandidates with different conditions | 2 ScoredCandidates, each with own specificityScore and matchQuality |

#### `computeMatchQuality`

| # | Test Name | Scenario | Expected |
|---|---|---|---|
| SQ-06 | single score returns that score | `scores = [0.8]` | `matchQuality = 0.8` |
| SQ-07 | all equal scores returns that score | `scores = [0.5, 0.5, 0.5]` | `matchQuality = 0.5` |
| SQ-08 | mixed scores uses formula | `scores = [0.2, 0.8, 0.5]` → min=0.2, avg=0.5 | `0.2 + 0.25 * (0.5 - 0.2) = 0.275` |
| SQ-09 | alpha=0.25 blending (not average, not min) | `scores = [0.1, 1.0]` → min=0.1, avg=0.55 | `0.1 + 0.25 * (0.55 - 0.1) = 0.2125` |
| SQ-10 | edge: all zeros | `scores = [0, 0, 0]` | `0` |
| SQ-11 | edge: all ones | `scores = [1, 1, 1]` | `1` |
| SQ-12 | edge: empty scores (defensive) | `scores = []` | Returns `0` |

### 2.3 Test File: `ranking.test.ts` (NEW)

#### `rankCandidates`

| # | Test Name | Scenario | Expected |
|---|---|---|---|
| RK-01 | sort by highestTier descending | A: tier 3, B: tier 5, C: tier 1 | B, A, C |
| RK-02 | same tier → sort by weightWithinTier descending | Both tier 4: A: weight 400, B: weight 380 | A, B |
| RK-03 | same specificity → sort by matchQuality descending | Same `{ tier: 3, weight: 300 }`: A: mq=0.8, B: mq=0.5 | A, B |
| RK-04 | same specificity + quality → sort by priority ascending | Same spec+mq: A: priority 1, B: priority 5 | A, B (lower priority first) |
| RK-05 | same everything → deterministic by ruleId | All fields identical: A ruleId="rule-alpha", B ruleId="rule-beta" | "rule-alpha", "rule-beta" (ascending) |
| RK-06 | empty array | `[]` | `[]` |
| RK-07 | single element | `[scoredA]` | `[scoredA]` |
| RK-08 | stable sort — does not mutate input | Call rankCandidates, assert input unchanged | Input array not mutated |
| RK-09 | real-world lexicographic cascade | 5 candidates with varying tiers, weights, qualities, priorities | Correctly ordered per all 5 keys |
| RK-10 | priority dominance at same specificity | Same spec+mq: priorities [10, 3, 1] | priority 1, priority 3, priority 10 (ascending) |
| RK-11 | ranking transitivity — A > B, B > C ⇒ A > C | A (tier 5), B (tier 3), C (tier 1) | A > B > C — relative order must be transitive across all pairs |
| RK-12 | ranking idempotence — running twice yields same order | 5 candidates with varied spec, quality, priority | Second call produces identical ordering as first |

### 2.4 Test File: `decision.test.ts` (NEW)

#### `makeDecision`

| # | Test Name | Scenario | Expected |
|---|---|---|---|
| DC-01 | zero candidates → no_match | `scored=[]` | `{ result: 'no_match', ruleId: undefined, explanation: 'No matching rules found' }` |
| DC-02 | one candidate → winner | Single scored candidate | `{ result: 'winner', ruleId: scored[0].ruleId, explanation: 'Single candidate' }` |
| DC-03 | two candidates, different highestTier → winner | A: tier 5, B: tier 3 | Winner A, explanation contains "specificity tier" |
| DC-04 | two candidates, same tier, different weight → winner | Both tier 4: A: weight 400, B: weight 380 | Winner A, explanation contains "specificity weight" |
| DC-05 | two candidates, identical spec, DELTA >= 0.10 → winner | Both `{ tier: 3, weight: 300 }`: A: mq=0.80, B: mq=0.65 → DELTA=0.15 | Winner A, explanation contains "DELTA" and "exceeds threshold" |
| DC-06 | two candidates, identical spec, DELTA < 0.10 → ambiguous | Both `{ tier: 3, weight: 300 }`: A: mq=0.72, B: mq=0.68 → DELTA=0.04 | `{ result: 'ambiguous', ruleId: undefined }` |
| DC-07 | two candidates, DELTA == 0.1000 exactly → winner (boundary) | Both `{ tier: 3, weight: 300 }`: A: mq=0.75, B: mq=0.65 → DELTA=0.1000 | Winner A — `>= 0.10` includes exact threshold |
| DC-08 | two candidates, DELTA == 0.0999 → ambiguous (boundary) | Both `{ tier: 3, weight: 300 }`: A: mq=0.7499, B: mq=0.65 → DELTA=0.0999 | `{ result: 'ambiguous' }` — just below threshold |
| DC-09 | two candidates, DELTA == 0.1001 → winner (boundary) | Both `{ tier: 3, weight: 300 }`: A: mq=0.7501, B: mq=0.65 → DELTA=0.1001 | Winner A — just above threshold |
| DC-10 | Candidate mapping: ruleId preserved | scored[0].ruleId = "rule-123" | Candidate.ruleId = "rule-123" |
| DC-11 | Candidate mapping: conditionScores preserved | scored.conditionScores = [1, 0.5] | Candidate.conditionScores = [1, 0.5] |
| DC-12 | Candidate mapping: priority preserved | scored.priority = 3 | Candidate.priority = 3 |
| DC-13 | Candidate.specificity = weightWithinTier (compatibility) | scored.specificityScore = `{ tier: 4, weight: 400 }` | Candidate.specificity = 400 |
| DC-14 | Candidate.matchQuality preserved | scored.matchQuality = 0.275 | Candidate.matchQuality = 0.275 |
| DC-15 | Candidate.confidence = 0 | Any scored candidate | Candidate.confidence === 0 |
| DC-16 | classification populated only when winner | winner scenario | classification populated from top candidate's action |
| DC-17 | classification undefined when ambiguous/no_match | ambiguous or no_match scenario | classification undefined |
| DC-18 | highestTier NOT serialized in Candidate | scored.specificityScore = `{ highestTier: 4, weight: 400 }` | Candidate has NO `.highestTier` — only `.specificity` (= 400) |
| DC-19 | EngineDecision.ruleId matches top candidate when winner | 2 candidates: A (tier 5), B (tier 3) | EngineDecision.ruleId === A.ruleId (winner, not B) |

### 2.5 Test File: `conditions/entity.test.ts` (UPDATED)

| # | Test Name | Scenario | Expected |
|---|---|---|---|
| EC-26 | entity_eq with resolved status and matching entityId → match | `entityResolution={ status: 'resolved', entityId: 'ent-123' }`, condition.value='ent-123' | `match=true, score=1` |
| EC-27 | entity_eq with resolved status and non-matching entityId → no match | `entityResolution={ status: 'resolved', entityId: 'ent-123' }`, condition.value='ent-456' | `match=false, score=0` |
| EC-28 | entity_eq with not_found status → no match | `entityResolution={ status: 'not_found' }` | `match=false, score=0` |
| EC-29 | entity_eq with not_run status → throws MissingEntityIdError | `entityResolution={ status: 'not_run' }` | Throws `MissingEntityIdError` with conditionType === 'entity_eq' |
| EC-30 | entity_eq includes conditionType in error | Trigger MissingEntityIdError | Error `.conditionType === 'entity_eq'` |
| EC-31 | entity_eq does NOT expose transaction data in error | Trigger MissingEntityIdError | Error `.details` does NOT contain transaction or rule data |

### 2.6 Test File: `pipeline.test.ts` (UPDATED)

#### `produceCandidates` (updated)

| # | Test Name | Scenario | Expected |
|---|---|---|---|
| PC-01 | produces PipelineArtifacts with RawCandidate[] | 1 entry with 3 conditions | `PipelineArtifacts { rawCandidates: [RawCandidate], evaluations: Map }` |
| PC-02 | RawCandidate has no ranking data | Check RawCandidate shape | No `specificity`, `matchQuality`, or `confidence` fields |
| PC-03 | evaluations map keyed by ruleId | 1 entry → evaluations has 1 entry with ruleId as key | Map key matches ruleId |
| PC-04 | conditionScores copied from evaluations | scores=[1, 0.5, 0] | RawCandidate.conditionScores = [1, 0.5, 0] |
| PC-05 | action preserved in RawCandidate | BankRule with action populated | RawCandidate.action matches BankRule.action |
| PC-06 | empty entries | `[]` | `PipelineArtifacts { rawCandidates: [], evaluations: new Map() }` |
| PC-07 | multiple entries | 3 entries | 3 RawCandidates, 3 evaluations entries |

#### `discardInvalid` (updated)

| # | Test Name | Scenario | Expected |
|---|---|---|---|
| DI-01 | all conditions match survives | 3 conditions, all match=true | Entry kept |
| DI-02 | one condition fails discards entry | 3 conditions, 2 match=true, 1 match=false | Entry removed |
| DI-03 | empty entries | `[]` | `[]` |
| DI-04 | multiple entries some fail | 5 entries, 2 have failing conditions | 3 entries returned |
| DI-05 | no mutation of input | Run discardInvalid, assert input unchanged | Input array unchanged |

**Existing Sprint 1 tests that remain unchanged**: UC-01 through UC-06 (collectCandidates), EC-01 through EC-25 (condition evaluators except entity_eq), DI-01 through DI-04 (discardInvalid), PC-01 through PC-05 (produceCandidates now returns PipelineArtifacts).

### 2.7 Test File: `index.test.ts` (UPDATED)

#### `evaluateRules`

| # | Test Name | Scenario | Expected |
|---|---|---|---|
| ER-01 | feature flag disabled → returns empty | `isRuleEngineV2Enabled()=false` | `{ candidates: [], decision: undefined }`, pipeline never called |
| ER-02 | missing transaction throws MissingTransaction | `input.transaction=undefined` | Throws `MissingTransaction` with code `ERR_MISSING_TRANSACTION` |
| ER-03 | missing context throws MissingContext | `input.context=undefined` | Throws `MissingContext` |
| ER-04 | missing availableRules throws MissingContext | `input.context.availableRules=undefined` | Throws `MissingContext` |
| ER-05 | transaction missing id throws InvalidTransaction | `transaction.id=""` | Throws `InvalidTransaction` |
| ER-06 | transaction missing companyId throws InvalidTransaction | `transaction.companyId=""` | Throws `InvalidTransaction` |
| ER-07 | valid input with candidates → RuleOutput with decision | Valid input, flag enabled, 1 matching rule | Returns `RuleOutput` with `candidates` length > 0 and `decision.result === 'winner'` |
| ER-08 | condition error propagates | Rule with invalid regex | Throws `InvalidRegex` |
| ER-09 | valid input, no candidates → no_match decision | Valid input, no rules match | `decision.result === 'no_match'` |
| ER-10 | pipeline → scoreCandidates → rankCandidates → makeDecision flow | Pipeline returns RawCandidate[] | Scoring called, then ranking, then decision — correct stage order |
| ER-11 | empty conditions filtered by discardInvalidConfiguration | Rule with `conditions: []` | Rule excluded, not evaluated |
| ER-12 | entityResolution not_run with entity_eq condition → MissingEntityIdError propagates | entity_eq condition, `entityResolution.status='not_run'` | `MissingEntityIdError` thrown, not swallowed |
| ER-13 | entityResolution resolved with entity_eq → winner decision | entity_eq matches, all other conditions pass | decision.result === 'winner' |
| ER-14 | PipelineArtifacts flow through all stages | Mock the 3 stage functions | Each stage called with correct arguments from previous stage output |
| ER-15 | valid input with ambiguous result | 2 candidates, identical spec, DELTA < 0.10 | `decision.result === 'ambiguous'` |
| ER-16 | classification populated from top candidate action | Winner scenario, top candidate has action.category | EngineDecision.classification.category set |

### 2.8 Test File: `errors.test.ts` (UPDATED)

| # | Test Name | Scenario | Expected |
|---|---|---|---|
| ERR-01 | RuleEngineError is Error subclass | `new RuleEngineError("msg","ERR")` | `instanceof Error`, `instanceof RuleEngineError` |
| ERR-02 | RuleEngineError has code property | Constructor with code | `.code === "ERR"` |
| ERR-03 | RuleEngineError has details property | Constructor with details | `.details` matches input |
| ERR-04 | MissingTransaction sets correct code | Constructor | `.code === "ERR_MISSING_TRANSACTION"` |
| ERR-05 | MissingContext sets correct code | Constructor | `.code === "ERR_MISSING_CONTEXT"` |
| ERR-06 | InvalidTransaction sets correct code | Constructor | `.code === "ERR_INVALID_TRANSACTION"` |
| ERR-07 | InvalidRegex has conditionType | Constructor | `.conditionType === 'description_matches'` |
| ERR-08 | InvalidNumericValue has conditionType | Constructor | `.conditionType === 'amount_gt'` |
| ERR-09 | InvalidDateValue has conditionType | Constructor | `.conditionType === 'date_before'` |
| ERR-10 | InvalidInputError is instanceof RuleEngineError | Chain | `err instanceof InvalidInputError && err instanceof RuleEngineError` |
| ERR-11 | ConditionEvalError is instanceof RuleEngineError | Chain | `err instanceof ConditionEvalError && err instanceof RuleEngineError` |
| ERR-12 | UnsupportedConditionError sets correct code | Constructor | `.code === "ERR_UNSUPPORTED_CONDITION"` |
| ERR-13 | MissingEntityIdError sets correct code | Constructor | `.code === "ERR_MISSING_ENTITY_ID"` |
| ERR-14 | MissingEntityIdError extends ConditionEvalError | Chain | `err instanceof MissingEntityIdError && err instanceof ConditionEvalError` |
| ERR-15 | MissingEntityIdError has conditionType | Constructor | `.conditionType === 'entity_eq'` |
| ERR-16 | InvalidPipelineStateError sets correct code | Constructor | `.code === "ERR_INVALID_PIPELINE_STATE"` |
| ERR-17 | InvalidPipelineStateError extends RuleEngineError | Chain | `err instanceof InvalidPipelineStateError && err instanceof RuleEngineError` |
| ERR-18 | InvalidPipelineStateError does NOT extend ConditionEvalError | Chain | `err instanceof InvalidPipelineStateError && !(err instanceof ConditionEvalError)` |
| ERR-19 | UnknownConditionTypeError sets correct code | Constructor | `.code === "ERR_UNKNOWN_CONDITION_TYPE"` |
| ERR-20 | UnknownConditionTypeError has conditionType | Constructor | `.conditionType === 'foo_bar'` |

---

## 3. Integration Tests

### 3.1 Test File: `pipeline.test.ts` (integration section)

| # | Test Name | Scenario | Expected |
|---|---|---|---|
| INT-01 | full pipeline valid input → winner decision | 3 active rules, 2 match, 1 fails, entity_eq not involved | `RuleOutput` with 2 candidates, `decision.result === 'winner'` |
| INT-02 | full flow with entity_eq matching → winner | entity_eq condition with resolved entity, match=true | decision.result === 'winner', ruleId set |
| INT-03 | full flow with entity_eq not matching → condition fails, rule discarded | entity_eq condition with resolved entity, match=false | candidate count = 0, decision.result === 'no_match' |
| INT-04 | full flow with ambiguity (2 candidates, identical spec, DELTA < 0.10) → ambiguous | 2 rules with same condition type + tier + weight, very close matchQuality | `decision.result === 'ambiguous'` |
| INT-05 | full flow with no candidates → no_match | Zero matching rules | `decision.result === 'no_match'` |
| INT-06 | full flow with mixed specificity → winner by highestTier | entity_eq rule (tier 5) vs description_contains rule (tier 1) | Winner is entity_eq rule |
| INT-07 | full flow with same tier diff weight → winner by weight | Both tier 4: description_eq (weight 400) vs amount_eq (weight 380) | Winner is description_eq |
| INT-08 | evaluateRules integrates with full pipeline | `evaluateRules(validInput)` | Returns `{ candidates: [1-2 entries], decision: { result: 'winner' } }` |
| INT-09 | discardInvalidConfiguration filters empty conditions before pipeline | Rule with `conditions: []` in availableRules | Rule excluded, no candidate produced |
| INT-10 | entity_eq not_run propagates MissingEntityIdError through full flow | entity_eq condition, entityResolution.status='not_run' | `MissingEntityIdError` thrown |
| INT-11 | large-scale — 15 rules with varied specificity, quality, priority → correct ranking and winner | 15 rules across all tiers, some identical spec with DELTA < 0.10 | Top-2 ranked correctly by all 5 keys; decision is winner or ambiguous per DELTA |

---

## 4. Property-Based Tests

**Omitted from Sprint 2** (same decision as Sprint 1). Unit and integration tests provide sufficient coverage for Sprint 2's scope. Property-based tests (determinism, transitivity, invariants) are deferred to Sprint 3+.

---

## 5. Test Fixtures & Factories

### 5.1 File: `src/lib/rule-engine/__tests__/fixtures.ts` (UPDATED)

```typescript
// Existing Sprint 1 factories (unchanged):
export function makeRule(overrides?: Partial<BankRule>): BankRule;
export function makeTransaction(overrides?: Partial<Transaction>): Transaction;
export function makeCondition(
  type: RuleConditionType,
  value: string | number,
  range?: [number, number]
): RuleCondition;
export function makeEvaluatedCondition(
  overrides?: Partial<EvaluatedCondition>
): EvaluatedCondition;

// Updated: entityResolution added to makeRuleInput
export function makeRuleInput(overrides?: Partial<RuleInput>): RuleInput;
//   Now generates: context.entityResolution with default { status: 'not_run' }

// NEW Sprint 2 factories:
export function makeRawCandidate(overrides?: Partial<RawCandidate>): RawCandidate;
export function makeScoredCandidate(overrides?: Partial<ScoredCandidate>): ScoredCandidate;
export function makeSpecificityScore(overrides?: Partial<SpecificityScore>): SpecificityScore;
export function makePipelineArtifacts(overrides?: Partial<PipelineArtifacts>): PipelineArtifacts;
export function makeEngineDecision(overrides?: Partial<EngineDecision>): EngineDecision;
export function makeEntityResolution(overrides?: Partial<EntityResolution>): EntityResolution;
```

### 5.2 Presets (UPDATED)

```typescript
export const presets = {
  // Existing presets (unchanged):
  oneActiveRule: BankRule,
  threeActiveRules: BankRule[],
  mixedLifecycleRules: BankRule[],
  validTransaction: Transaction,
  validRuleInput: RuleInput,            // now includes entityResolution
  emptyRuleInput: RuleInput,
  invoiceScenarioRule: BankRule,

  // NEW Sprint 2 presets:
  ruleWithEntityCondition: BankRule,        // entity_eq with value='ent-123'
  entityResolved: EntityResolution,        // { status: 'resolved', entityId: 'ent-123' }
  entityNotFound: EntityResolution,        // { status: 'not_found' }
  entityNotRun: EntityResolution,          // { status: 'not_run' }
  twoIdenticalSpecCandidates: ScoredCandidate[],  // same tier, same weight, close quality
  highLowTierCandidates: ScoredCandidate[],        // one tier 5, one tier 1
  ambiguousScenarioInput: RuleInput,        // input designed to produce ambiguous result
  winnerScenarioInput: RuleInput,           // input designed to produce clear winner
};
```

---

## 6. Test File Organization

```
src/lib/rule-engine/
├── __tests__/
│   ├── fixtures.ts                # Factory functions + presets (updated: entityResolution, new factories)
│   ├── conditions/
│   │   ├── amount.test.ts         # Unchanged from Sprint 1
│   │   ├── description.test.ts    # Unchanged from Sprint 1
│   │   ├── date.test.ts           # Unchanged from Sprint 1
│   │   ├── entity.test.ts         # Updated: real entity_eq, not stub (EC-26→EC-31)
│   │   └── dispatch.test.ts       # Updated: entity_eq no longer throws UnsupportedConditionError
│   ├── pipeline.test.ts           # Updated: returns PipelineArtifacts; + discardInvalidConfiguration tests
│   ├── index.test.ts              # Updated: decision populated, entityResolution validation, stage orchestration
│   ├── errors.test.ts             # + MissingEntityIdError (ERR-13→ERR-15), InvalidPipelineStateError (ERR-16→ERR-18)
│   ├── specificity.test.ts        # NEW: specificity tier computation (SP-01→SP-18)
│   ├── scoring.test.ts            # NEW: scoreCandidates + computeMatchQuality (SQ-01→SQ-12)
│   ├── ranking.test.ts            # NEW: lexicographic sort (RK-01→RK-10)
│   └── decision.test.ts           # NEW: DELTA logic + Candidate production (DC-01→DC-14)
├── pipeline.ts
├── index.ts
├── errors.ts
├── types.ts
├── flag.ts
├── specificity.ts                 # NEW
├── scoring.ts                     # NEW
├── ranking.ts                     # NEW
└── decision.ts                    # NEW
```

---

## 7. DoD Coverage Mapping

Each DoD item from `01-scope.md` maps to specific tests:

| # | DoD | Tests |
|---|---|---|
| 1 | `computeSpecificity` mapea cada type de condición a tier y weight correctos | SP-01→SP-14 |
| 2 | Solo el tier más alto contribuye a `weightWithinTier` | SP-15, SP-16, SP-19 |
| 3 | Condiciones no matcheadas contribuyen 0 | SP-18 |
| 4 | `scoreCandidates` produce `ScoredCandidate[]` desde `PipelineArtifacts` | SQ-01, SQ-04, SQ-05 |
| 5 | Missing evaluation entry → `InvalidPipelineStateError` | SQ-02 |
| 6 | `computeMatchQuality` usa fórmula `min + 0.25 * (avg - min)` | SQ-06→SQ-12 |
| 7 | `rankCandidates` ordena por 5 keys lexicográficas | RK-01→RK-12 |
| 8 | `makeDecision` produce correcto `EngineDecision` según top-2 | DC-01→DC-09 |
| 9 | DELTA threshold 0.10 para ambigüedad | DC-05→DC-09 |
| 10 | `Candidate` mapping preserva campos, specificity=weightWithinTier, confidence=0 | DC-10→DC-15 |
| 10b | `highestTier` NO serializado en Candidate | DC-18 |
| 10c | EngineDecision.ruleId solo presente cuando winner | DC-19 |
| 11 | `entity_eq` real: `resolved` con match → match true | EC-26 |
| 12 | `entity_eq` real: `resolved` sin match → match false | EC-27 |
| 13 | `entity_eq` real: `not_found` → match false | EC-28 |
| 14 | `entity_eq` real: `not_run` → `MissingEntityIdError` | EC-29, EC-30, EC-31 |
| 15 | `PipelineArtifacts` reemplaza `Candidate[]` como retorno de pipeline | PC-01→PC-07 |
| 16 | `RawCandidate` no contiene ranking data | PC-02 |
| 17 | `discardInvalidConfiguration` filtra `conditions: []` previo al pipeline | ER-11, INT-09 |
| 18 | `index.ts` orquesta 5 etapas en orden | ER-10, ER-14, ER-15, ER-16, INT-01→INT-11 |
| 19 | `MissingEntityIdError` error code correcto, extiende `ConditionEvalError` | ERR-13, ERR-14, ERR-15 |
| 20 | `InvalidPipelineStateError` error code correcto, extiende `RuleEngineError` (NO `ConditionEvalError`) | ERR-16, ERR-17, ERR-18 |
| 21 | Feature flag false → `{ candidates: [], decision: undefined }` | ER-01 |
| 22 | Todos los tests pasan | CI gate — `npx vitest run` must exit 0 |
| 23 | `tsc --noEmit` sin errores | TypeScript check in CI (separate from tests) |
| 24 | `npm run build` exitoso | Build step in CI (separate from tests) |

---

## 8. What NOT to Test in Sprint 2

- Audit logging → Sprint 3
- AI fallback → not in scope
- Historical match ranking → future sprint
- Performance / load tests → Sprint 3+
- `confidence` computation (still `0`) → Sprint 3+
- UI components → Frontend sprint
- Persistence / DB → Pipeline is pure
- HTTP / Next.js API routes → Pipeline is pure
- `fast-check` / property-based tests → Same decision as Sprint 1; unit + integration suffice
- `RuleLifecycleStatus` values beyond those filtered by Step 1 → covered by types
- `entityContexts` / `historicalMatches` usage → reserved, not used
- `UnsupportedConditionError` class removal → class stays exported for future use
- Regex engine behavior for `description_matches` → trust `RegExp`
- `engineVersion` metadata in output → Sprint 3
- `DecisionType` values beyond `'rule'` → reserved for future sprints

---

## 9. Test Scripts & Config

### 9.1 Commands

| Command | Purpose |
|---|---|
| `npx vitest run` | Default: run all tests once (CI) |
| `npx vitest` | Watch mode (development) |
| `npx vitest run --coverage` | Coverage report |

### 9.2 Coverage Criteria (not a percentage target)

Coverage is a **result**, not a design requirement. The design guarantees:

1. **Pipeline público cubierto**: `evaluateRules` — flag gate, validación, 5-stage orchestration, decision output
2. **Todos los caminos felices y de error**: Cada tipo de condición de specificity, cada error posible (MissingEntityIdError, InvalidPipelineStateError)
3. **Nuevos módulos cubiertos**: `specificity.ts`, `scoring.ts`, `ranking.ts`, `decision.ts` — todas las funciones públicas e internas
4. **Cada camino de DELTA**: Spec identical → winner (DELTA ≥ 0.10) y ambiguous (DELTA < 0.10)
5. **Cada estado de EntityResolution**: `resolved` (match y no match), `not_found`, `not_run`
6. **Todos los criterios de aceptación del Sprint con al menos un test** (ver §7)

Si después de implementar eso la cobertura es 82%, 91% o 97%, es correcto. No se persigue un número arbitrario.

### 9.3 Config Changes (only what's needed)

No configuration changes needed from Sprint 1. The existing `vitest.config.ts` and include pattern already cover all `*.test.ts` files under `src/lib/rule-engine/__tests__/`.

### 9.4 Excluded files from coverage

| File | Reason |
|---|---|
| `__tests__/**` | Test code should never count toward coverage |
| `types.ts` | Types-only — no executable code |
| `compat.ts` | Historical notes, no runtime code |

---

## 10. Test Count Summary

| Category | File | Count |
|---|---|---|
| Unit — specificity | `specificity.test.ts` | 19 |
| Unit — ranking | `ranking.test.ts` | 12 |
| Unit — decision | `decision.test.ts` | 19 |
| Unit — conditions | `conditions/entity.test.ts` | 6 (+3 vs Sprint 1 — entity_eq real) |
| Unit — conditions | `conditions/dispatch.test.ts` | 1 (entity_eq no longer throws) |
| Unit — pipeline steps | `pipeline.test.ts` | ~20 (+3 vs Sprint 1 — RawCandidate, PipelineArtifacts) |
| Unit — evaluateRules | `index.test.ts` | ~16 (+8 vs Sprint 1 — decision, orchestration, entityResolution) |
| Unit — errors | `errors.test.ts` | ~20 (+5 vs Sprint 1 — MissingEntityIdError, InvalidPipelineStateError) |
| Integration | `pipeline.test.ts` | 11 |
| Property-based | (omitted) | 0 |
| **Total** | | **~136** |

---

## 11. Resolved Design Decisions

| Decisión | Resolución |
|---|---|
| **`fast-check` en Sprint 2** | No se agrega. Tests unitarios e integración alcanzan para este sprint. Misma decisión que Sprint 1. |
| **`computeSpecificity` con conditions vacías** | Retorna `{ highestTier: 0, weightWithinTier: 0 }`. No debe lanzar error. |
| **`computeMatchQuality` con scores vacíos** | Defensivo: retorna `0`. No debe crashear. `discardInvalidConfiguration` previene este caso en producción. |
| **`scoreCandidates`: rawCandidate sin evaluación correspondiente** | Lanza `InvalidPipelineStateError`. Es una violación del contrato entre pipeline y scoring engine. |
| **`rankCandidates`: mutación del input** | No debe mutar. Retorna un nuevo array ordenado. El input original queda intacto. |
| **`Candidate.specificity`** | Es un campo derivado de compatibilidad = `weightWithinTier`. No es autoritativo para ranking. Marcado como deprecado. |
| **`Candidate.confidence`** | Sigue siendo `0`. No se implementa en Sprint 2. |
| **`classification` en EngineDecision** | Solo se popula cuando `result === 'winner'`. En `ambiguous` y `no_match` queda undefined. |
| **DELTA threshold** | `AMBIGUITY_DELTA_THRESHOLD = 0.10`. Constante global, no configurable por compañía. |
| **`MissingEntityIdError` extiende `ConditionEvalError`** | Porque es lanzado por el evaluador `entity_eq` durante la evaluación y lleva `conditionType`. |
| **`InvalidPipelineStateError` es direct child de `RuleEngineError`** | NO extiende `ConditionEvalError`. Es un error arquitectónico de estado, no de evaluación de condiciones. |
| **`UnsupportedConditionError` class** | No se remueve. Sigue exportada para futuros límites de scope donde sea necesaria. `entity_eq` ya no la lanza. |

---

## 12. Unit vs Integration Boundary

Sprint 2 modules se testean en dos capas:

- **Unitario**: Cada módulo nuevo se prueba independientemente — `specificity.test.ts`, `scoring.test.ts`, `ranking.test.ts`, `decision.test.ts`. `entity_eq` se prueba en `conditions/entity.test.ts`.
- **Integración**: El pipeline completo de 5 etapas se prueba en la sección de integración de `pipeline.test.ts` — desde `evaluateRules` hasta `RuleOutput` con `decision` poblado.

Las etapas intermedias (`scoreCandidates`, `rankCandidates`, `makeDecision`) también se verifican en los tests de `index.test.ts` mediante el flujo de `evaluateRules`, asegurando que `index.ts` las orquesta correctamente.

Ambas capas se mantienen. No es duplicación — la capa unitaria aísla bugs de cada etapa, la capa de integración verifica el wiring correcto entre etapas y la capa de `index.test.ts` verifica la orquestación desde el entry point público.
