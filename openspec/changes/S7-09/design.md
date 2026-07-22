# S7-09 Design: Operational Policy Observation in Import

## 1. Execution Sequence (detailed)

### 1.1 Complete flow of `importTransactions`

```
importTransactions(companyId, bankAccountId, ...):
  ┌─────────────────────────────────────────────────────┐
  │ 1. sort + deduplicate by importHash                  │
  │    → early return si uniqueTransactions.length === 0 │
  └─────────────────────────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────┐
  │ 2. db.$transaction (productivo)                      │
  │    ┌───────────────────────────────────────────────┐ │
  │    │ create statement                               │ │
  │    │ for each tx: resolveImportRule, accumulate     │ │
  │    │   shadow if enabled                            │ │
  │    │ bankTransaction.createMany                     │ │
  │    │ journal entries + recalculateBalances          │ │
  │    └───────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────┘
                           │ COMMIT
                           ▼
  ┌─────────────────────────────────────────────────────┐
  │ 3. persistShadowSummaryBestEffort (productivo)       │
  │    → solo si shadowSummary !== null                  │
  └─────────────────────────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────┐
  │ 4. S7-09: Observational block (inline, best-effort)  │
  │                                                      │
  │ let policyObservation: PolicyObservationResponse     │
  │   | undefined                                        │
  │                                                      │
  │ if !isOperationalPolicyImportObservationEnabled():   │
  │   → policyObservation = undefined                    │
  │   → saltar todo el bloque                            │
  │                                                      │
  │ if !shadowSummary:                                   │
  │   → policyObservation = undefined                    │
  │   → saltar (no hay shadow data que observar)         │
  │                                                      │
  │ try:                                                 │
  │   provider = ShadowMetricsReader(                    │
  │     PrismaAuditLogRepository(db))                    │
  │   metricsWindow = buildObservationWindow(            │
  │     new Date(), IMPORT_OBSERVATION_CONFIG.windowDays)│
  │   │                                                   │
  │   query = {                                          │
  │     ...IMPORT_OBSERVATION_CONFIG.metricsQueryTemplate,│
  │     companyId,                                       │
  │     from: metricsWindow.from,                        │
  │     to: metricsWindow.to,                            │
  │   }                                                  │
  │   │                                                   │
  │   decision = evaluateOperationalPolicy(               │
  │     { context: 'IMPORT', metricsQuery: query },       │
  │     IMPORT_OBSERVATION_CONFIG.criteria,               │
  │     provider,                                        │
  │     IMPORT_OBSERVATION_CONFIG.profile,                │
  │   )                                                   │
  │   │                                                   │
  │   policyObservation = { status: 'AVAILABLE',          │
  │                         decision }                    │
  │   │                                                   │
  │   persistImportPolicyObservation(                     │
  │     companyId, entityId: result.statementId,          │
  │     decision, metricsWindow)                          │
  │                                                      │
 │ catch error:                                          │
 │   code = classifyImportPolicyObservationError(error)   │
 │   policyObservation = { status: 'UNAVAILABLE',        │
 │                         errorCode: code }              │
  └─────────────────────────────────────────────────────┘
                           │
                           ▼
  ┌─────────────────────────────────────────────────────┐
  │ 5. return { ..., conditional spread }                │
  │    statementId, transactionCount,                    │
  │    autoCategorizedCount, duplicatesSkipped,          │
  │    ...(policyObservation !== undefined               │
  │        && { policyObservation })                     │
  └─────────────────────────────────────────────────────┘
```

### 1.2 Inline observational block pseudocode

```
// Inserted at line ~548, after persistShadowSummaryBestEffort block

let policyObservation: PolicyObservationResponse | undefined;

if (isOperationalPolicyImportObservationEnabled() && shadowSummary) {
  try {
    const provider = new ShadowMetricsReader(
      new PrismaAuditLogRepository(db),
    );
    const metricsWindow = buildObservationWindow(
      new Date(),
      IMPORT_OBSERVATION_CONFIG.windowDays,
    );

    const metricsQuery: ShadowMetricsQuery = {
      ...IMPORT_OBSERVATION_CONFIG.metricsQueryTemplate,
      companyId,
      from: metricsWindow.from,
      to: metricsWindow.to,
    };

    const decision = await evaluateOperationalPolicy(
      { context: 'IMPORT' as const, metricsQuery },
      IMPORT_OBSERVATION_CONFIG.criteria,
      provider,
      IMPORT_OBSERVATION_CONFIG.profile,
    );

    // AVAILABLE assigned BEFORE persist — I8 guarantee
    policyObservation = { status: 'AVAILABLE', decision };

    // persistImportPolicyObservation has its own internal try/catch
    // It NEVER propagates errors to this outer catch block
    await persistImportPolicyObservation({
      companyId,
      entityId: result.statementId,
      decision,
      metricsWindow,
    });
  } catch (error) {
    // Only reached if evaluateOperationalPolicy or provider construction failed.
    // persistImportPolicyObservation errors are captured inside that function.
    policyObservation = {
      status: 'UNAVAILABLE',
      errorCode: classifyImportPolicyObservationError(error),
    };
  }
}
```

### 1.3 `persistImportPolicyObservation` internals

Uses `db.auditLog.create` directly (same mechanism as S7-08's `persistOperationalPolicyObservationBestEffort`). The `audit-log-repository.ts` is read-only (only `findShadowSummaries`) — no `insert` method exists there, and S7-09 does not add one. `import.service.ts` already imports `db` for other operations.

```
persistImportPolicyObservation({ companyId, entityId, decision, metricsWindow }):

  payload = {
    policySchemaVersion: 1,
    context: 'IMPORT',
    profileId: decision.profileId,
    profileVersion: decision.profileVersion,
    action: decision.action,
    reasonCode: decision.reasons.reasonCode,
    readinessStatus: decision.readiness.status,
    metricsWindow: {
      from: metricsWindow.from.toISOString(),
      to: metricsWindow.to.toISOString(),
      source: 'IMPORT',
      trustPolicy: IMPORT_OBSERVATION_CONFIG.metricsQueryTemplate.trustPolicy,
    },
  }

  try:
    db.auditLog.create({
      data: {
        companyId,
        action: 'OPERATIONAL_POLICY_OBSERVATION',
        entity: 'BankStatement',
        entityId,
        details: JSON.stringify(payload),
      },
    })
  catch:
    // Best-effort — I8: captured internally, does NOT propagate to outer catch.
    // AVAILABLE stays AVAILABLE even if audit log write fails.
```

### 1.4 `classifyImportPolicyObservationError` helper

Reuses the exact same error codes as S7-08 (`apply-all-use-case.ts:37-45`). The `PolicyObservationResponse` is a shared domain type — consumers MUST react identically to the same error class.

```typescript
function classifyImportPolicyObservationError(error: unknown): string {
  if (error instanceof ValidationError) {
    return 'POLICY_VALIDATION_ERROR';
  }
  if (error instanceof AppError) {
    return 'POLICY_PROVIDER_ERROR';
  }
  return 'POLICY_INTERNAL_ERROR';
}
```

`ValidationError` checked before `AppError` (inheritance order). Error codes match S7-08 exactly: `POLICY_VALIDATION_ERROR`, `POLICY_PROVIDER_ERROR`, `POLICY_INTERNAL_ERROR`.

### 1.5 `buildObservationWindow` (re-uses pattern from apply-all-use-case.ts)

```
buildObservationWindow(now, windowDays):
  from = new Date(now)
  from.setDate(from.getDate() - windowDays)
  from.setUTCHours(0, 0, 0, 0)
  to = new Date(now)
  to.setUTCHours(23, 59, 59, 999)
  return { from, to }
```

This is a **copy** of the function from `apply-all-use-case.ts`. Intentional duplication per AD-6: no shared helpers between Apply All and Import.

### 1.6 Single window invariant

`buildObservationWindow` executes **exactly once**. The same `metricsWindow` reference feeds:

1. `ShadowMetricsQuery.from / .to` — the time range for shadow data evaluation
2. `metricsWindow.from / .to` in the audit log payload — documents what window was evaluated

Two independent window calculations would produce different timestamps (even with the same `windowDays`) because `new Date()` drifts between calls.

```typescript
// CORRECT — single window
const metricsWindow = buildObservationWindow(new Date(), IMPORT_OBSERVATION_CONFIG.windowDays);

const metricsQuery: ShadowMetricsQuery = {
  ...IMPORT_OBSERVATION_CONFIG.metricsQueryTemplate,
  companyId,
  from: metricsWindow.from,
  to: metricsWindow.to,
};

const decision = await evaluateOperationalPolicy(
  { context: 'IMPORT' as const, metricsQuery },
  IMPORT_OBSERVATION_CONFIG.criteria,
  provider,
  IMPORT_OBSERVATION_CONFIG.profile,
);

policyObservation = { status: 'AVAILABLE', decision };

await persistImportPolicyObservation({
  companyId,
  entityId: result.statementId,
  decision,
  metricsWindow,  // ← same reference, not recalculated
});
```

**Test requirement**: verify that the ISO timestamps in the audit log payload match the `from`/`to` used in the metrics query. A test can intercept the audit log payload and compare against a known window.

## 2. Transaction Boundaries

```
┌──────────────────────────────────────────────────┐
│ $transaction                                     │
│  ├── create statement                             │
│  ├── resolve rules, insert transactions           │
│  ├── journal entries + recalculateBalances        │
│  └── COMMIT                                       │
└──────────────────────────────────────────────────┘

persistShadowSummaryBestEffort(...)     ← fuera del tx

observePolicy + persist audit log       ← fuera del tx (nuevas consultas)
```

| Aspect | Decision | Rationale |
|---|---|---|
| Shadow summary inside tx? | **No** — same as today | Best-effort, no reason to couple |
| Policy eval inside tx? | **No** | Would extend tx lifetime; observation reads shadow data written after commit (AD-1) |
| Audit log inside tx? | **No** | Best-effort; failed audit log should never roll back Import |
| `policyObservation` build inside tx? | **N/A** | Built in memory after all I/O completes |

**Consequence**: the productive transaction commits fully before any observation code runs. A crash after commit but before observation means the Import succeeded but no observation was recorded. This is acceptable — the observation is advisory, not contractual.

**Crash scenarios:**

| Crash point | Productive state | Observation state | Acceptable? |
|---|---|---|---|
| Before `$transaction` | Nothing | Nothing | Yes |
| Inside `$transaction` | Tx rolled back | Nothing | Yes |
| After tx commit, before shadow persist | Statement + txs saved, shadow NOT persisted | Nothing | Yes — same risk as shadow today |
| After shadow persist, before observation block | Shadow persisted | Nothing | Yes — observation best-effort |
| Inside observation block (after `AVAILABLE` decision) | Everything committed | Audit log may be missing | Yes — I8: audit log failure doesn't degrade |
| After observation completes | Everything committed | Everything recorded | OK |

## 3. Error Handling

### 3.1 Error propagation map

| Source | Exception type | Catch behavior | `policyObservation` |
|---|---|---|---|---|
| `isOperationalPolicyImportObservationEnabled()` returns `false` | — | Skip block entirely | `undefined` |
| `shadowSummary` is falsy | — | Skip block entirely | `undefined` |
| `new ShadowMetricsReader(...)` | `AppError` | `catch` → `classifyImportPolicyObservationError(e)` | `{ status: 'UNAVAILABLE', errorCode: 'POLICY_PROVIDER_ERROR' }` |
| `evaluateOperationalPolicy(...)` | `ValidationError` | `catch` → `classifyImportPolicyObservationError(e)` | `{ status: 'UNAVAILABLE', errorCode: 'POLICY_VALIDATION_ERROR' }` |
| `evaluateOperationalPolicy(...)` | `AppError` | `catch` → `classifyImportPolicyObservationError(e)` | `{ status: 'UNAVAILABLE', errorCode: 'POLICY_PROVIDER_ERROR' }` |
| `evaluateOperationalPolicy(...)` | Any other | `catch` → `classifyImportPolicyObservationError(e)` | `{ status: 'UNAVAILABLE', errorCode: 'POLICY_INTERNAL_ERROR' }` |
| `ShadowMetricsReader.read(...)` | Any | Propagates to evaluateOperationalPolicy → outer catch | `UNAVAILABLE` |
| `PrismaAuditLogRepository.findShadowSummaries(...)` | Any | Propagates to ShadowMetricsReader → outer catch | `UNAVAILABLE` |
| `persistImportPolicyObservation(...)` — full failure | Any | Internal try/catch, never propagates to outer catch | Unchanged — I8: AVAILABLE stays AVAILABLE |
| `db.auditLog.create(...)` — write failure | Any | Internal try/catch in persistImportPolicyObservation | Unchanged — I8 |

### 3.2 Error codes (matching S7-08)

| `errorCode` | Meaning | Origin |
|---|---|---|
| `'POLICY_VALIDATION_ERROR'` | ValidationError during evaluation | `evaluateOperationalPolicy` throws `ValidationError` |
| `'POLICY_PROVIDER_ERROR'` | Infrastructure / repository failure | `new ShadowMetricsReader(...)`, provider.read, or `AppError` |
| `'POLICY_INTERNAL_ERROR'` | Any other unexpected exception | Catch-all fallback |

`'AUDIT_LOG_FAILURE'` exists internally within `persistImportPolicyObservation`'s catch but is NOT exposed — it never degrades `AVAILABLE` (I8).

### 3.3 `classifyImportPolicyObservationError` helper (inline, in import.service.ts)

Same classification logic as S7-08 (`apply-all-use-case.ts:37-45`). Exact match required because `PolicyObservationResponse` is a shared domain type — consumers must react identically.

```
classifyImportPolicyObservationError(error):
  if error instanceof ValidationError:
    return 'POLICY_VALIDATION_ERROR'
  if error instanceof AppError:
    return 'POLICY_PROVIDER_ERROR'
  return 'POLICY_INTERNAL_ERROR'
```

`ValidationError` checked before `AppError` — inherits from Error, not from AppError. If `AppError` were checked first, a `ValidationError` would be misclassified as `POLICY_PROVIDER_ERROR`.

### 3.4 What CANNOT happen

- The observation block throws out of the try/catch → impossible by design (I6, I10)
- `evaluateOperationalPolicy` programming errors (invalid input, missing criteria) → caught by outer try/catch → `UNAVAILABLE`. Correct: a misconfigured observation should not crash Import.
- Audit log failure degrades AVAILABLE response → impossible (inner try/catch in persistImportPolicyObservation)

## 4. Dependency Diagram

```
apply-all-observer.ts (MIGRATED — types from domain)
  │
  └──→ types.ts (operational-policy)
        └── PolicyObservationResponse (import, not local)


import.service.ts
  │
  ├──→ flag.ts
  │     └── isOperationalPolicyImportObservationEnabled()
  │
  ├──→ import-observation-config.ts (NUEVO)
  │     └── IMPORT_OBSERVATION_CONFIG
  │
  ├──→ shadow-metrics-reader.ts
  │     └── ShadowMetricsReader, ShadowMetricsQuery
  │
  ├──→ db (prisma.auditLog.create — directo, sin repositorio)
  │
  ├──→ operational-policy/policy-service.ts
  │     └── evaluateOperationalPolicy
  │
  ├──→ operational-policy/types.ts
  │     └── PolicyObservationResponse, OperationalPolicyDecision
  │
  └──→ lib/api-error
        └── AppError, ValidationError (for classifyImportPolicyObservationError)


import-observation-config.ts (NUEVO)
  ├──→ operational-policy/observational-policy-profile.ts
  │     └── OBSERVATIONAL_POLICY_PROFILE
  ├──→ operational-policy/types.ts
  │     └── OperationalPolicyProfile (type only)
  ├──→ canonical-readiness-service.ts
  │     └── ReadinessCriteria (type only)
  └──→ shadow-metrics-reader.ts
        └── ShadowMetricsQuery (type only)


import-page.tsx (frontend)
  └──→ operational-policy/types.ts
        └── PolicyObservationResponse (pure type import)
```

### 4.1 Migration: apply-all-observer.ts types → domain

S7-09 adds `PolicyObservationResponse` as a canonical domain type in `operational-policy/types.ts`. The same type family exists as local declarations in `apply-all-observer.ts:9-23` — a legacy duplicate from S7-08. S7-09 resolves this by migrating `apply-all-observer.ts` to import from the canonical source.

Changes to `apply-all-observer.ts`:
- **Remove** lines 9-23 (local type declarations: `PolicyObservationStatus`, `PolicyObservationAvailable`, `PolicyObservationUnavailable`, `PolicyObservationResponse`)
- **Add** import from `./types`
- **Re-export** the types so `apply-all-use-case.ts` (which imports from `apply-all-observer.ts`) continues to work without modification

```typescript
// apply-all-observer.ts — types section after migration
import type {
  OperationalPolicyDecision,
  PolicyObservationResponse,
  PolicyObservationStatus,
  PolicyObservationAvailable,
  PolicyObservationUnavailable,
} from './types';

// Re-export for downstream consumers (apply-all-use-case.ts imports from here)
export type {
  PolicyObservationResponse,
  PolicyObservationStatus,
  PolicyObservationAvailable,
  PolicyObservationUnavailable,
};
```

This migration is **required by S7-09**, not incidental:
- S7-09 introduces the canonical type; leaving a duplicate would mean the domain has no single source of truth
- The change is purely type-level — zero runtime impact, zero behavior change
- All existing Apply All tests remain unchanged
- The compiler now enforces that both consumers (Apply All and Import) use the same contract

### Explicit non-dependencies (enforced by design)

| Not imported from | Rationale |
|---|---|
| `apply-all-use-case.ts` | No reuse of persist function, no shared helpers |
| `apply-all-observation-config.ts` | Config is structurally inline, not extending/sharing an interface |
| Any `apply-all-*` file for behavior/runtime | AD-6: intentional duplication of implementation, NOT of types |

**No circular dependencies.** All arrows point from consumer to producer. `import.service.ts` constructs `ShadowMetricsReader` and accesses `db.auditLog.create` directly because it already owns the `db` instance — no repository wrapper needed for write operations.

## 5. Integration Test Matrix

### 5.1 Test setup

Tests live in `tests/services/shadow-mode-import.test.ts`. Each test calls `ImportService.importTransactions(...)` with a seeded company containing:
- Active bank rules (various priorities to exercise shadow comparison)
- Parsed transactions that produce a shadow summary
- Prior audit log records for readiness evaluation

### 5.2 Test cases

| # | Scenario | Flag | Shadow present | Expected `policyObservation` | Expected audit log |
|---|---|---|---|---|---|
| T1 | Flag OFF, productive success | OFF | Yes | `undefined` | None |
| T2 | Flag OFF, empty transactions (early return) | OFF | N/A | `undefined` | None |
| T3 | Flag ON, shadow present, READY | ON | Yes | `{ status: 'AVAILABLE', decision: { action: 'ALLOW', context: 'IMPORT' } }` | `OPERATIONAL_POLICY_OBSERVATION` created |
| T4 | Flag ON, shadow present, NOT_READY | ON | Yes | `{ status: 'AVAILABLE', decision: { action: 'WARN', reasonCode: 'DIVERGENCE_HIGH' } }` | `OPERATIONAL_POLICY_OBSERVATION` created |
| T5 | Flag ON, shadow present, INSUFFICIENT_DATA | ON | Yes | `{ status: 'AVAILABLE', decision: { action: 'ALLOW', reasonCode: 'INSUFFICIENT_SAMPLE' } }` | `OPERATIONAL_POLICY_OBSERVATION` created |
| T6 | Flag ON, no shadow (shadowSummary is null) | ON | No | `undefined` | None |
| T7 | Flag ON, early return (0 unique transactions) | ON | N/A | `undefined` | None |
| T8 | Flag ON, provider throws (DB error induced) | ON | Yes | `{ status: 'UNAVAILABLE', errorCode: 'POLICY_PROVIDER_ERROR' }` | None |
| T9 | Flag ON, audit log fails, AVAILABLE preserved | ON | Yes | `{ status: 'AVAILABLE', ... }` — not degraded | None (intentional failure) |
| T10 | Flag ON, zero shadow records (empty company) | ON | Yes | `{ status: 'AVAILABLE', decision: { action: 'ALLOW', reasonCode: 'INSUFFICIENT_SAMPLE' } }` | `OPERATIONAL_POLICY_OBSERVATION` created |

### 5.3 Existing test compatibility

Existing test at `shadow-mode-import.test.ts:~273` asserts `Object.keys(result)` with exact key list:
```ts
['statementId', 'transactionCount', 'autoCategorizedCount',
 'duplicatesSkipped', 'newAccountCreated', 'bankAccountName']
```

This test MUST pass without changes when flag is OFF — conditional spread ensures `policyObservation` is absent when `undefined`.

New test to verify:
```ts
it('does not include policyObservation when flag is off', async () => {
  process.env.OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED = '0';
  const result = await service.importTransactions(/* ... */);
  expect(result).not.toHaveProperty('policyObservation');
  expect(Object.keys(result)).toEqual([
    'statementId', 'transactionCount', 'autoCategorizedCount',
    'duplicatesSkipped', 'newAccountCreated', 'bankAccountName',
  ]);
});
```

### 5.4 Test isolation

- Each test creates its own company + data (or uses transaction rollback)
- Prior shadow audit log records created with `action: 'RULE_PRECEDENCE_SHADOW_SUMMARY'` to seed readiness data
- `OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED` env var toggled per test via `vi.stubEnv` or equivalent
- Flag OFF test runs FIRST to verify zero behavioral change to existing assertions

## 6. Implementation Order

| Step | File | Action | What |
|---|---|---|---|---|---|
| 1 | `src/lib/rule-engine/flag.ts` | **Modify** | Add `isOperationalPolicyImportObservationEnabled()` reading `OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED` |
| 2 | `src/lib/operational-policy/types.ts` | **Modify** | Add `PolicyObservationResponse`, `PolicyObservationAvailable`, `PolicyObservationUnavailable`, `PolicyObservationStatus` types — canonical domain contract |
| 3 | `src/lib/operational-policy/apply-all-observer.ts` | **Modify** | Remove local type declarations (lines 9-23). Import types from `./types.ts` and re-export. Zero runtime change |
| 4 | `src/lib/operational-policy/import-observation-config.ts` | **Create** | `IMPORT_OBSERVATION_CONFIG` with source `'IMPORT'`, same structure as `APPLY_ALL_OBSERVATION_CONFIG` but no shared interface |
| 5 | `src/lib/services/import.service.ts` | **Modify** | Add imports, `buildObservationWindow` + `classifyImportPolicyObservationError` + `persistImportPolicyObservation` helper functions, observational block after shadow persist, `policyObservation` in `ImportResult` interface and conditional spread in return |
| 6 | `src/lib/types/import-page.tsx` | **Modify** | Add `policyObservation?: PolicyObservationResponse` to frontend `ImportResult`; import type from `operational-policy/types.ts` |
| 7 | `tests/services/shadow-mode-import.test.ts` | **Modify** | Add flag-off test (key absence), flag-on test (observation present), single-window test, provider error test (UNAVAILABLE). Existing exact-key assertion unchanged |

### Step 3 details (apply-all-observer.ts migration)

**Remove** lines 9-23 (entire type section):
```typescript
// REMOVE these 14 lines from apply-all-observer.ts
export type PolicyObservationStatus = 'AVAILABLE' | 'UNAVAILABLE';

export interface PolicyObservationAvailable {
  status: 'AVAILABLE';
  decision: OperationalPolicyDecision;
}

export interface PolicyObservationUnavailable {
  status: 'UNAVAILABLE';
  errorCode: string;
}

export type PolicyObservationResponse =
  | PolicyObservationAvailable
  | PolicyObservationUnavailable;
```

**Add** imports + re-exports:
```typescript
// ADD at top of file (after existing imports from './types')
import type {
  OperationalPolicyDecision,
  PolicyObservationResponse,
  PolicyObservationStatus,
  PolicyObservationAvailable,
  PolicyObservationUnavailable,
} from './types';

// ADD after the ObservePolicyParams interface
export type {
  PolicyObservationResponse,
  PolicyObservationStatus,
  PolicyObservationAvailable,
  PolicyObservationUnavailable,
};
```

`apply-all-use-case.ts` imports from `apply-all-observer.ts` — it continues to work unchanged because the types are re-exported. Tests unchanged.

### Step 5 details (import.service.ts changes)

**New imports** (insert with existing imports):
```ts
import { ShadowMetricsReader } from '@/lib/services/shadow-metrics-reader';
import type { ShadowMetricsQuery } from '@/lib/services/shadow-metrics-reader';
import { PrismaAuditLogRepository } from '@/lib/db/audit-log-repository';
import { isOperationalPolicyImportObservationEnabled } from '@/lib/rule-engine/flag';
import { evaluateOperationalPolicy } from '@/lib/operational-policy/policy-service';
import { IMPORT_OBSERVATION_CONFIG } from '@/lib/operational-policy/import-observation-config';
import type { PolicyObservationResponse, OperationalPolicyDecision } from '@/lib/operational-policy/types';
import { AppError, ValidationError } from '@/lib/api-error';
```

`db` is already imported at line 3 (`import { db } from '@/lib/db'`). `PrismaAuditLogRepository` is needed for `ShadowMetricsReader` construction (same pattern as `apply-all-use-case.ts:115`).

**ImportResult interface change** — add `policyObservation?: PolicyObservationResponse;`

**New private helper functions** (inserted after `recalculateBalances`, before `extractBankNameFromFilename`):
- `buildObservationWindow(now, windowDays)` — copied from apply-all-use-case.ts (intentional duplication, AD-6)
- `classifyImportPolicyObservationError(error)` — matches S7-08: `POLICY_VALIDATION_ERROR` / `POLICY_PROVIDER_ERROR` / `POLICY_INTERNAL_ERROR`
- `persistImportPolicyObservation(params)` — uses `db.auditLog.create` directly (same approach as S7-08's `persistOperationalPolicyObservationBestEffort`). Inner try/catch, best-effort. `db` already imported at line 3

**Observational block insertion point** — after line 548 (`persistShadowSummaryBestEffort` closing brace), before the return at line 550.

**Return statement change** — replace simple return with conditional spread:
```ts
return {
  statementId: result.statementId,
  transactionCount: uniqueTransactions.length,
  autoCategorizedCount: result.autoCategorizedCount,
  duplicatesSkipped,
  ...(policyObservation !== undefined && { policyObservation }),
};
```
