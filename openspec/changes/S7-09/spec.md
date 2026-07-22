# S7-09 Spec: Operational Policy Observation in Import

## 1. Architecture Overview

```
ImportService.importFile()
         │
         ├── 1. parse + validate (productivo)
         ├── 2. findOrCreateBankAccount (productivo)
         ├── 3. importTransactions → db.$transaction (productivo)
         ├── 4. persistShadowSummaryBestEffort (productivo)
         │
         │   ── S7-09 bloque observacional ──
         ├── 5. [flag] evaluateOperationalPolicy
         ├── 6. [flag] persist audit log (inline)
         │
         └── 7. return { ...result } + conditional spread
```

The productive flow (1–4) is **untouched**. The observational block (5–6) runs only when `isOperationalPolicyImportObservationEnabled()` is on, runs after shadow persistence (AD-1), and never affects the return value of steps 1–4.

## 2. File Manifest

### New files

| # | File | Purpose |
|---|---|---|
| F1 | `src/lib/operational-policy/import-observation-config.ts` | Config: criteria, query template (source: 'IMPORT'), profile reference, window |

### Modified files

| # | File | Change |
|---|---|---|
| F2 | `src/lib/rule-engine/flag.ts` | Add `isOperationalPolicyImportObservationEnabled()` reading `OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED` |
| F3 | `src/lib/operational-policy/types.ts` | Add `PolicyObservationResponse`, `PolicyObservationAvailable`, `PolicyObservationUnavailable` as canonical domain types |
| F4 | `src/lib/operational-policy/apply-all-observer.ts` | Remove local type declarations (lines 9-23). Import canonical types from `./types.ts` and re-export. Zero runtime change |
| F5 | `src/lib/services/import.service.ts` | Add observational block after shadow persist + `policyObservation` to `ImportResult`; import types from `operational-policy/types.ts` |
| F6 | `src/lib/types/import-page.tsx` | Add optional `policyObservation?: PolicyObservationResponse` to frontend `ImportResult`; import type from `operational-policy/types.ts` |
| F7 | `tests/services/shadow-mode-import.test.ts` | Add flag-off test: `not.toHaveProperty('policyObservation')`; existing Object.keys test stays unchanged |

### Untouched (zero changes)

| File | Reason |
|---|---|
| `src/lib/services/apply-all-use-case.ts` | No tocar Apply All — AD-6: duplicación intencional. Sigue importando tipos de `apply-all-observer.ts`, que ahora los re-exporta |
| `src/lib/operational-policy/apply-all-observation-config.ts` | No tocar — AD-3: config separada |
| `src/lib/operational-policy/policy-service.ts` | No tocar — se consume tal cual |
| `src/lib/services/canonical-readiness-service.ts` | No tocar |
| `src/lib/services/shadow-metrics-reader.ts` | No tocar |
| `src/lib/db/audit-log-repository.ts` | No tocar |
| `src/lib/services/rule-precedence-import-resolver.ts` | No tocar |
| `src/lib/services/rule-precedence-shadow.ts` | No tocar |
| `src/app/api/import/route.ts` | No tocar — conditional spread hace que el campo viaje ausente cuando undefined |
| `src/app/cargar-extracto/page.tsx` | No tocar — AD-5: opcional, ausencia no rompe UI |
| Prisma / DB / migrations | No tocar |

## 3. Contracts

### 3.1 Feature flag

```ts
// src/lib/rule-engine/flag.ts

const IMPORT_POLICY_OBSERVATION_KEY = 'OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED';

export function isOperationalPolicyImportObservationEnabled(): boolean {
  if (typeof process === 'undefined') return false;
  const raw = process.env[IMPORT_POLICY_OBSERVATION_KEY];
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw === 'true' || raw === 'yes';
}
```

Behavior:
- `false` (default) → no evaluation, no audit log, `policyObservation` ausente
- `true` → evaluation best-effort

Same pattern as existing flags. Independent from Apply All's flag (AD-2).

### 3.2 Server-side config

```ts
// src/lib/operational-policy/import-observation-config.ts

import type { ReadinessCriteria } from '@/lib/services/canonical-readiness-service';
import type { OperationalPolicyProfile } from './types';
import type { ShadowMetricsQuery } from '@/lib/services/shadow-metrics-reader';
import { OBSERVATIONAL_POLICY_PROFILE } from './observational-policy-profile';

export const IMPORT_OBSERVATION_CONFIG: {
  criteria: ReadinessCriteria;
  profile: OperationalPolicyProfile;
  metricsQueryTemplate: Omit<ShadowMetricsQuery, 'companyId' | 'from' | 'to'>;
  windowDays: number;
} = {
  criteria: {
    sample: {
      minimumEvaluatedTransactions: 100,
      minimumBatches: 3,
    },
    quality: {
      minimumAgreementRate: 0.95,
      maximumDivergenceRate: 0.05,
      maximumAmbiguityRate: 0.02,
    },
    integrity: {
      maximumErrorRate: 0.01,
      maximumInvalidRecordRate: 0.05,
    },
  },
  profile: OBSERVATIONAL_POLICY_PROFILE,
  metricsQueryTemplate: {
    source: 'IMPORT',
    trustPolicy: 'INCLUDE_LEGACY_IMPORT',
  },
  windowDays: 90,
};
```

Same structure as `APPLY_ALL_OBSERVATION_CONFIG` (AD-3). Only `source` differs. No `ObservationConfig` interface is imported from Apply All's config — the structural type is declared inline.

### 3.3 Policy Observation types (domain types in operational-policy/types.ts)

```ts
// src/lib/operational-policy/types.ts — dominio Operational Policy

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

The types live in `operational-policy/types.ts` because `PolicyObservationResponse` is a **domain contract**, not a context-specific implementation detail. It describes the output of evaluating operational policy — a concept that belongs to the Operational Policy domain regardless of which context triggers it.

Both S7-08 (Apply All) and S7-09 (Import) consume the same domain concept:
- `apply-all-observer.ts` has a legacy local copy of an identical union — not touched in S7-09
- `import.service.ts` imports the canonical definition from `operational-policy/types.ts`
- `import-page.tsx` imports the type from `operational-policy/types.ts` — zero runtime dependencies, pure type import

This is **not** a shared abstraction. It's a shared type — and types are free. No behavior, no helpers, no infrastructure. If the domain contract evolves, the compiler forces all consumers to handle the new shape, which is exactly what we want. This is the opposite of the silent divergence problem that duplicating the type would create.

### 3.4 Observational block (inline, no observer module)

The observational logic lives entirely inside `importTransactions()`. No separate `import-observer.ts` file.

```ts
// Inside importTransactions(), after shadow persist

let policyObservation: PolicyObservationResponse | undefined;

if (isOperationalPolicyImportObservationEnabled() && shadowSummary) {
  try {
    const provider = new ShadowMetricsReader(new PrismaAuditLogRepository(db));
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

    // Persistencia propia inline (no reutiliza función de apply-all-use-case.ts)
    await persistImportPolicyObservation({
      companyId,
      entityId: result.statementId,
      decision,
      metricsWindow,
    });
  } catch (error) {
    policyObservation = { status: 'UNAVAILABLE', errorCode: classifyObservationError(error) };
  }
}
```

Rationale for inline approach (no observer module):
- Apply All has `apply-all-observer.ts` because it has a separate use-case file (`apply-all-use-case.ts`) — Import does not
- The block is < 30 lines, tightly coupled to `importTransactions()` context
- Extracting to a separate module adds indirection without isolating a distinct responsibility
- If a third consumer appears, extraction to shared helpers is informed by three implementations, not two

**Note on provider construction**: `import.service.ts` builds `ShadowMetricsReader` and `PrismaAuditLogRepository` because it already owns the `db` instance and the infrastructure dependencies. This is not a pattern of "each service builds its own provider" — it's a consequence of the observation block being inline. If a shared infrastructure layer emerges later, provider construction moves there, not to the observer.

### 3.5 Persistencia propia

```ts
// Inside import.service.ts — private function, no reuse from apply-all-use-case.ts

async function persistImportPolicyObservation(params: {
  companyId: string;
  entityId: string;
  decision: OperationalPolicyDecision;
  metricsWindow: { from: Date; to: Date };
}): Promise<void> {
  const { companyId, entityId, decision, metricsWindow } = params;
  const payload = {
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
  };

  try {
    await db.auditLog.create({
      data: {
        companyId,
        action: 'OPERATIONAL_POLICY_OBSERVATION',
        entity: 'BankStatement',
        entityId,
        details: JSON.stringify(payload),
      },
    });
  } catch {
    // Best-effort: failure to persist does NOT degrade the AVAILABLE response
  }
}
```

### 3.6 ImportResult extension (backend)

```ts
// src/lib/services/import.service.ts — ImportResult

export interface ImportResult {
  statementId: string;
  transactionCount: number;
  autoCategorizedCount: number;
  duplicatesSkipped: number;
  newAccountCreated: boolean;
  bankAccountName: string;
  policyObservation?: PolicyObservationResponse;  // S7-09
}
```

### 3.7 ImportResult extension (frontend)

```ts
// src/lib/types/import-page.tsx — ImportResult

export interface ImportResult {
  statementId: string;
  transactionCount: number;
  autoCategorizedCount: number;
  duplicatesSkipped: number;
  newAccountCreated: boolean;
  bankAccountName: string;
  skippedNote?: string;
  policyObservation?: PolicyObservationResponse;  // S7-09 — union estructural
}
```

The frontend imports `PolicyObservationResponse` from `@/lib/operational-policy/types` — a pure type import with zero runtime dependencies. No need for a local declaration.

## 4. Execution Flow (detailed)

```
importTransactions(companyId, bankAccountId, ...):
  // ─── Productive flow (untouched) ───
  sorted = [...transactions].sort(...)
  hashList = sorted.map(generateImportHash)
  uniqueTransactions = filter out existing hashes

  if uniqueTransactions.length === 0:
    return { statementId: '', transactionCount: 0, ... }
    // ^ early return: no productive execution → no observation

  result = db.$transaction:
    statement = tx.bankStatement.create(...)
    for each transaction: resolveImportRule, accumulate shadow, collect for insert
    tx.bankTransaction.createMany(...)
    create journal entries, recalculate balances
    return { statementId: statement.id, autoCategorizedCount }

  // ─── Shadow persist (productivo, untouched) ───
  if shadowSummary:
    persistShadowSummaryBestEffort(...)

  // ── S7-09 observational block (inline) ──
  let policyObservation: PolicyObservationResponse | undefined

  if isOperationalPolicyImportObservationEnabled() && shadowSummary:
    try:
      provider = new ShadowMetricsReader(new PrismaAuditLogRepository(db))
      window = buildObservationWindow(new Date(), IMPORT_OBSERVATION_CONFIG.windowDays)
      query = { ...IMPORT_OBSERVATION_CONFIG.metricsQueryTemplate, companyId, from: window.from, to: window.to }

      decision = await evaluateOperationalPolicy(
        { context: 'IMPORT', metricsQuery: query },
        IMPORT_OBSERVATION_CONFIG.criteria,
        provider,
        IMPORT_OBSERVATION_CONFIG.profile,
      )

      policyObservation = { status: 'AVAILABLE', decision }

      await persistImportPolicyObservation({ companyId, entityId: result.statementId, decision, metricsWindow: window })
    catch error:
      policyObservation = { status: 'UNAVAILABLE', errorCode: classifyObservationError(error) }
  // ──────────────────────────────

  return {
    statementId: result.statementId,
    transactionCount: uniqueTransactions.length,
    autoCategorizedCount: result.autoCategorizedCount,
    duplicatesSkipped,
    ...(policyObservation !== undefined && { policyObservation }),   // conditional spread
  }
```

### Observation point rationale

The block runs after `persistShadowSummaryBestEffort` (not inside `$transaction`). This satisfies AD-1: the shadow state visible to the policy evaluation is the same state that future consumers see. Running inside `$transaction` would observe uncommitted data.

### Shadow guard

The guard `shadowSummary` is used instead of `result.kind === 'with-shadow'` because in the import flow, `shadowSummary` is `null` when shadow is disabled, and a real `ShadowImportSummary` when enabled.

## 5. Invariants

| # | Invariant | Enforcement |
|---|---|---|
| I1 | Productive flow unchanged | No edits to parsing, validation, bank account resolution, rule precedence, shadow logic |
| I2 | Observation never sees uncommitted data | Runs after `$transaction` resolves AND after `persistShadowSummaryBestEffort` |
| I3 | Flag off → no observation, no audit log | `policyObservation` undefined; whole block gated by flag |
| I4 | No shadow → no observation | Only runs when `shadowSummary` is truthy |
| I5 | Early return (empty transactions) → no observation | Returns before reaching the block |
| I6 | Error → UNAVAILABLE, never throw | `try/catch` wraps the entire block |
| I7 | One observation per import | Single inline block per `importTransactions` invocation |
| I8 | Audit log failure does NOT degrade evaluation response | `AVAILABLE` stays `AVAILABLE` even if `persistImportPolicyObservation` fails (inner try/catch) |
| I9 | policyObservation is OPTIONAL by contract | Conditional spread: absent when flag OFF / shadow disabled / early return |
| I10 | Best-effort: never breaks productive flow | All observation code is in `try/catch`; no `throw` escapes |
| I11 | No shared helpers with Apply All | No imports from `apply-all-use-case.ts` or `apply-all-observation-config.ts`. `apply-all-observer.ts` importa los tipos de `types.ts` — es migración tipada, no helper compartido |
| I12 | PolicyObservationResponse is a domain type, not context-specific | Lives in `operational-policy/types.ts`; Apply All's local copy is legacy tech debt |
| I13 | Adding PolicyObservationResponse to `types.ts` does NOT modify existing types or break S7-07/S7-08 compatibility | Only adds new exports; no existing types changed, no breaking structural changes |

## 6. Audit Log Schema

### Action code

`OPERATIONAL_POLICY_OBSERVATION` — same action code as S7-08 (AD-4).

### Entity and entityId

```
entity: 'BankStatement'
entityId: result.statementId
```

### Persistence

Dedicated inline function `persistImportPolicyObservation()` inside `import.service.ts`. Not reused from `apply-all-use-case.ts`.

### Payload structure

```ts
interface OperationalPolicyObservationPayload {
  policySchemaVersion: 1;
  context: 'IMPORT';
  profileId: string;
  profileVersion: string;
  action: OperationalPolicyAction;
  reasonCode: string;
  readinessStatus: CanonicalReadiness['status'];
  metricsWindow: {
    from: string;   // ISO
    to: string;     // ISO
    source: 'IMPORT';
    trustPolicy: ShadowMetricsTrustPolicy;
  };
}
```

`JSON.stringify`'d into the `details` field of the audit log.

The `metricsWindow` reflects the actual `from`/`to` dates used during evaluation (computed at runtime from `windowDays`), not the config values.

Payload matches S7-08 format except `context: 'IMPORT'` and `source: 'IMPORT'` in `metricsWindow`.

## 7. API Response Changes

### POST /api/import (or equivalent import endpoint)

The `ImportResult` JSON response gains an optional `policyObservation` field. No changes to the route handler — the field is part of `ImportResult`, and conditional spread ensures it is absent when undefined.

**When flag is OFF:**

```json
{
  "statementId": "abc-123",
  "transactionCount": 42,
  "autoCategorizedCount": 30,
  "duplicatesSkipped": 2,
  "newAccountCreated": false,
  "bankAccountName": "Chase Checking"
}
```

`policyObservation` is **absent** from the response — no new key for flag-off consumers.

**When flag is ON and evaluation succeeds:**

```json
{
  "statementId": "abc-123",
  "transactionCount": 42,
  "autoCategorizedCount": 30,
  "duplicatesSkipped": 2,
  "newAccountCreated": false,
  "bankAccountName": "Chase Checking",
  "policyObservation": {
    "status": "AVAILABLE",
    "decision": {
      "action": "ALLOW",
      "context": "IMPORT",
      "profileId": "observational-policy-v1",
      "profileVersion": "1.0.0",
      "readiness": { ... },
      "rules": [ ... ],
      "reasons": {
        "reasonCode": "DIVERGENCE_HIGH",
        "summary": "Rule \"import-not-ready\" matched — DIVERGENCE_HIGH. Action: WARN."
      }
    }
  }
}
```

**When flag is ON and evaluation fails:**

```json
{
  "statementId": "abc-123",
  "policyObservation": {
    "status": "UNAVAILABLE",
    "errorCode": "OBSERVATION_FAILED"
  }
}
```

**Documented semantics of absent `policyObservation`:**
- `policyObservation` absent → feature disabled or no shadow data or flow ended before observation point
- Clients MUST treat absence as "the server did not evaluate operational policy". This is different from "the server evaluated and found no issues" (which would be `{ status: 'AVAILABLE', decision: { action: 'ALLOW', ... } }`).

### Conditional spread implementation

```ts
return {
  statementId: result.statementId,
  transactionCount: uniqueTransactions.length,
  autoCategorizedCount: result.autoCategorizedCount,
  duplicatesSkipped,
  newAccountCreated,
  bankAccountName,
  ...(policyObservation !== undefined && { policyObservation }),
};
```

### Test impact

**Existing test (flag OFF, no conditional spread leak):**

`shadow-mode-import.test.ts:273` asserts exact `Object.keys(result)`. With conditional spread, `policyObservation` is absent when undefined — the existing test passes WITHOUT changes:

```ts
expect(Object.keys(result)).toEqual([
  'statementId',
  'transactionCount',
  'autoCategorizedCount',
  'duplicatesSkipped',
  'newAccountCreated',
  'bankAccountName',
]);
```

**New test — flag OFF, property absence:**

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

**New test — flag ON, includes policyObservation:**

```ts
it('includes policyObservation when flag is on and evaluation succeeds', async () => {
  process.env.OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED = '1';
  const result = await service.importTransactions(/* ... */);
  expect(result).toHaveProperty('policyObservation');
  expect(result.policyObservation).toMatchObject({
    status: 'AVAILABLE',
    decision: expect.objectContaining({
      context: 'IMPORT',
    }),
  });
});
```

## 8. Dependencies

| Dependency | Direction | Rationale |
|---|---|---|
| `import.service.ts` → `flag.ts` | Import | `isOperationalPolicyImportObservationEnabled` — guard |
| `import.service.ts` → `policy-service.ts` | Import | `evaluateOperationalPolicy` |
| `import.service.ts` → `import-observation-config.ts` | Import | `IMPORT_OBSERVATION_CONFIG` |
| `import.service.ts` → `canonical-readiness-service.ts` | Import | `ShadowMetricsProvider` type |
| `import.service.ts` → `shadow-metrics-reader.ts` | Import | `ShadowMetricsReader`, `ShadowMetricsQuery` |
| `import.service.ts` → `audit-log-repository.ts` | Import | `PrismaAuditLogRepository` |
| `import.service.ts` → `types.ts` (operational-policy) | Import | `OperationalPolicyDecision`, `PolicyObservationResponse` |
| `import-page.tsx` → `types.ts` (operational-policy) | Import | `PolicyObservationResponse` — pure type import, zero runtime |
| `import-observation-config.ts` → `observational-policy-profile.ts` | Import | `OBSERVATIONAL_POLICY_PROFILE` |
| `import-observation-config.ts` → types (structural) | Declaration | No `ObservationConfig` interface imported from Apply All |

### Non-dependencies (explicitly excluded)

| Non-dependency | Rationale |
|---|---|
| `import.service.ts` → `apply-all-use-case.ts` | No reuse of `persistOperationalPolicyObservationBestEffort` — persistencia propia inline |
| `import.service.ts` → `apply-all-observer.ts` | No reuse of observer types or functions |
| `import.service.ts` → `apply-all-observation-config.ts` | No reuse of config interface — structural type inline |

---

**End of Spec**
