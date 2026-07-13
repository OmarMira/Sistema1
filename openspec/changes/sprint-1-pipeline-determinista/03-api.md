# Public API & Contracts — Sprint 2: Specificity, Ranking & Decision Engine

## Public API

### evaluateRules

```typescript
// File: index.ts
// Scope: PUBLIC — callers use this

export function evaluateRules(input: RuleInput): RuleOutput;
```

**Contract:**
1. Guards behind `isRuleEngineV2Enabled()` feature flag
   - Flag disabled → returns `{ candidates: [], decision: undefined }` immediately
2. Validates `input`:
   - `input.transaction` must be non-null object → else throws `MissingTransaction`
   - `input.context` must be non-null object → else throws `MissingContext`
   - `input.context.availableRules` must be array → else throws `MissingContext`
   - `input.transaction.id` and `input.transaction.companyId` must be non-empty strings → else throws `InvalidTransaction`
3. Discards invalid configurations via `discardInvalidConfiguration()` — filters out rules with empty `conditions[]`
4. Delegates to `runPipeline(input)` → `PipelineArtifacts`
5. Delegates to `scoreCandidates(pipelineResult.rawCandidates, pipelineResult.evaluations)` → `ScoredCandidate[]`
6. Delegates to `rankCandidates(scored)` → `ScoredCandidate[]` (sorted)
7. Delegates to `makeDecision(ranked)` → `EngineDecision` (internally calls `classify()` for outcome logic, then builds the DTO)
8. Returns `RuleOutput { candidates, decision }`

**Throws:** `InvalidInputError` (subtypes: `MissingTransaction`, `MissingContext`, `InvalidTransaction`), `MissingEntityIdError`, `InvalidPipelineStateError`

**Pure:** Yes — no side effects, no DB, no network.

### Stage Orchestration

`index.ts` is a thin facade that composes the 5 stages in sequence:

```
evaluateRules
  ├── validation (input validation + discardInvalidConfiguration)
  ├── runPipeline          → PipelineArtifacts { rawCandidates, evaluations }
  ├── scoreCandidates      → ScoredCandidate[]
  ├── rankCandidates       → ScoredCandidate[] (sorted)
  └── makeDecision         → EngineDecision
                    └── (calls classify() internally)
```

The `PipelineArtifacts` type bridges `runPipeline` and `scoreCandidates` by carrying both the raw candidates and their corresponding `EvaluatedCondition[]` evaluations keyed by `ruleId`. This avoids `scoreCandidates` needing access to internal pipeline state.

Each stage is a pure function call. `classify()` is encapsulated inside `makeDecision()` — `index.ts` calls only `makeDecision(ranked)`. No mutable shared state, no class instances, no DI container.

---

## Data Contracts

### RuleInput

```typescript
// File: types.ts
// Scope: PUBLIC

export interface RuleInput {
  transaction: Transaction;
  context: {
    availableRules: BankRule[];
    entityContexts: unknown[];            // Reserved for future — NOT used in Sprint 2, NOT removed
    historicalMatches: unknown[];         // Reserved for future — NOT used in Sprint 2, NOT removed
    entityResolution: EntityResolution;  // NEW in Sprint 2
  };
}
```

| Field | Sprint 2 uses? | Notes |
|---|---|---|
| `transaction` | ✅ Yes | Core data for condition evaluation |
| `context.availableRules` | ✅ Yes | The rule set to filter and evaluate |
| `context.entityContexts` | ❌ No | Reserved; pass `[]` |
| `context.historicalMatches` | ❌ No | Reserved; pass `[]` |
| `context.entityResolution` | ✅ Yes | Read by `entity_eq` evaluator; required when entity_eq conditions exist |

### EntityResolution

```typescript
// File: types.ts
// Scope: PUBLIC (as part of RuleInput)

type EntityResolutionStatus = 'not_run' | 'resolved' | 'not_found';

interface EntityResolution {
  status: EntityResolutionStatus;
  entityId?: string;    // present when status === 'resolved'
}
```

### Transaction

```typescript
// File: types.ts
// Scope: PUBLIC

export interface Transaction {
  id: string;
  date: Date;
  description: string;
  amount: number;
  bankAccountId: string;
  companyId: string;
}
```

**Unchanged from Sprint 1.** No modifications needed.

### BankRule

```typescript
// File: types.ts
// Scope: PUBLIC

export interface BankRule {
  id: string;
  companyId: string;
  priority: number;
  conditions: RuleCondition[];
  action: {
    category?: string;
    entityId?: string;
    glAccountId?: string;
  };
  isActive: boolean;
  lifecycleStatus: RuleLifecycleStatus;
}
```

**Unchanged from Sprint 1.** No modifications needed.

### RuleOutput

```typescript
// File: types.ts
// Scope: PUBLIC

export interface RuleOutput {
  candidates: Candidate[];       // always populated (may be empty)
  decision?: EngineDecision;     // populated in Sprint 2 by Decision Engine
}
```

**Sprint 2 contract:** `decision` is populated when the feature flag is enabled. The type remains optional (`?`) for backward compatibility with Sprint 1 callers that may still receive `undefined` when the flag is disabled.

### Candidate

```typescript
// File: types.ts
// Scope: PUBLIC — stable output DTO

export interface Candidate {
  ruleId: string;
  specificity: number;        // Derived compatibility field = weightWithinTier ⚠️ DEPRECATED
  matchQuality: number;       // Computed via min + 0.25 * (avg - min)
  confidence: number;         // 0 — placeholder, not computed in Sprint 2
  conditionScores: number[];  // One 0..1 score per condition
  priority: number;           // From BankRule, used in tie-breaking
}
```

#### Candidate field mapping (Sprint 1 → Sprint 2)

| Field | Sprint 1 | Sprint 2 | Notes |
|---|---|---|---|
| `ruleId` | ✅ Populated | ✅ Populated | Unchanged |
| `conditionScores` | ✅ Populated | ✅ Populated | Unchanged |
| `priority` | ✅ Populated | ✅ Populated | Unchanged |
| `specificity` | `0` (placeholder) | `weightWithinTier` | **Deprecated** — see contract below |
| `matchQuality` | `0` (placeholder) | `min + 0.25 * (avg - min)` | Now computed |
| `confidence` | `0` (placeholder) | `0` | Still placeholder |

#### Candidate.specificity deprecation contract

```
Candidate.specificity is a DERIVED COMPATIBILITY FIELD.

Value: weightWithinTier (sum of condition weights at the highest specificity tier).

⚠️ specificity is NOT a ranking score. It is a compatibility field ONLY.
The ranking engine uses SpecificityScore (highestTier + weightWithinTier) as its sole
authoritative source. Two rules with identical specificity (e.g. both = 400) may belong
to different tiers — the ranking engine resolves this via SpecificityScore.highestTier,
NOT via Candidate.specificity.

Candidate.specificity exists only for API stability across sprints and diagnostic
convenience. No ranking logic branches on this field.

Planned removal: Sprint 4+ (after auditing all internal callers).
```

### EngineDecision

```typescript
// File: types.ts
// Scope: PUBLIC — now populated by Decision Engine

export interface EngineDecision {
  type: DecisionType;
  result: DecisionResult;
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

| Field | Sprint 1 | Sprint 2 |
|---|---|---|
| `type` | `'rule'` | `'rule'` (unchanged, only `'rule'` decision type in Sprint 2) |
| `result` | undefined | `'winner' \| 'ambiguous' \| 'no_match'` |
| `ruleId` | undefined | Present when `result === 'winner'` |
| `candidateList` | `[]` | Populated with all candidates |
| `classification` | Structural | **Populated from top candidate's action when `result === 'winner'`.** Undefined when `result === 'ambiguous'` or `result === 'no_match'` — no winner exists to extract classification from. |
| `explanation` | `''` | Descriptive string per outcome |

### DecisionType

```typescript
// File: types.ts
// Scope: PUBLIC

export type DecisionType = 'rule' | 'history' | 'entity' | 'ai' | 'manual';
```

**Sprint 2 contract:** Only `'rule'` is emitted in Sprint 2. All remaining values (`'history'`, `'entity'`, `'ai'`, `'manual'`) are **reserved** for future sprints and are not used by any code path in Sprint 2.

### DecisionResult

```typescript
// File: types.ts
// Scope: PUBLIC

export type DecisionResult = 'winner' | 'ambiguous' | 'no_match';
```

**Unchanged from Sprint 1.** Now populated by Decision Engine.

### RuleConditionType / RuleCondition

```typescript
// File: types.ts
// Scope: PUBLIC (RuleCondition), PUBLIC (RuleConditionType)

export type RuleConditionType =
  | 'amount_gt' | 'amount_gte' | 'amount_lt' | 'amount_lte'
  | 'description_eq' | 'description_contains'
  | 'description_starts_with' | 'description_ends_with' | 'description_matches'
  | 'entity_eq' | 'amount_eq' | 'amount_range'
  | 'date_before' | 'date_after';

export interface RuleCondition {
  type: RuleConditionType;
  value: string | number;
  range?: [number, number];
}
```

**Unchanged from Sprint 1.** `entity_eq` no longer throws at evaluation time — now reads from `context.entityResolution`.

### EvaluatedCondition (Internal)

```typescript
// File: types.ts
// Scope: INTERNAL — used mid-pipeline, NOT exposed in Candidate or public API

export interface EvaluatedCondition {
  type: RuleConditionType;
  score: number;    // 0..1
  match: boolean;   // score >= threshold? (currently: score > 0)
  detail: string;   // Human-readable explanation of the evaluation
}
```

**Unchanged from Sprint 1.** Remains as internal mid-pipeline type.

### RuleLifecycleStatus

```typescript
// File: types.ts
// Scope: PUBLIC

export type RuleLifecycleStatus = 'draft' | 'testing' | 'active' | 'deprecated' | 'archived';
```

**Unchanged from Sprint 1.**

---

## Internal Types (not exported from barrel)

### RawCandidate

```typescript
// File: types.ts
// Scope: INTERNAL — pipeline output, never exposed in public API

export interface RawCandidate {
  ruleId: string;
  conditionScores: number[];
  priority: number;
  action: {
    category?: string;
    entityId?: string;
    glAccountId?: string;
  };
}
```

**Contract:** Pipeline output before scoring. Contains NO ranking data (no specificity, no matchQuality, no confidence). Only the Scoring Engine produces ranking data.

### PipelineArtifacts

```typescript
// File: types.ts
// Scope: INTERNAL — bridges runPipeline and scoreCandidates

export interface PipelineArtifacts {
  rawCandidates: RawCandidate[];
  evaluations: Map<string, EvaluatedCondition[]>;  // keyed by ruleId
}
```

**Contract:** Explicit bridge between `runPipeline` and `scoreCandidates`. The pipeline produces both raw candidates and their condition evaluations; `scoreCandidates` needs the evaluations to compute `SpecificityScore`. A single return type avoids implicit dependencies between stages.

### ScoredCandidate

```typescript
// File: types.ts
// Scope: INTERNAL — scoring + ranking artifact, never exposed in public API

export interface ScoredCandidate {
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
```

**Contract:** Flat internal type for scoring and ranking. All ranking data in one shape with no cross-referencing. NOT mapped from Candidate — Candidate is the _output_ of ranking.

### SpecificityScore

```typescript
// File: types.ts
// Scope: INTERNAL — ranking artifact, MUST NEVER be serialized or exposed through public API

export interface SpecificityScore {
  highestTier: number;       // 5..1 (5 = most specific)
  weightWithinTier: number;  // sum of condition weights at highestTier
}
```

**Contract:** Internal ranking artifact. **NEVER serialized**, never written to DB, never exposed in API responses. It exists only at runtime within `ScoredCandidate` during the scoring → ranking → decision pipeline.

---

## Error Types

### Full hierarchy (Sprint 2)

```typescript
// File: errors.ts
// Scope: PUBLIC (all exported)

export class RuleEngineError extends Error {
  public readonly code: string;
  public readonly details: unknown;
  constructor(message: string, code: string, details?: unknown);
}

export class InvalidInputError extends RuleEngineError {
  constructor(message: string, code: string, details?: unknown);
}

export class MissingTransaction extends InvalidInputError {
  constructor(details?: unknown);
}

export class MissingContext extends InvalidInputError {
  constructor(details?: unknown);
}

export class InvalidTransaction extends InvalidInputError {
  constructor(details?: unknown);
}

export class ConditionEvalError extends RuleEngineError {
  public readonly conditionType: RuleConditionType;
  constructor(message: string, code: string, conditionType: RuleConditionType, details?: unknown);
}

export class InvalidRegex extends ConditionEvalError {
  constructor(conditionType: RuleConditionType, details?: unknown);
}

export class InvalidNumericValue extends ConditionEvalError {
  constructor(conditionType: RuleConditionType, details?: unknown);
}

export class InvalidDateValue extends ConditionEvalError {
  constructor(conditionType: RuleConditionType, details?: unknown);
}

export class UnsupportedConditionError extends ConditionEvalError {
  constructor(conditionType: RuleConditionType, details?: unknown);
}

export class MissingEntityIdError extends ConditionEvalError {     // NEW
  constructor(conditionType: RuleConditionType, details?: unknown);
}

export class UnknownConditionTypeError extends ConditionEvalError {
  constructor(conditionType: RuleConditionType, details?: unknown);
}

export class InvalidPipelineStateError extends RuleEngineError {   // NEW
  constructor(message: string, code: string, details?: unknown);
}
```

### Error codes

| Error | `code` | When thrown |
|---|---|---|
| `MissingTransaction` | `ERR_MISSING_TRANSACTION` | `input.transaction` is null/undefined |
| `MissingContext` | `ERR_MISSING_CONTEXT` | `input.context` is null/undefined, or `context.availableRules` is missing/not an array |
| `InvalidTransaction` | `ERR_INVALID_TRANSACTION` | `transaction.id` or `transaction.companyId` is missing/empty |
| `InvalidRegex` | `ERR_INVALID_REGEX` | `description_matches` value is not a valid regex pattern |
| `InvalidNumericValue` | `ERR_INVALID_NUMERIC` | `amount_*` or `amount_eq` value cannot be parsed as a number |
| `InvalidDateValue` | `ERR_INVALID_DATE` | `date_before`/`date_after` value cannot be parsed as a date |
| `UnsupportedConditionError` | `ERR_UNSUPPORTED_CONDITION` | Condition type is valid per contract but not implemented in this sprint |
| `MissingEntityIdError` | `ERR_MISSING_ENTITY_ID` | `entity_eq` evaluated but `entityResolution.status === 'not_run'` |
| `UnknownConditionTypeError` | `ERR_UNKNOWN_CONDITION_TYPE` | Condition type string does not match any known `RuleConditionType` |
| `InvalidPipelineStateError` | `ERR_INVALID_PIPELINE_STATE` | Pipeline invoked in an invalid/impossible state |

### Error hierarchy design

```
RuleEngineError (base)
├── InvalidInputError
│   ├── MissingTransaction
│   ├── MissingContext
│   └── InvalidTransaction
├── ConditionEvalError
│   ├── InvalidRegex
│   ├── InvalidNumericValue
│   ├── InvalidDateValue
│   ├── UnsupportedConditionError
│   ├── MissingEntityIdError          ← NEW (extends ConditionEvalError)
│   └── UnknownConditionTypeError
├── InvalidPipelineStateError          ← NEW (sibling of ConditionEvalError, direct child of RuleEngineError)
└── UnknownConditionTypeError
```

`MissingEntityIdError` extends `ConditionEvalError` because it is thrown by the `entity_eq` condition evaluator during evaluation and carries `conditionType` context. It is NOT a sibling — it belongs to the condition evaluation subtree.

`InvalidPipelineStateError` is a **direct child** of `RuleEngineError` and a **sibling** of `ConditionEvalError`. It represents a pipeline state violation (e.g., stage called out of order), which is architecturally distinct from condition evaluation failures.

The two errors represent distinct failure modes:

- `InvalidPipelineStateError` — the pipeline was invoked in an impossible state (e.g., stage called out of order, unexpected shape)
- `MissingEntityIdError` — entity resolution was not executed when `entity_eq` conditions are present

### Throwing context

| Function | Throws |
|---|---|
| `evaluateRules` (index.ts) | `InvalidInputError` hierarchy |
| `runPipeline` → `evaluateConditions` (pipeline.ts) | `ConditionEvalError` hierarchy (including `MissingEntityIdError`, `InvalidRegex`, `InvalidNumericValue`, `InvalidDateValue`) |
| `entity.ts` | `MissingEntityIdError` — `entity_eq` evaluated but `entityResolution.status === 'not_run'` |
| `conditions/index.ts` (dispatch) | `UnknownConditionTypeError` — type not a known `RuleConditionType` |
| `scoreCandidates` (scoring.ts) | `InvalidPipelineStateError` — if `RawCandidate[]` has unexpected shape |
| `rankCandidates` (ranking.ts) | Never throws (pure sort) |
| `classify` (decision.ts) | Never throws (pure logic) |
| `makeDecision` (decision.ts) | Never throws (pure mapping) |
| `produceCandidates` (pipeline.ts) | Never throws (pure mapping) |

---

## Global Constants

| Constant | Value | Defined in | Purpose |
|---|---|---|---|
| `MATCH_QUALITY_ALPHA` | `0.25` | `scoring.ts` | Blending factor for match quality formula |
| `AMBIGUITY_DELTA_THRESHOLD` | `0.10` | `decision.ts` | Minimum DELTA to declare a winner when specificity is tied |

Both constants are global, NOT configurable per-company, and only change via a new Rule Engine version.

---

## Internal Functions

### computeSpecificity

```typescript
// File: specificity.ts
// Scope: PRIVATE — imported only by scoring.ts

function computeSpecificity(conditions: EvaluatedCondition[]): SpecificityScore
```

**Algorithm:**
1. For each matched condition in `conditions`, look up its specificity tier and weight (see architecture 02-architecture.md §Specificity Tiers)
2. Find the highest tier present among matched conditions
3. Sum only the condition weights at that highest tier
4. Lower-tier conditions do NOT contribute to `weightWithinTier`

**Pure:** Yes. Deterministic from EvaluatedCondition[] alone.

### computeMatchQuality

```typescript
// File: specificity.ts
// Scope: PRIVATE — imported only by scoring.ts

function computeMatchQuality(scores: number[]): number
```

**Formula:**

```
matchQuality = Math.min(...scores) + MATCH_QUALITY_ALPHA * (average(scores) - Math.min(...scores))
```

**Properties:**
- Single score → `matchQuality = score` (min === avg, second term vanishes)
- All scores equal → `matchQuality = score`
- Empty scores → caller must not pass empty; downstream `discardInvalidConfiguration` prevents this

**Pure:** Yes.

### scoreCandidates

```typescript
// File: scoring.ts
// Scope: INTERNAL — imported by index.ts

function scoreCandidates(result: PipelineArtifacts): ScoredCandidate[]
```

**Contract:**
1. Iterates `result.rawCandidates`
2. For each `RawCandidate`, retrieves its `EvaluatedCondition[]` from `result.evaluations` (keyed by `ruleId`)
3. Calls `computeSpecificity(evals[ruleId])` → `SpecificityScore`
4. Calls `computeMatchQuality(raw.conditionScores)` → `matchQuality`
5. Assembles `ScoredCandidate` combining raw data + computed scores
6. Returns array in the same order as input (ordering occurs in ranking.ts)

**Throws:** `InvalidPipelineStateError` if a raw candidate has no matching entry in `result.evaluations`

**Pure:** Yes.

### rankCandidates

```typescript
// File: ranking.ts
// Scope: INTERNAL — imported by index.ts

function rankCandidates(scored: ScoredCandidate[]): ScoredCandidate[]
```

**Sort key (lexicographic, descending where noted):**
1. `specificityScore.highestTier` ↓ — higher tier wins
2. `specificityScore.weightWithinTier` ↓ — heavier weight wins within same tier
3. `matchQuality` ↓ — higher quality wins within same specificity
4. `priority` ↑ — lower numeric priority wins (1 > 2 > 3)
5. `ruleId` — deterministic tiebreaker (string comparison, ascending)

**Pure:** Yes. Returns a new sorted copy, does not mutate input.

### classify

```typescript
// File: decision.ts
// Scope: PRIVATE — called only by makeDecision()

function classify(scored: ScoredCandidate[]): { winner?: ScoredCandidate; isAmbiguous: boolean; explanation: string }
```

**Responsibility:** Determines the decision outcome from the ranked candidate list — who wins, if it's ambiguous, or no match. Pure decision logic, no DTO construction. Called internally by `makeDecision()`, not by `index.ts`.

**Decision logic** (same table as `makeDecision` below):
| Condition | winner | isAmbiguous |
|---|---|---|
| Zero candidates | undefined | false |
| One candidate | scored[0] | false |
| Two+, different highestTier | scored[0] | false |
| Two+, same tier, diff weight | scored[0] | false |
| Two+, identical spec, DELTA ≥ 0.10 | scored[0] | false |
| Two+, identical spec, DELTA < 0.10 | undefined | true |

### makeDecision

```typescript
// File: decision.ts
// Scope: INTERNAL — imported by index.ts

function makeDecision(
  scored: ScoredCandidate[],
  classification: { entityId?: string; category?: string; glAccountId?: string } | undefined,
): EngineDecision
```

**Responsibility:** Calls `classify()` internally for outcome logic, then builds the `EngineDecision` DTO. Pure output mapping — single entry point consumed by `index.ts`.

**Decision logic (used by classify):**

| Condition | result | ruleId | explanation |
|---|---|---|---|
| Zero candidates | `no_match` | undefined | `"No matching rules found"` |
| One candidate | `winner` | `scored[0].ruleId` | `"Single candidate"` |
| Two+, different highestTier | `winner` | `scored[0].ruleId` | `"Top candidate wins by specificity tier"` |
| Two+, same tier, different weight | `winner` | `scored[0].ruleId` | `"Top candidate wins by specificity weight"` |
| Two+, identical spec, DELTA ≥ 0.10 | `winner` | `scored[0].ruleId` | `"DELTA {n} exceeds threshold 0.10"` |
| Two+, identical spec, DELTA < 0.10 | `ambiguous` | undefined | `"DELTA {n} below threshold 0.10 — ambiguous"` |

**Candidate production:** Maps `ScoredCandidate[]` → `Candidate[]`:

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

**Pure:** Yes.

---

## runPipeline — Sprint 2 Contract

```typescript
// File: pipeline.ts
// Scope: INTERNAL — imported only by index.ts

export function runPipeline(input: RuleInput): PipelineArtifacts;
```

**Sprint 2 change:** Return type changes from `Candidate[]` to `PipelineArtifacts`. The pipeline no longer produces the final `Candidate[]` — that responsibility moves to the Decision Engine. `PipelineArtifacts` carries both `rawCandidates` and the `evaluations` map needed by `scoreCandidates`.

| Step | Function | Input | Output | Pure |
|---|---|---|---|---|---|
| 1 | `collectCandidates` | `RuleInput` | `BankRule[]` | ✅ |
| 2 | `evaluateConditions` | `BankRule[]`, `Transaction` | `[BankRule, EvaluatedCondition[]][]` | ✅ |
| 3 | `discardInvalid` | `[BankRule, EvaluatedCondition[]][]` | `[BankRule, EvaluatedCondition[]][]` | ✅ |
| 4 | `produceCandidates` | `[BankRule, EvaluatedCondition[]][]` | `PipelineArtifacts` | ✅ |

**Internal step functions** (not exported, not public):

```typescript
function collectCandidates(input: RuleInput): BankRule[]
function evaluateConditions(rules: BankRule[], transaction: Transaction): [BankRule, EvaluatedCondition[]][]
function discardInvalid(entries: [BankRule, EvaluatedCondition[]][]): [BankRule, EvaluatedCondition[]][]
function produceCandidates(entries: [BankRule, EvaluatedCondition[]][]): PipelineArtifacts
```

**Throws:** `ConditionEvalError` hierarchy (including `MissingEntityIdError`, `InvalidRegex`, `InvalidNumericValue`, `InvalidDateValue`)

**Pure:** Yes — all 4 steps are pure functions.

---

## Public vs Internal

| Export | File | Scope | Notes |
|---|---|---|---|
| `evaluateRules` | `index.ts` | **Public** | Entry point, feature flag gate, stage orchestration |
| `runPipeline` | `pipeline.ts` | Internal | Only `index.ts`; not exported from barrel |
| `collectCandidates` | `pipeline.ts` | Private | Not exported |
| `evaluateConditions` | `pipeline.ts` | Private | Not exported |
| `discardInvalid` | `pipeline.ts` | Private | Not exported |
| `produceCandidates` | `pipeline.ts` | Private | Not exported |
| `scoreCandidates` | `scoring.ts` | Internal | Only `index.ts`; not exported from barrel |
| `computeSpecificity` | `specificity.ts` | Private | Only `scoring.ts`; not exported |
| `computeMatchQuality` | `specificity.ts` | Private | Only `scoring.ts`; not exported |
| `rankCandidates` | `ranking.ts` | Internal | Only `index.ts`; not exported from barrel |
| `classify` | `decision.ts` | Private | Only `makeDecision`; not exported |
| `makeDecision` | `decision.ts` | Internal | Only `index.ts`; not exported from barrel |
| `RuleInput` | `types.ts` | **Public** | Re-exported via `index.ts` |
| `RuleOutput` | `types.ts` | **Public** | Re-exported via `index.ts` |
| `Candidate` | `types.ts` | **Public** | Exposed in `RuleOutput.candidates` |
| `Transaction` | `types.ts` | **Public** | Part of `RuleInput` |
| `BankRule` | `types.ts` | **Public** | Needed to provide `availableRules` |
| `RuleCondition` | `types.ts` | **Public** | Part of `BankRule` |
| `RuleConditionType` | `types.ts` | **Public** | Used in `RuleCondition` |
| `RuleLifecycleStatus` | `types.ts` | **Public** | Used in `BankRule` |
| `EngineDecision` | `types.ts` | **Public** | Now populated; exported for callers inspecting decision |
| `DecisionType` | `types.ts` | **Public** | Used in `EngineDecision` |
| `DecisionResult` | `types.ts` | **Public** | Used in `EngineDecision` |
| `EntityResolution` | `types.ts` | **Public** | Included in `RuleInput.context` |
| `EntityResolutionStatus` | `types.ts` | **Public** | Used in `EntityResolution` |
| `EvaluatedCondition` | `types.ts` | Internal | Mid-pipeline intermediate type |
| `PipelineArtifacts` | `types.ts` | Internal | Bridges `runPipeline` and `scoreCandidates`; not exposed via barrel |
| `RawCandidate` | `types.ts` | Internal | Pipeline output type; not exposed via barrel |
| `ScoredCandidate` | `types.ts` | Internal | Scoring + ranking type; not exposed via barrel |
| `SpecificityScore` | `types.ts` | Internal | Ranking artifact; not exposed via barrel |
| `AuditLogEntry` | `types.ts` | Internal | Reserved for Sprint 3 |
| `isRuleEngineV2Enabled` | `flag.ts` | Internal | Only `index.ts` |
| `RuleEngineError` | `errors.ts` | **Public** | Base error type |
| `InvalidInputError` | `errors.ts` | **Public** | Input validation errors |
| `MissingTransaction` | `errors.ts` | **Public** | |
| `MissingContext` | `errors.ts` | **Public** | |
| `InvalidTransaction` | `errors.ts` | **Public** | |
| `ConditionEvalError` | `errors.ts` | **Public** | Condition evaluation errors |
| `InvalidRegex` | `errors.ts` | **Public** | |
| `InvalidNumericValue` | `errors.ts` | **Public** | |
| `InvalidDateValue` | `errors.ts` | **Public** | |
| `UnsupportedConditionError` | `errors.ts` | **Public** | |
| `MissingEntityIdError` | `errors.ts` | **Public** | NEW |
| `UnknownConditionTypeError` | `errors.ts` | **Public** | |
| `InvalidPipelineStateError` | `errors.ts` | **Public** | NEW |

### Barrel export (index.ts)

```typescript
// PUBLIC exports — callers import from 'src/lib/rule-engine'
export { evaluateRules } from './index';

export type {
  RuleInput, RuleOutput, Candidate, Transaction, BankRule,
  RuleCondition, RuleConditionType, RuleLifecycleStatus,
  EngineDecision, DecisionType, DecisionResult,
  EntityResolution, EntityResolutionStatus,
} from './types';

export {
  RuleEngineError, InvalidInputError,
  MissingTransaction, MissingContext, InvalidTransaction,
  ConditionEvalError, InvalidRegex, InvalidNumericValue, InvalidDateValue,
  UnsupportedConditionError, MissingEntityIdError,
  UnknownConditionTypeError,
  InvalidPipelineStateError,
} from './errors';
```

**NOT exported from barrel:** `EvaluatedCondition`, `RawCandidate`, `ScoredCandidate`, `SpecificityScore`, `PipelineArtifacts`, `AuditLogEntry`, `runPipeline`, `scoreCandidates`, `rankCandidates`, `makeDecision`, `isRuleEngineV2Enabled`.

---

## Invariants

| # | Invariant | How it's enforced |
|---|---|---|
| 1 | **No mutation** | All pipeline stages are pure functions that return new objects; `RuleInput`, `Transaction`, `BankRule` objects are never modified |
| 2 | **Determinism** | No randomness, no system time, no DB calls, no network — pure computation from `RuleInput` only |
| 3 | **AND semantics** | `discardInvalid` removes any candidate where ANY condition fails (`match === false`) |
| 4 | **Ranked order** | `rankCandidates` always returns `ScoredCandidate[]` sorted by rank (best first); no other code path mutates order |
| 5 | **No side effects** | Pipeline reads input, computes, returns output — no writes, no I/O, no state |
| 6 | **Empty input → empty output** | Zero `availableRules` → Step 1 returns `[]` → `Candidate[]` is `[]`, `decision.result === 'no_match'` |
| 7 | **Empty conditions → silently discarded** | Rules with `conditions.length === 0` filtered in `discardInvalidConfiguration()` before pipeline |
| 8 | **DELTA is specificity-gated** | Ambiguity only evaluated when top-2 share identical `highestTier` AND `weightWithinTier` |
| 9 | **Entity resolution must be pre-executed** | Pipeline does not resolve entities; reads from `context.entityResolution`; `status === 'not_run'` throws `MissingEntityIdError` |
| 10 | **Candidate.specificity is deprecated** | Field exists for API compatibility; ranking uses internal `SpecificityScore` |
| 11 | **Same input → same output** | All steps are referentially transparent — no cache, no mutation, no order dependency |
| 12 | **Errors are typed** | `InvalidInputError` hierarchy for input validation; `ConditionEvalError` hierarchy for condition evaluation; `InvalidPipelineStateError` for state violations |
| 13 | **Feature flag is transparent** | Flag disabled → empty result; flag enabled → full pipeline runs. Callers don't handle the flag. |
| 14 | **RawCandidate contains no ranking data** | Pipeline output type has no `specificity`, `matchQuality`, or `confidence` fields |
| 15 | **SpecificityScore NEVER serialized** | Internal-only type; no code path writes it to DB, API response, or log output |

---

## What Changes vs Sprint 1

| Change | Sprint 1 | Sprint 2 | Reason |
|---|---|---|---|
| `evaluateRules` behavior | Returns `decision: undefined` | Populates `decision` via Decision Engine | Sprint 2 implements ranking + decision |
| `runPipeline` return type | `Candidate[]` | `PipelineArtifacts { rawCandidates, evaluations }` | Pipeline no longer produces final Candidate; carries both raw candidates and evaluations needed by scoring |
| `Candidate.specificity` | `0` (placeholder) | `weightWithinTier` (derived compatibility field) | Deprecated; exists for API stability |
| `Candidate.matchQuality` | `0` (placeholder) | Computed via `min + 0.25 * (avg - min)` | Now meaningful |
| `RuleInput.context` | `{ availableRules, entityContexts, historicalMatches }` | + `entityResolution: EntityResolution` | Entity resolution context for `entity_eq` |
| `entity_eq` behavior | Throws `UnsupportedConditionError` | Reads from `context.entityResolution` | Real implementation |
| New modules | — | `specificity.ts`, `scoring.ts`, `ranking.ts`, `decision.ts` | Stage separation |
| `UnsupportedConditionError` removal | Thrown by `entity.ts` | Removed from `entity.ts` (class stays for future use) | `entity_eq` is now implemented |
| Error types | 9 error classes | + `MissingEntityIdError`, `InvalidPipelineStateError` | Entity resolution and pipeline state validation |
| scoreCandidates entry | — | `PipelineArtifacts.rawCandidates` + `PipelineArtifacts.evaluations` | Maps pipeline output → scored internal type via explicit bridge type |
| `candidates` length guarantee | N candidates | N candidates | Unchanged: all matched rules appear regardless of decision outcome |

---

## What Does NOT Change

| Item | Status | Notes |
|---|---|---|
| `Transaction` | ✅ Stable | No modifications |
| `BankRule` | ✅ Stable | No modifications |
| `RuleCondition` | ✅ Stable | No modifications |
| `RuleConditionType` | ✅ Stable | No modifications |
| `EvaluatedCondition` | ✅ Stable | No modifications |
| `RuleLifecycleStatus` | ✅ Stable | No modifications |
| `entityContexts` field | ✅ Reserved | Stays in `RuleInput.context`, NOT used |
| `historicalMatches` field | ✅ Reserved | Stays in `RuleInput.context`, NOT used |
| Feature flag behavior | ✅ Stable | `isRuleEngineV2Enabled()` gates the entire feature |
| Input validation behavior | ✅ Stable | Same validation, same `InvalidInputError` hierarchy |
| Barrel export structure | ✅ Similar | Plus new error types, plus `EngineDecision`, `EntityResolution`, `EntityResolutionStatus` |
| `confidence` in Candidate | ✅ Still `0` | Not computed in Sprint 2 |
| `UnsupportedConditionError` class | ✅ Still exported | Remains for future scope boundaries |
| All condition evaluators except `entity_eq` | ✅ Unchanged | Same logic, same errors, same contracts |

---

## Open Questions

| Question | Impact | Recommended Resolution |
|---|---|---|
| **`engineVersion` in output**: Should Sprint 2 include a version marker? | Affects audit readiness | No — not needed until Sprint 3 (audit). Add `engineVersion` to `RuleOutput` if Sprint 3 needs it. |
| **`entityContexts` removal**: Should unused fields be removed? | Affects API surface | No — keep for backward compatibility. Remove in a dedicated cleanup sprint. |
| **DELTA threshold configurability**: Should `AMBIGUITY_DELTA_THRESHOLD` be per-company? | Affects product requirements | No — global constant. Revisit if product requests per-company tuning. |

---

## Specificity Tiers

See architecture document `02-architecture.md` §Specificity Tiers for the complete tier/weight mapping.

---

## Match Quality Formula

```
MATCH_QUALITY_ALPHA = 0.25

matchQuality = Math.min(...scores) + ALPHA * (average(scores) - Math.min(...scores))
```

See architecture document `02-architecture.md` §Match Quality Formula for properties and examples.

---

## Decision Engine Examples

| Scenario | result | ruleId | explanation |
|---|---|---|---|
| No candidates | `no_match` | undefined | `"No matching rules found"` |
| Single candidate | `winner` | `"rule-123"` | `"Single candidate"` |
| Top-2 diff highestTier | `winner` | `"rule-123"` | `"Top candidate wins by specificity tier"` |
| Top-2 same tier, diff weight | `winner` | `"rule-123"` | `"Top candidate wins by specificity weight"` |
| Top-2 identical spec, DELTA ≥ 0.10 | `winner` | `"rule-456"` | `"DELTA 0.15 exceeds threshold 0.10"` |
| Top-2 identical spec, DELTA < 0.10 | `ambiguous` | undefined | `"DELTA 0.03 below threshold 0.10 — ambiguous"` |
