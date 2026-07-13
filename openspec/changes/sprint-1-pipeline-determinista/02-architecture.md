# Architecture — Sprint 2: Specificity, Ranking & Decision Engine

## Technical Approach

Pure function pipeline: no classes, no state, no side effects. Sprint 2 extends the deterministic pipeline with a Scoring Engine, Ranking Engine, and Decision Engine as separate stages that transform `RawCandidate[]` → `ScoredCandidate[]` → sorted `ScoredCandidate[]` → `RuleOutput` with a populated `decision`.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Architecture pattern | Pure function composition | Class-based Engine, Command pattern | Zero state guarantees determinism; trivial to test; no DI complexity |
| Stage separation | Pipeline → Scoring → Ranking → Decision | All-in-one monolithic flow | Each stage has a clear responsibility boundary; easier to test, audit, and evolve independently |
| Module granularity | One file per stage (specificity, scoring, ranking, decision) | Keep everything in pipeline.ts | Each stage has distinct logic and ~30-60 lines; separation aids testing and parallel work |
| Specificity model | Tier-based with highest-tier weight summation | Flat weight sum, combinatorial key | Reflects business intent: entity match dominates all other conditions; within-tier ties broken by sum |
| Candidate.specificity (legacy) | Derived compatibility field = `weightWithinTier`, deprecated | Remove field, keep as 0 | Maintains API stability across sprints; field marked deprecated so callers migrate away; NOT authoritative for ranking |
| ScoredCandidate (internal) | `{ ruleId, specificityScore, matchQuality, priority, conditionScores, action }` | Wrap Candidate and cross-reference nested fields | Keeps Candidate public API stable; internal type is flat — all ranking data in one shape; no `.candidate.matchQuality` indirection |
| RawCandidate (internal) | Pipeline output before scoring | Produce Candidate directly with zeros | Avoids mutable Candidate; scoring engine only touches RawCandidate, never partially-built Candidate |
| Match quality formula | `min + 0.25 * (avg - min)` | Average-only, min-only, weighted arithmetic | Preserves conservative baseline (min) while rewarding breadth (avg lift); alpha=0.25 tuned for balance |
| Ranking | Lexicographic (5-key sort) | Weighted composite score, ML-based | Fully deterministic, transparent, and auditable; tiebreaker by ruleId guarantees stable ordering |
| Ambiguity detection | DELTA threshold on specificity-identical top-2 | Threshold on raw scores, no threshold | DELTA only fires when top-2 are structurally equivalent (same tiers, same weights), avoiding false positives |
| Decision result | Enum: `'winner' \| 'ambiguous' \| 'no_match'` | | Standard three-state outcome; no partial or probabilistic result in Sprint 2 |
| Rules with no conditions | Discarded in `discardInvalidConfiguration()` — a validation step before the pipeline | Throw error, treat as match-everything, filter in collectCandidates | Empty conditions make no semantic sense. Belongs to validation, not to business filtering. Prevents invalid configurations from entering the pipeline. |
| computeConfidence | **Removed from Sprint 2** | Placeholder step returning 0 | Adding a no-op step adds complexity without value; confidence will be defined and implemented in a dedicated sprint |
| index.ts role | Facade only — delegates to pipeline + scoring + ranking + decision.ts | Inline all logic | Keeps entry point thin; each stage lives in its own module |
| Error hierarchy | InvalidPipelineStateError and MissingEntityIdError as siblings under RuleEngineError | Parent-child relationship | The two errors represent distinct failure modes: pipeline not ready vs a required subsystem not executed |

## Data Flow

```
RuleInput
  │
  ▼
┌──────────────────────────────────────────────┐
│  Validation Layer                             │
│  ─────────────────                           │
│  discardInvalidConfiguration()                │
│    • rules with empty conditions[]  → remove  │
│    • rules with invalid data        → remove  │
│  Output: BankRule[] (pre-validated)          │
└───────────────────┬──────────────────────────┘
                    ▼
┌──────────────────────────────────────────────┐
│  Pipeline                                     │
│  Steps 1-4 (unchanged from Sprint 1)          │
│                                               │
│  1: collectCandidates                         │
│     Filter rules: isActive, companyId,        │
│     lifecycleStatus ∈ (active, testing)       │
│                                               │
│  2: evaluateConditions                        │
│     + entity_eq now reads from                │
│       context.entityResolution                │
│                                               │
│  3: discardInvalid                            │
│     Keep only rules where ALL conditions match │
│                                               │
│  4: produceCandidates                         │
│     Build RawCandidate[]                      │
│  Output: RawCandidate[]                       │
└───────────────────┬──────────────────────────┘
                    ▼
┌──────────────────────────────────────────────┐
│  Scoring Engine                               │
│  (specificity.ts + scoring.ts)                │
│                                               │
│  For each RawCandidate:                       │
│    5: computeSpecificity                      │
│       → SpecificityScore { highestTier,       │
│           weightWithinTier }                  │
│                                               │
│    6: computeMatchQuality                     │
│       matchQuality = min(scores)              │
│         + 0.25 * (avg(scores) - min(scores))  │
│                                               │
│  Produces ScoredCandidate[]                   │
│  Output: ScoredCandidate[]                    │
└───────────────────┬──────────────────────────┘
                    ▼
┌──────────────────────────────────────────────┐
│  Ranking Engine                               │
│  (ranking.ts)                                 │
│                                               │
│  7: rankCandidates                            │
│     Lexicographic sort on ScoredCandidate:    │
│     highestTier↓, weightWithinTier↓,          │
│     matchQuality↓, priority↑, ruleId          │
│                                               │
│  Output: ScoredCandidate[] (sorted)           │
└───────────────────┬──────────────────────────┘
                    ▼
┌──────────────────────────────────────────────┐
│  Decision Engine                              │
│  (decision.ts)                                │
│                                               │
│  8: makeDecision                              │
│     DELTA on top-2 with identical spec        │
│     → winner / ambiguous / no_match           │
│                                               │
│  Maps ScoredCandidate[] → Candidate[]:        │
│    Candidate.specificity = weightWithinTier   │
│      (derived compatibility field, deprecated) │
│    Candidate.matchQuality = scored.matchQuality│
│    Candidate.confidence = 0                   │
│                                               │
│  Output: RuleOutput { candidates, decision }  │
└──────────────────────────────────────────────┘
```

## Stage Boundaries

| Stage | Entry | Exit | Module(s) |
|---|---|---|---|
| Validation | `RuleInput` | Validated `RuleInput` | `index.ts` (or `validation.ts`) |
| Pipeline | Validated `RuleInput` | `RawCandidate[]` | `pipeline.ts` |
| Scoring | `RawCandidate[]` + `EvaluatedCondition[]` | `ScoredCandidate[]` | `specificity.ts`, `scoring.ts` |
| Ranking | `ScoredCandidate[]` | `ScoredCandidate[]` (sorted) | `ranking.ts` |
| Decision | `ScoredCandidate[]` (sorted) | `RuleOutput` | `decision.ts` |

## File Responsibilities

| File | Role | Public API |
|---|---|---|---|
| `index.ts` | Facade — feature flag, input validation, discards invalid configs, stage orchestration | `evaluateRules(input: RuleInput): RuleOutput` — now populates `decision` |
| `pipeline.ts` | Pipeline orchestrator (steps 1-4) | `runPipeline(input: RuleInput): RawCandidate[]` |
| `types.ts` | All type definitions | `RuleInput`, `RuleOutput`, `Candidate`, `RawCandidate` (internal), `ScoredCandidate` (internal), `EvaluatedCondition`, `BankRule`, `Transaction`, `EngineDecision`, `RuleCondition`, `RuleConditionType`, `SpecificityScore`, `EntityResolution`, `DecisionType`, `DecisionResult` |
| `errors.ts` | Error class hierarchy | + `MissingEntityIdError`, `InvalidPipelineStateError` |
| `flag.ts` | Feature flag | `isRuleEngineV2Enabled(): boolean` |
| `specificity.ts` | Specificity tier computation | `computeSpecificity(conditions: EvaluatedCondition[]): SpecificityScore` |
| `scoring.ts` | Match quality + scoring orchestration | `scoreCandidates(raw: RawCandidate[], evals: ...): ScoredCandidate[]` |
| `ranking.ts` | Lexicographic candidate sort | `rankCandidates(scored: ScoredCandidate[]): ScoredCandidate[]` |
| `decision.ts` | Decision Engine (DELTA threshold) | `makeDecision(scored: ScoredCandidate[], classification: Classification): RuleOutput` |
| `compat.ts` | Historical note (Sprint 0) | None (no runtime code) |

## Type Contracts

### New types introduced in Sprint 2

```typescript
// Internal ranking artifact — MUST NEVER be serialized or exposed through the public API
interface SpecificityScore {
  highestTier: number;       // 5..1 (5 = most specific)
  weightWithinTier: number;  // sum of condition weights at highestTier
}

// Pipeline output — preliminary candidate before scoring
// Pipeline never sees scoring, ranking, or decision types
// RawCandidate contains NO ranking data (no specificity, no matchQuality, no confidence)
interface RawCandidate {
  ruleId: string;
  conditionScores: number[];
  priority: number;
  action: {
    category?: string;
    entityId?: string;
    glAccountId?: string;
  };
}

// Scoring + Ranking internal type
// All ranking data in one flat shape — no cross-referencing
interface ScoredCandidate {
  ruleId: string;
  specificityScore: SpecificityScore;
  matchQuality: number;
  priority: number;
  conditionScores: number[];
  action: {
    category?: string;
    entityId?: string;
    glAccountId?: string;
  };
}

type EntityResolutionStatus = 'not_run' | 'resolved' | 'not_found';

interface EntityResolution {
  status: EntityResolutionStatus;
  entityId?: string;
}
```

### Enriched `RuleInput.context`

```typescript
context: {
  availableRules: BankRule[];
  entityContexts: unknown[];       // unchanged, reserved for future — NOT used in Sprint 2, NOT removed
  historicalMatches: unknown[];    // unchanged, reserved for future — NOT used in Sprint 2, NOT removed
  entityResolution: EntityResolution;  // NEW
}
```

### `Candidate` — Sprint 2 contract (public DTO, produced by Decision Engine)

`Candidate` is a **public output DTO**. It is the stable API contract that callers receive in `RuleOutput.candidates`. It is NOT used internally for ranking — that is `ScoredCandidate`'s role.

| Field | Sprint 1 | Sprint 2 | Notes |
|---|---|---|---|
| `specificity` | `0` | Derived compatibility field = `weightWithinTier` | **Deprecated.** See contract below. |
| `matchQuality` | `0` | Computed via `min + 0.25 * (avg - min)` | Active field. |
| `confidence` | `0` | `0` | Placeholder. Not computed in Sprint 2. |
| `conditionScores` | `number[]` | `number[]` | Unchanged. |
| `ruleId` | `string` | `string` | Unchanged. |
| `priority` | `number` | `number` | Unchanged. |

### `Candidate.specificity` deprecation contract

```
Candidate.specificity is a DERIVED COMPATIBILITY FIELD.

Value: weightWithinTier (sum of condition weights at the highest specificity tier).

⚠️ DEPRECATED — NOT AUTHORITATIVE FOR RANKING.
The ranking engine uses SpecificityScore (highestTier + weightWithinTier) as its sole
authoritative source. Candidate.specificity exists only for API stability across sprints
and diagnostic convenience. No ranking logic branches on this field.

Planned removal: Sprint 4+ (after auditing all internal callers).
```

### `EngineDecision` contract

```typescript
interface EngineDecision {
  type: 'rule';
  result: 'winner' | 'ambiguous' | 'no_match';
  ruleId?: string;          // present when result === 'winner'
  candidateList: Candidate[];
  classification: {
    entityId?: string;
    category?: string;
    glAccountId?: string;
  };
  explanation: string;
}
```

### `RuleOutput` contract

```typescript
interface RuleOutput {
  candidates: Candidate[];       // always populated (may be empty)
  decision?: EngineDecision;     // populated by DecisionEngine in Sprint 2
}
```

## Specificity Tiers

| Tier | Condition Types | Weight |
|---|---|---|
| 5 | `entity_eq` | 500 |
| 4 | `description_eq` | 400 |
| 4 | `amount_eq` | 380 |
| 3 | `description_matches` | 300 |
| 2 | `description_starts_with` | 220 |
| 2 | `description_ends_with` | 220 |
| 2 | `amount_range` | 200 |
| 1 | `description_contains` | 120 |
| 1 | `amount_gt` | 100 |
| 1 | `amount_gte` | 100 |
| 1 | `amount_lt` | 100 |
| 1 | `amount_lte` | 100 |
| 1 | `date_before` | 50 |
| 1 | `date_after` | 50 |

**Algorithm**: For a candidate's matched conditions, find the highest tier present. Sum only the condition weights at that tier. Lower-tier conditions do not contribute to `weightWithinTier` (they already influenced `matchQuality` via `conditionScores`).

**Example**: Rule with `entity_eq` (tier 5, weight 500) + `amount_gt` (tier 1) → `{ highestTier: 5, weightWithinTier: 500 }`.

## Match Quality Formula

```
MATCH_QUALITY_ALPHA = 0.25   // global versioned constant, defined in scoring.ts

matchQuality = Math.min(...scores) + ALPHA * (average(scores) - Math.min(...scores))
```

**Properties**:
- `α = 0` → pure minimum (worst condition dominates completely)
- `α = 1` → average (all conditions equal weight)
- **v2.0 α = 0.25**: conservative baseline with moderate breadth contribution
- Single score → `matchQuality = score` (min === avg, second term vanishes)
- All scores equal → `matchQuality = score`
- Empty scores → should not occur (empty conditions are discarded)

## Ranking (Lexicographic)

Sort key applied to `ScoredCandidate[]`:

1. `specificityScore.highestTier` ↓ — higher tier wins
2. `specificityScore.weightWithinTier` ↓ — heavier weight wins within same tier
3. `matchQuality` ↓ — higher quality wins within same specificity
4. `priority` ↑ — lower numeric priority wins (1 > 2 > 3)
5. `ruleId` — deterministic tiebreaker (string comparison, ascending)

**Rule of thumb**: specificity dominates, matchQuality refines within same specificity, priority only breaks ties, ruleId ensures stable ordering.

## Decision Engine

Located in `decision.ts`. Invoked from `index.ts` after Ranking Engine completes.

### DELTA decision logic

1. **Zero candidates** → `{ result: 'no_match', explanation: 'No matching rules found' }`
2. **One candidate** → `{ result: 'winner', ruleId: scored[0].ruleId, explanation: 'Single candidate' }`
3. **Two or more candidates**:
   - Compare `specificityScore` of `scored[0]` and `scored[1]`
   - If `highestTier` differs → `result: 'winner'`, top candidate wins
   - If `highestTier` is same but `weightWithinTier` differs → `result: 'winner'`, top candidate wins
   - If **both** `highestTier` AND `weightWithinTier` are identical:
     - `DELTA = scored[0].matchQuality - scored[1].matchQuality`
     - `AMBIGUITY_DELTA_THRESHOLD = 0.10` (global versioned constant)
     - `DELTA >= 0.10` → `result: 'winner'`, top candidate wins
     - `DELTA < 0.10` → `result: 'ambiguous'`

### Candidate production (Decision Engine → RuleOutput)

The Decision Engine produces `RuleOutput` by mapping `ScoredCandidate[]` → `Candidate[]`:

```typescript
candidates = scored.map(s => ({
  ruleId: s.ruleId,
  specificity: s.specificityScore.weightWithinTier,  // derived compatibility field (deprecated)
  matchQuality: s.matchQuality,
  confidence: 0,
  conditionScores: s.conditionScores,
  priority: s.priority,
}));
```

No other code path produces or mutates `Candidate[]`.

### Decision output examples

| Scenario | result | ruleId | explanation |
|---|---|---|---|
| No candidates | `no_match` | undefined | `"No matching rules found"` |
| Single candidate | `winner` | `"rule-123"` | `"Single candidate"` |
| Top-2 diff highestTier | `winner` | `"rule-123"` | `"Top candidate wins by specificity tier"` |
| Top-2 same tier, diff weight | `winner` | `"rule-123"` | `"Top candidate wins by specificity weight"` |
| Top-2 identical spec, DELTA ≥ 0.10 | `winner` | `"rule-456"` | `"DELTA 0.15 exceeds threshold 0.10"` |
| Top-2 identical spec, DELTA < 0.10 | `ambiguous` | undefined | `"DELTA 0.03 below threshold 0.10 — ambiguous"` |

## Entity Resolution Contract

### `entity_eq` condition evaluation

- **Precondition**: Entity resolution must execute before engine invocation. The resolved result is passed via `input.context.entityResolution`.
- **`status === 'not_run'`** → throw `MissingEntityIdError` (the pipeline was invoked without required entity resolution). This is a pipeline contract violation.
- **`status === 'not_found'`** → `match: false, score: 0` (entity does not exist → condition fails)
- **`status === 'resolved'`** → exact comparison: `condition.value === entityResolution.entityId`
  - Match → `match: true, score: 1.0`
  - No match → `match: false, score: 0`

### Context contract

```typescript
entityResolution: {
  status: 'not_run' | 'resolved' | 'not_found';
  entityId?: string;   // present when status === 'resolved'
}
```

`entityContexts` and `historicalMatches` remain in the context type but are NOT read by any Sprint 2 code. They are reserved for future use.

## Error Types

```
RuleEngineError (base, extends Error)
├── InvalidInputError
│   ├── MissingTransaction      — transaction is null/undefined
│   ├── MissingContext          — context.availableRules is missing
│   └── InvalidTransaction      — transaction lacks required fields (id, companyId)
├── ConditionEvalError
│   ├── InvalidRegex            — description_matches pattern is not valid regex
│   ├── InvalidNumericValue     — amount_* value cannot be parsed as number
│   ├── InvalidDateValue        — date_before/after value cannot be parsed as date
│   └── MissingEntityIdError    — NEW: entity_eq evaluated but status === 'not_run'
├── InvalidPipelineStateError   — NEW: pipeline invoked in invalid state
└── UnknownConditionTypeError   — condition type not in RuleConditionType union
```

`InvalidPipelineStateError` and `MissingEntityIdError` are **siblings** under `RuleEngineError` — not parent-child. They represent distinct failure modes: `InvalidPipelineStateError` means the pipeline was invoked in an impossible state; `MissingEntityIdError` means entity resolution was specifically not executed when `entity_eq` conditions are present.

All errors include a `code: string` property for programmatic handling and a `details: unknown` property for structured context.

## Versioned Global Constants

| Constant | Value | Defined in | Purpose |
|---|---|---|---|
| `MATCH_QUALITY_ALPHA` | `0.25` | `scoring.ts` | Blending factor for match quality formula |
| `AMBIGUITY_DELTA_THRESHOLD` | `0.10` | `decision.ts` | Minimum DELTA to declare a winner when specificity is tied |

Both constants are global, NOT configurable per-company, and only change via a new Rule Engine version.

## Condition Evaluation Updates (Sprint 2)

The `entity_eq` evaluator is updated from its Sprint 1 stub (`throw UnsupportedConditionError`) to read from `context.entityResolution` as described in the Entity Resolution Contract section above.

All other condition evaluators remain unchanged from Sprint 1.

## Invariants

1. **No mutation**: Pipeline never modifies `RuleInput`, `Transaction`, or `BankRule` objects
2. **Determinism**: Same `RuleInput` + same rules → identical `Candidate[]` + same `EngineDecision` every time
3. **AND semantics**: A rule is discarded if ANY condition fails — there is no partial match
4. **Ranked order**: `ScoredCandidate[]` is always sorted by rank (best first) after Ranking Engine
5. **No side effects**: Pipeline reads only from `RuleInput` context; no DB calls, no network, no random
6. **Empty input → empty output**: Zero rules → empty `Candidate[]`, `decision.result === 'no_match'`
7. **Empty conditions → silently discarded**: Rules with `conditions.length === 0` are filtered in `discardInvalidConfiguration()`, a validation step before the pipeline
8. **DELTA is specificity-gated**: Ambiguity is only evaluated when top-2 candidates share identical specificity (both tier and weight)
9. **Entity resolution must be pre-executed**: Pipeline does not resolve entities; it reads from `context.entityResolution`
10. **Candidate.specificity is deprecated**: The field exists for API compatibility; ranking uses internal `SpecificityScore`

## Non-goals

- The pipeline does not access Prisma or the database directly
- The pipeline does not know about HTTP or Next.js context
- The pipeline does not write AuditLog
- The pipeline does not call AI services
- The pipeline does not resolve entities (entity resolution runs before the engine)
- The pipeline does not modify the transaction or input rules
- The pipeline does not persist any state
- Confidence is NOT computed in Sprint 2 (placeholder = 0)
- The pipeline does not handle auto-apply or approval logic for rules in testing mode
