# Sprint 1 — Implementation Plan: Deterministic Pipeline

## 0. Pre-Flight Verification

Before writing any code, confirm:

| Check | Expected | Actual |
|---|---|---|
| `flag.ts` exists | ✅ Yes | `isRuleEngineV2Enabled()` reads env var `RULE_ENGINE_V2_ENABLED` |
| `types.ts` has `RuleOutput` | ✅ Yes | But must change from `{ decision: EngineDecision }` → `{ candidates: Candidate[]; decision?: EngineDecision }` |
| `types.ts` has `Candidate` | ✅ Yes | But must add `confidence: number` field |
| `types.ts` has `RuleConditionType` | ✅ Yes | Complete — all 14 types present |
| `types.ts` has `EvaluatedCondition` | ✅ Yes | Internal type, no changes needed |
| vitest configured | ✅ Yes | `vitest.config.ts` with `@/` alias, globals enabled |
| `tests/` excluded from tsconfig | ✅ Yes | No issues — vitest includes `src/lib/rule-engine/__tests__/` independently |

---

## 1. Task Breakdown

### Phase A: Foundation (types + errors)

| ID | Task | File(s) | Estimated | Depends On | Verification |
|---|---|---|---|---|---|
| A1 | Update `types.ts` — add `confidence` to `Candidate`, change `RuleOutput` to `{ candidates: Candidate[]; decision?: EngineDecision }` | `src/lib/rule-engine/types.ts` | 10 min | — | `tsc --noEmit` passes |
| A2 | Create `errors.ts` — full error class hierarchy (`RuleEngineError` → `InvalidInputError`/`ConditionEvalError` → leaf classes, including `UnsupportedConditionError` and `UnknownConditionTypeError`) | `src/lib/rule-engine/errors.ts` | 25 min | A1 | `tsc --noEmit` passes + error constructors work |
| A3 | Create barrel `index.ts` — re-export public types + errors, define `evaluateRules()` stub (not yet impl) | `src/lib/rule-engine/index.ts` | 10 min | A1, A2 | `tsc --noEmit` passes |

**Phase A total: 45 min**

### Phase B: Condition Evaluators

Each evaluator is a pure function in its own file + registered in a central dispatch map.

| ID | Task | File(s) | Estimated | Depends On | Verification |
|---|---|---|---|---|---|
| B1 | Implement `amount.ts` — evaluators for `amount_gt`, `amount_gte`, `amount_lt`, `amount_lte`, `amount_eq`, `amount_range` | `src/lib/rule-engine/conditions/amount.ts` | 30 min | A1 | `tsc --noEmit` passes |
| B2 | Implement `description.ts` — evaluators for `description_eq`, `description_contains`, `description_starts_with`, `description_ends_with`, `description_matches` | `src/lib/rule-engine/conditions/description.ts` | 30 min | A1, A2 | `tsc --noEmit` passes |
| B3 | Implement `date.ts` — evaluators for `date_before`, `date_after` | `src/lib/rule-engine/conditions/date.ts` | 15 min | A1, A2 | `tsc --noEmit` passes |
| B4 | Implement `entity.ts` — evaluator for `entity_eq` (throws `UnsupportedConditionError` — not implemented in Sprint 1) | `src/lib/rule-engine/conditions/entity.ts` | 10 min | A1, A2 | `tsc --noEmit` passes + calling entity_eq throws `UnsupportedConditionError` |
| B5 | Create `conditions/index.ts` — dispatch map `Record<RuleConditionType, EvaluatorFn>` combining all 4 modules | `src/lib/rule-engine/conditions/index.ts` | 10 min | B1, B2, B3, B4 | `tsc --noEmit` passes |

**Phase B total: 95 min**

### Phase C: Pipeline

| ID | Task | File(s) | Estimated | Depends On | Verification |
|---|---|---|---|---|---|
| C1 | Implement `collectCandidates` — filter by `companyId` + `lifecycleStatus in ('active', 'testing')` | `src/lib/rule-engine/pipeline.ts` | 10 min | A1 | `tsc --noEmit` passes |
| C2 | Implement `evaluateConditions` — iterate rules, dispatch each condition via dispatch map, return `[BankRule, EvaluatedCondition[]][]` | `src/lib/rule-engine/pipeline.ts` | 20 min | B5 | `tsc --noEmit` passes |
| C3 | Implement `discardInvalid` — filter entries where ALL `EvaluatedCondition.match === true` | `src/lib/rule-engine/pipeline.ts` | 10 min | A1 | `tsc --noEmit` passes |
| C4 | Implement `produceCandidates` — map surviving entries to `Candidate[]` with `specificity=0`, `matchQuality=0`, `confidence=0` | `src/lib/rule-engine/pipeline.ts` | 10 min | A1 | `tsc --noEmit` passes |
| C5 | Implement `runPipeline` — orchestrate C1→C2→C3→C4 in order; export it | `src/lib/rule-engine/pipeline.ts` | 5 min | C1, C2, C3, C4 | `tsc --noEmit` passes |

**Phase C total: 55 min**

### Phase D: Public Interface

| ID | Task | File(s) | Estimated | Depends On | Verification |
|---|---|---|---|---|---|
| D1 | **Verify** `isRuleEngineV2Enabled()` in `flag.ts` — already implemented and correct. No changes needed. | `src/lib/rule-engine/flag.ts` | 2 min | — | `tsc --noEmit` passes |
| D2 | Implement `evaluateRules()` in `index.ts` — feature flag gate → input validation (throws `InvalidInputError` hierarchy) → delegate to `runPipeline` → wrap result in `RuleOutput { candidates }` | `src/lib/rule-engine/index.ts` | 20 min | A1, A2, C5, D1 | `tsc --noEmit` passes |
| D3 | Verify barrel exports — ensure only public types/errors are re-exported from `index.ts`; `EngineDecision`, `EvaluatedCondition`, `runPipeline`, `isRuleEngineV2Enabled` are NOT exported | `src/lib/rule-engine/index.ts` | 5 min | D2 | `tsc --noEmit` passes |

**Phase D total: 27 min**

### Phase E: Tests

All test files go under `src/lib/rule-engine/__tests__/`.

| ID | Task | File(s) | Estimated | Depends On | Verification |
|---|---|---|---|---|---|
| E1 | Create `fixtures.ts` — factory functions (`makeRule`, `makeTransaction`, `makeCondition`, `makeRuleInput`, `makeEvaluatedCondition`) + presets (`oneActiveRule`, `threeActiveRules`, `validTransaction`, `validRuleInput`, etc.) | `src/lib/rule-engine/__tests__/fixtures.ts` | 20 min | A1 | `tsc --noEmit` passes |
| E2 | Unit tests — conditions: `amount.test.ts` (12 tests), `description.test.ts` (9 tests), `date.test.ts` (4 tests), `entity.test.ts` (3 tests) | `src/lib/rule-engine/__tests__/conditions/*.test.ts` | 60 min | B5, E1 | `npx vitest run` passes for these files |
| E3 | Unit + integration tests — pipeline steps: `pipeline.test.ts` (50 unit + 10 integration = 60 tests) | `src/lib/rule-engine/__tests__/pipeline.test.ts` | 60 min | C5, E1 | `npx vitest run` passes |
| E4 | Unit tests — `evaluateRules`: `index.test.ts` (8 tests: flag gate, validations, happy path, error propagation) | `src/lib/rule-engine/__tests__/index.test.ts` | 25 min | D2, E1 | `npx vitest run` passes |
| E5 | Unit tests — errors: `errors.test.ts` (15 tests: hierarchy, codes, constructors, plus `UnsupportedConditionError` and `UnknownConditionTypeError`) | `src/lib/rule-engine/__tests__/errors.test.ts` | 20 min | A2 | `npx vitest run` passes |

**Phase E total: 185 min**

---

## 2. Dependency Graph

```
A1 ──→ A2 ──→ A3
                │
                ├──→ B1 ──┐
                ├──→ B2 ──┤
                ├──→ B3 ──┤──→ B5 ──→ C2 ──→ C3 ──→ C4 ──→ C5 ──→ D2 ──→ E3
                └──→ B4 ──┘                              │         │
                                                  C1 ────┘         │
                                                              D1 ──┘
                                                  D2 ──→ D3

E1 ──→ E2, E3, E4, E5
A3 ──→ E3, E4 (type imports)
A2 ──→ E5
C5 ──→ E3
D2 ──→ E4
```

**Parallelizable groups:**
- `B1, B2, B3, B4` → fully parallel
- `E2, E3, E4, E5` → fully parallel (after E1)
- `C1` can start as soon as `A1` is done (independent of B phase)

---

## 3. File List

### Created (9 files)

| File | Phase | Task |
|---|---|---|
| `src/lib/rule-engine/errors.ts` | A | A2 |
| `src/lib/rule-engine/index.ts` | A | A3 |
| `src/lib/rule-engine/conditions/amount.ts` | B | B1 |
| `src/lib/rule-engine/conditions/description.ts` | B | B2 |
| `src/lib/rule-engine/conditions/date.ts` | B | B3 |
| `src/lib/rule-engine/conditions/entity.ts` | B | B4 |
| `src/lib/rule-engine/conditions/index.ts` | B | B5 |
| `src/lib/rule-engine/__tests__/fixtures.ts` | E | E1 |
| `src/lib/rule-engine/__tests__/errors.test.ts` | E | E5 |
| `src/lib/rule-engine/__tests__/conditions/amount.test.ts` | E | E2 |
| `src/lib/rule-engine/__tests__/conditions/description.test.ts` | E | E2 |
| `src/lib/rule-engine/__tests__/conditions/date.test.ts` | E | E2 |
| `src/lib/rule-engine/__tests__/conditions/entity.test.ts` | E | E2 |
| `src/lib/rule-engine/__tests__/pipeline.test.ts` | E | E3 |
| `src/lib/rule-engine/__tests__/index.test.ts` | E | E4 |

### Edited (2 files)

| File | Change | Task |
|---|---|---|
| `src/lib/rule-engine/types.ts` | Add `confidence: number` to `Candidate`; change `RuleOutput` to `{ candidates: Candidate[]; decision?: EngineDecision }` | A1 |
| `src/lib/rule-engine/pipeline.ts` | Add 4 step functions + `runPipeline` orchestrator | C1→C5 |

### Unchanged (3 files)

| File | Reason |
|---|---|
| `src/lib/rule-engine/flag.ts` | Already correct — `isRuleEngineV2Enabled()` reads env var |
| `src/lib/rule-engine/compat.ts` | Historical notes only, no runtime code |
| `vitest.config.ts` | Already configured with `@/` alias; test inclusion pattern matches `src/lib/rule-engine/__tests__/**/*.test.ts` |

**Total: 15 files created + 2 files edited = 17 files changed**

---

## 4. Risk Assessment

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **`description_contains` score algorithm**: Dividing `value.length / description.length` when `description.length < value.length` produces `0 < score < 1` instead of `0`. | Medium | Medium | Document in code: if `description.length < value.length` → return `score=0, match=false` before the division. Test EC-16 covers this. |
| R2 | **`amount_range` zero-range edge case**: When `min === max`, `range = 0` causes division by zero. | Low | High | Guard: if `range === 0`, treat as `amount_eq` — score=1 if `tx.amount === midpoint`, else 0. Test EC-11, EC-12 cover both sub-cases. |
| R3 | **`description_matches` invalid regex**: `new RegExp(value)` throws `SyntaxError` for bad patterns. Must catch and throw `InvalidRegex` instead. | Medium | Medium | Wrap `new RegExp(value)` in try/catch → throw `InvalidRegex` with the pattern as `details`. Test EC-30 verifies this. |
| R4 | **`entity_eq` throws `UnsupportedConditionError`**: Any rule with `entity_eq` will fail at runtime in Sprint 1. Affects existing rules that use entity matching. | Low | Medium | Documented as Sprint 1 intentional limitation. Sprint 2 implements entity matching and removes the throw. |

---

## 5. Ordering Rationale

The plan follows strict **bottom-up ordering: leaves → composition → facade**.

```
Types → Errors → Conditions → Pipeline → Public API → Tests
                      ↑            ↑            ↑
                    leaves     composition    facade
```

Each layer imports types and functions from the layer below. No circular dependencies, no stubs, no dead code.

### Why NOT contract-first (Public API before Pipeline)

`evaluateRules` (D2) delegates directly to `runPipeline` (C5). Without C5, D2 cannot compile. A stub that throws "not implemented" adds a rewrite step with zero value — the contract already exists in Phase 3 (API design doc). Writing the facade last, after the internal API is working, ensures the facade is a thin verified wrapper.

### Why NOT Public API before Conditions

Pipeline step 2 (`evaluateConditions`) depends on the `conditionEvaluators` dispatch map (B5). Without evaluators, step 2 cannot be written. Conditions are the leaf functions — they must exist before the pipeline can compose them.

### Why types first (Phase A)

No code compiles without `Candidate.confidence` and `RuleOutput` contracts. `flag.ts` is the only file already correct and independent.

### Why errors second (A2)

Every pipeline step that throws needs error classes. `ConditionEvalError` and subtypes are required by condition evaluators in Phase B. `InvalidInputError` subtypes are required by `evaluateRules()` in Phase D. `UnsupportedConditionError` and `UnknownConditionTypeError` are needed by entity.ts and the dispatch map respectively.

### Why barrel stub third (A3)

`index.ts` is created early as a stub so type imports work for test files in Phase E. A3 defines only the barrel exports and a `evaluateRules` signature — the implementation comes in Phase D once `runPipeline` exists.

### Why conditions before pipeline (B before C)

`evaluateConditions` (C2) is a dispatch over the condition evaluators from Phase B. Without evaluators, step 2 is dead code. C1 (`collectCandidates`) has no dependency on B and can be implemented in parallel.

### Why pipeline before public API (C before D)

`evaluateRules` (D2) delegates to `runPipeline` (C5). Pipeline must be complete before the public facade wraps it.

### Why tests last (Phase E)

All production code must exist before tests can import and verify it. `fixtures.ts` (E1) depends only on `types.ts` and can be written in parallel with Phase B.

---

## 6. Rollback Strategy

**Principle:** The feature flag `isRuleEngineV2Enabled()` is the primary rollback mechanism. Default is `false` — no caller sees the new pipeline until explicitly enabled in production config.

### Per-phase recovery

| Phase | If it fails... | Recovery |
|---|---|---|
| **A** (Foundation) | `tsc` error or wrong type | `git revert <A-commit>`. Only 2 files affected (`types.ts`, `errors.ts`). Zero impact — no code imports the new pipeline yet. Flag is still `false`. |
| **B** (Conditions) | Evaluator returns wrong score or wrong error | `git revert <B-commit>`. Evaluators are only imported by `pipeline.ts` — nobody else calls them. Flag is still `false`. |
| **C** (Pipeline) | Pipeline produces wrong output | `git revert <C-commit>`. `runPipeline` is internal — only `evaluateRules` imports it. Flag `false` → no caller enters. |
| **D** (Public API) | `evaluateRules` has a bug | `git revert <D-commit>`. Flag `false` → callers never reach the new code. The old code path (whatever existed before Sprint 1) continues working. |
| **E** (Tests) | Test fails | No production rollback needed. Fix the test or the code, commit the fix. No revert required. |

### Commit strategy

- **One commit per phase** (A, B, C, D, E). Each commit is atomic: all files for that phase, `tsc` passing, flag still `false`.
- **No `git reset --hard`**: never used unless on a throwaway branch with explicit confirmation.
- **Standard recovery**: `git revert <commit>`.

---

## 7. Definition of Done per Phase

### Phase A — Foundation

- [ ] `tsc --noEmit` passes
- [ ] `RuleOutput` shape is `{ candidates: Candidate[]; decision?: EngineDecision }`
- [ ] `Candidate.confidence` is `number`
- [ ] `new MissingTransaction().code === "ERR_MISSING_TRANSACTION"`
- [ ] `UnsupportedConditionError` and `UnknownConditionTypeError` exist in hierarchy
- [ ] Barrel (`index.ts`) re-exports public types only, NOT internal types
- [ ] Commit A created, flag is still `false`

### Phase B — Condition Evaluators

- [ ] `tsc --noEmit` passes
- [ ] Every `RuleConditionType` has an evaluator in the dispatch map
- [ ] `amount_range` with `[x, x]` behaves like `amount_eq` (never divides by zero)
- [ ] `description_matches` with invalid regex throws `InvalidRegex` (does not crash)
- [ ] `entity_eq` throws `UnsupportedConditionError` — no silent no-match
- [ ] Unknown condition type throws `UnknownConditionTypeError` from dispatch map
- [ ] Commit B created

### Phase C — Pipeline

- [ ] `tsc --noEmit` passes
- [ ] `collectCandidates` filters by `lifecycleStatus ∈ ['active', 'testing']`
- [ ] `evaluateConditions` dispatches correctly to `conditionEvaluators`
- [ ] `discardInvalid` removes entries where any `EvaluatedCondition.match === false`
- [ ] `produceCandidates`: `specificity=0`, `matchQuality=0`, `confidence=0`, `conditionScores` copied
- [ ] `runPipeline(input)` returns `Candidate[]`
- [ ] Commit C created

### Phase D — Public Interface

- [ ] `tsc --noEmit` passes
- [ ] Flag `false` → `evaluateRules` returns `{ candidates: [], decision: undefined }`, pipeline never called
- [ ] Flag `true` + invalid input → throws `InvalidInputError` (typed)
- [ ] Flag `true` + valid input → delegates to pipeline, returns `RuleOutput`
- [ ] Barrel does NOT export `runPipeline`, `EngineDecision`, `EvaluatedCondition`
- [ ] Commit D created

### Phase E — Tests

- [ ] `npx vitest run` passes (all ~92 tests)
- [ ] `tsc --noEmit` passes
- [ ] Every Acceptance Criterion from scope doc has at least one test
- [ ] Every invariant from Sprint 1 has at least one test
- [ ] Error cases covered: invalid inputs, invalid regex, feature flag off, empty rules, unsupported condition, unknown condition type
- [ ] Commit E created

---

## 8. Verification Per Phase

### After Phase A (Foundation)

```bash
tsc --noEmit                    # Must pass with zero errors
```

### After Phase B (Conditions)

```bash
tsc --noEmit                    # Must pass
```

### After Phase C (Pipeline)

```bash
tsc --noEmit                    # Must pass
```

### After Phase D (Public Interface)

```bash
tsc --noEmit                    # Must pass
```

### After Phase E (Tests)

```bash
tsc --noEmit                    # Must pass
npx vitest run                 # All tests pass
```

---

## 9. Implementation Notes per Task

### A1: types.ts changes

```typescript
// Candidate — add confidence
export interface Candidate {
  ruleId: string;
  specificity: number;
  matchQuality: number;
  confidence: number;         // NEW: 0 in Sprint 1, computed in Sprint 2
  conditionScores: number[];
  priority: number;
}

// RuleOutput — decision optional, populated in Sprint 2
export interface RuleOutput {
  candidates: Candidate[];        // NEW: Sprint 1 output
  decision?: EngineDecision;      // undefined in Sprint 1, populated in Sprint 2
}
```

No other types change. `EngineDecision`, `DecisionType`, `DecisionResult`, `AuditLogEntry` remain in `types.ts` for use in later sprints.

### A2: errors.ts

File structure:

```
RuleEngineError (abstract-like base)
├── InvalidInputError
│   ├── MissingTransaction       — code: ERR_MISSING_TRANSACTION
│   ├── MissingContext            — code: ERR_MISSING_CONTEXT
│   └── InvalidTransaction       — code: ERR_INVALID_TRANSACTION
└── ConditionEvalError
    ├── InvalidRegex             — code: ERR_INVALID_REGEX
    ├── InvalidNumericValue      — code: ERR_INVALID_NUMERIC
    ├── InvalidDateValue         — code: ERR_INVALID_DATE
    ├── UnsupportedConditionError  — code: ERR_UNSUPPORTED_CONDITION
    └── UnknownConditionTypeError  — code: ERR_UNKNOWN_CONDITION_TYPE
```

All include `readonly code: string` and `readonly details: unknown`. `ConditionEvalError` adds `readonly conditionType: RuleConditionType`.

### B1: amount.ts

Evaluator signature:

```typescript
type EvaluatorFn = (
  condition: RuleCondition,
  transaction: Transaction,
) => EvaluatedCondition;
```

Export one function per condition type AND a record map:

```typescript
export const amountEvaluators: Partial<Record<RuleConditionType, EvaluatorFn>> = {
  amount_gt: evaluateAmountGt,
  amount_gte: evaluateAmountGte,
  // ...
};
```

`Partial<Record<...>>` because this module only covers `amount_*` types.

### B5: conditions/index.ts

Central dispatch map merging all 4 condition modules:

```typescript
import { amountEvaluators } from './amount';
import { descriptionEvaluators } from './description';
import { dateEvaluators } from './date';
import { entityEvaluators } from './entity';

export const conditionEvaluators: Record<RuleConditionType, EvaluatorFn> = {
  ...amountEvaluators,
  ...descriptionEvaluators,
  ...dateEvaluators,
  ...entityEvaluators,
};
```

With all `Partial` records merged, this is guaranteed complete because each `RuleConditionType` maps to exactly one evaluator.

### C1→C5: pipeline.ts

```typescript
// Step 1
function collectCandidates(input: RuleInput): BankRule[]

// Step 2
function evaluateConditions(
  rules: BankRule[],
  transaction: Transaction,
): [BankRule, EvaluatedCondition[]][]

// Step 3
function discardInvalid(
  entries: [BankRule, EvaluatedCondition[]][],
): [BankRule, EvaluatedCondition[]][]

// Step 4
function produceCandidates(
  entries: [BankRule, EvaluatedCondition[]][],
): Candidate[]

// Orchestrator (exported)
export function runPipeline(input: RuleInput): Candidate[]
```

Key rules:
- `collectCandidates`: filter by `rule.companyId === transaction.companyId` AND `rule.lifecycleStatus === 'active' || rule.lifecycleStatus === 'testing'`
- `evaluateConditions`: for each condition, call `conditionEvaluators[condition.type](condition, transaction)`. If the transaction field is `null`/`undefined` for description ops, produce `score=0, match=false` instead of throwing.
- `discardInvalid`: `entries.filter(([_, evals]) => evals.every(e => e.match === true))`
- `produceCandidates`: `entries.map(([rule, evals]) => ({ ruleId: rule.id, specificity: 0, matchQuality: 0, confidence: 0, conditionScores: evals.map(e => e.score), priority: rule.priority }))`
- `runPipeline`: `pipe(collectCandidates, evaluateConditions, discardInvalid, produceCandidates)` — no mutation, no side effects

### D2: index.ts — evaluateRules

```typescript
export function evaluateRules(input: RuleInput): RuleOutput {
  if (!isRuleEngineV2Enabled()) {
    return { candidates: [], decision: undefined };
  }

  // Validation
  if (input.transaction == null) throw new MissingTransaction();
  if (input.context == null) throw new MissingContext();
  if (!Array.isArray(input.context.availableRules)) throw new MissingContext();
  if (!input.transaction.id || !input.transaction.companyId) throw new InvalidTransaction();

  const candidates = runPipeline(input);
  return { candidates, decision: undefined };
}
```

### E1: fixtures.ts

```typescript
export function makeRule(overrides?: Partial<BankRule>): BankRule
export function makeTransaction(overrides?: Partial<Transaction>): Transaction
export function makeCondition(type: RuleConditionType, value: string | number, range?: [number, number]): RuleCondition
export function makeRuleInput(overrides?: Partial<RuleInput>): RuleInput
export function makeEvaluatedCondition(overrides?: Partial<EvaluatedCondition>): EvaluatedCondition

export const presets = {
  oneActiveRule: BankRule,
  threeActiveRules: BankRule[],
  mixedLifecycleRules: BankRule[],
  validTransaction: Transaction,
  validRuleInput: RuleInput,
  emptyRuleInput: RuleInput,
  invoiceScenarioRule: BankRule,     // amount>500 AND desc contains "INVOICE"
};
```

Test files import from `fixtures.ts` using relative path `../fixtures`.

---

## 10. Final File Tree

```
src/lib/rule-engine/
├── __tests__/
│   ├── fixtures.ts
│   ├── errors.test.ts
│   ├── pipeline.test.ts            # Unit (50 tests) + Integration (10 tests)
│   ├── index.test.ts               # 8 tests
│   └── conditions/
│       ├── amount.test.ts          # 12 tests
│       ├── description.test.ts     # 9 tests
│       ├── date.test.ts            # 4 tests
│       └── entity.test.ts          # 3 tests
├── conditions/
│   ├── index.ts                    # Dispatch map
│   ├── amount.ts
│   ├── description.ts
│   ├── date.ts
│   └── entity.ts
├── compat.ts                       # Unchanged
├── errors.ts                       # NEW
├── flag.ts                         # Unchanged
├── index.ts                        # NEW — public entry point
├── pipeline.ts                     # EDITED — add 4 steps + orchestrator
└── types.ts                        # EDITED — add confidence, change RuleOutput
```

---

## 11. Execution Order (Recommended)

```
Step 1:  A1 (10 min)  — types.ts: Candidate.confidence + RuleOutput
Step 2:  A2 (25 min)  — errors.ts: full hierarchy
Step 3:  A3 (10 min)  — index.ts: barrel stub
Step 4:  B1 (30 min)  — conditions/amount.ts
Step 5:  B2 (30 min)  — conditions/description.ts
Step 6:  B3 (15 min)  — conditions/date.ts
Step 7:  B4 (10 min)  — conditions/entity.ts
Step 8:  B5 (10 min)  — conditions/index.ts: dispatch map
Step 9:  C1 (10 min)  — pipeline.ts: collectCandidates
Step 10: C2 (20 min)  — pipeline.ts: evaluateConditions
Step 11: C3 (10 min)  — pipeline.ts: discardInvalid
Step 12: C4 (10 min)  — pipeline.ts: produceCandidates
Step 13: C5 (5 min)   — pipeline.ts: runPipeline orchestrator
Step 14: D1 (2 min)   — verify flag.ts is correct
Step 15: D2 (20 min)  — index.ts: evaluateRules implementation
Step 16: D3 (5 min)   — verify barrel exports
Step 17: E1 (20 min)  — fixtures.ts
Step 18: E2 (60 min)  — conditions tests (4 files)
Step 19: E3 (60 min)  — pipeline tests
Step 20: E4 (25 min)  — index.test.ts
Step 21: E5 (20 min)  — errors.test.ts (15 tests: hierarchy + 4 new error types)
```

**After each step:** `tsc --noEmit` to verify.

**After E2+E3+E4+E5:** `npx vitest run` — all ~92 tests must pass.

---

## 12. Summary

| Metric | Value |
|---|---|
| **Total estimated effort** | **~7.4 hours** (407 min) |
| **Task count** | 21 tasks |
| **Files created** | 15 |
| **Files edited** | 2 |
| **Files unchanged** | 3 |
| **Test count** | ~92 (across 6 test files) |

### Top 2 Risks

1. **`description_contains` score formula**: `value.length / tx.description.length` produces fractional scores when `value.length < tx.description.length`. Must guard against `value.length > tx.description.length` → score=0. Also handles `null` description → score=0.

2. **`amount_range` division by zero**: When `min === max`, `range = 0`. Must guard with `range === 0` → ternary: if `tx.amount === midpoint` score=1 else score=0. Never divide by zero.
