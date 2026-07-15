# Design: Sprint 4 — Import Service Integration

## Technical Approach

Replace `findMatchingRule()` at line 446 with a pure adapter: maps transactions+rules to v2 engine, normalizes v1 `BankRule.conditions` to v2, maps engine decisions back, returns `MatchResult`. Import Service owns invariant checks and journal creation (existing post-loop at line 471). Flag OFF = legacy path untouched.

## Architecture Decisions

### Decision: Adapter purity boundary

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Adapter imports Prisma | Couples adapter to ORM | Rejected |
| Pre-mapped data from Import Service | Extra params, adapter stays pure | **Accepted** |

### Decision: RuleEngineMatchResult shape

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Single discriminated type | One type, explicit outcome checks | **Accepted** |
| Separate types per outcome | More boilerplate, more imports | Rejected |

### Decision: Conditions normalizer

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Inline in adapter/index.ts | Violates single-responsibility | Rejected |
| Separate module | Testable in isolation | **Accepted** — `detectFormat()` + `normalize()` as distinct exports |

### Decision: Entity resolution & invariants

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Adapter handles them | Breaks purity, needs Prisma | Rejected |
| Import Service handles, passes to adapter | Clean I/O boundary | **Accepted** |

## Data Flow

```
ImportService.importTransactions()
  │
  ├─ RULE_ENGINE_V2_ENABLED=false
  │   └─ findMatchingRule() [legacy — untouched]
  │
  └─ RULE_ENGINE_V2_ENABLED=true
      │
      ├─ 1. Skip invariants check (reconciled, journal-linked, classified, ignored, manually-edited)
      │     └─ skipped → { outcome: 'skipped' }, no engine call
      │
      ├─ 2. Resolve EntityResolution (context from DB)
      ├─ 3. Call runRuleEngineV2(txn, rules, entityResolution, companyId) [adapter]
      │     ├─ a. Fetch active BankRules (already done at line 405)
      │     ├─ b. detectFormat() — check each rule's condition format (v1/v2/corrupt)
      │     ├─ c. normalize() — map v1→v2, reject corrupt with error
      │     ├─ d. Build RuleInput
      │     ├─ e. evaluateRules(input) → RuleEngineExecution
      │     └─ f. Map EngineDecision → MatchResult
      │
      ├─ 4. outcome === 'matched' → set glAccountId + matchedRuleId on txn
      ├─ 5. outcome === 'pending' → store without classification
      └─ 6. [Existing loop at line 471] creates journal entries for txs with glAccountId
```

## Component Boundary

```
ImportService (has Prisma)            Adapter (pure mapping)
┌─────────────────────────┐          ┌─────────────────────────┐
│ Fetch rules from DB     │          │ Normalize conditions    │
│ Check skip invariants   │  data→   │ Build RuleInput         │
│ Resolve entity context  │ ──────→  │ Call evaluateRules()    │
│ Create journal entries  │ ←──────  │ Map decision → result   │
└─────────────────────────┘  result  └─────────────────────────┘
```

## Interfaces

```typescript
// rule-engine-adapter/types.ts
type RuleEngineOutcome = 'matched' | 'pending' | 'skipped';

type SkipReason =
  | 'reconciled'
  | 'journal_linked'
  | 'classified'
  | 'ignored'
  | 'manually_edited';

type RuleEngineErrorCode =
  | 'conditions_normalization_failed'
  | 'engine_execution_error';

type MatchResult =
  | { outcome: 'matched'; classification: { glAccountId: string; entityId?: string; category?: string }; matchedRuleId: string }
  | { outcome: 'pending'; classification?: { glAccountId?: string; entityId?: string; category?: string }; matchedRuleId?: never; skipReason?: never; errorCode?: RuleEngineErrorCode }
  | { outcome: 'skipped'; matchedRuleId?: never; skipReason: SkipReason };

// rule-engine-adapter/index.ts
export async function runRuleEngineV2(
  txn: ParsedTransaction,
  bankRules: PrismaBankRule[],   // pre-fetched by ImportService
  entityResolution: EntityResolution,
  companyId: string,
): Promise<MatchResult>
```

## Outcome Mapping Table

| Engine Decision | glAccountId present | Adapter outcome | Import Service action |
|---|---|---|---|
| `winner` | Yes (`classification.glAccountId` set) | `matched` | Set `glAccountId`, `matchedRuleId` → journal created |
| `winner` | No | `pending` | Store with `glAccountId=null`, `matchedRuleId=null` |
| `ambiguous` | N/A | `pending` | Store with `glAccountId=null`, `matchedRuleId=null` |
| `no_match` | N/A | `pending` | Store with `glAccountId=null`, `matchedRuleId=null` |
| Engine throws | N/A | `pending` | Warning logged, store with `glAccountId=null`, `matchedRuleId=null` |

> **Note**: `matched` ≠ journal entry. Adapter returns `matched` outcome; the Import Service owns creating the journal entry in its existing post-loop at line 471. The adapter never calls Prisma or writes to the database.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/lib/services/rule-engine-adapter.ts` | Create | Adapter: `runRuleEngineV2()` — pure orchestration, no Prisma |
| `src/lib/services/rule-engine-adapter/types.ts` | Create | `MatchResult`, `SkipReason`, `RuleEngineErrorCode` — discriminated union |
| `src/lib/services/rule-engine-adapter/conditions-normalizer.ts` | Create | `detectFormat()` + `normalize()` — format detection separate from transformation |
| `src/lib/services/import.service.ts` | Modify | Line 446: replace `findMatchingRule()` with flag-gated adapter call + invariant pre-check |
| `tests/services/rule-matching-engine.test.ts` | Unchanged | Existing legacy tests continue passing with flag OFF |

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit — normalizer | v1→v2 mapping, invalid conditions, mixed formats | Pure function tests, no mocks needed |
| Unit — adapter | Each outcome mapping, error wrapping, purity | Mock engine, verify result shape |
| Integration — flag OFF | Legacy path unchanged | Verify `findMatchingRule()` is called, adapter is not |
| Integration — flag ON | All 5 outcome paths (matched, winner-no-gl, ambiguous, no_match, error) | Real engine, in-memory rules |

## Migration / Rollout

No migration required. No data rollback required. Env var `RULE_ENGINE_V2_ENABLED=false` by default. Toggle to `true` for testing. Rollback: set to `false`.

## Open Questions

- [ ] What exact v1 condition formats exist in production? (pre-coding validation pass required)
