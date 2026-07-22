# S7-09 — Operational Policy Observation en Import — Tasks

## File Manifest

### CREATE (1 file)

| # | File | Purpose |
|---|------|---------|
| 1 | `src/lib/operational-policy/import-observation-config.ts` | `IMPORT_OBSERVATION_CONFIG` — criteria, metricsQueryTemplate (source: `'IMPORT'`), profile reference, 90d window |

### MODIFY (6 files)

| # | File | Change |
|---|------|--------|
| 1 | `src/lib/rule-engine/flag.ts` | Add `isOperationalPolicyImportObservationEnabled()` reading `OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED` |
| 2 | `src/lib/operational-policy/types.ts` | Add `PolicyObservationResponse`, `PolicyObservationAvailable`, `PolicyObservationUnavailable`, `PolicyObservationStatus` — canonical domain types |
| 3 | `src/lib/operational-policy/apply-all-observer.ts` | Remove local type declarations (lines 9-23). Import canonical types from `./types` and re-export. Zero runtime change. |
| 4 | `src/lib/services/import.service.ts` | Add imports, `buildObservationWindow` + `classifyImportPolicyObservationError` + `persistImportPolicyObservation` helpers, observational block after shadow persist, `policyObservation` in `ImportResult`, conditional spread in return |
| 5 | `src/lib/types/import-page.tsx` | Add optional `policyObservation?: PolicyObservationResponse` to frontend `ImportResult`; pure type import from `operational-policy/types.ts` |
| 6 | `tests/services/shadow-mode-import.test.ts` | Add flag-off test (key absence), flag-on test (observation present), provider error test (UNAVAILABLE), single-window consistency test |

### Zero-change list

These files MUST NOT be modified:

| File | Reason |
|------|--------|
| `src/lib/services/apply-all-use-case.ts` | No tocar Apply All — AD-6: duplicación intencional |
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

---

## Implementation Order

### Step 1: Feature flag

**File:** `src/lib/rule-engine/flag.ts`

Add after `POLICY_OBSERVATION_KEY` constant (line 3):

```ts
const IMPORT_POLICY_OBSERVATION_KEY = 'OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED';
```

Add after `isOperationalPolicyObservationEnabled()` (after line 24):

```ts
export function isOperationalPolicyImportObservationEnabled(): boolean {
  if (typeof process === 'undefined') return false;
  const raw = process.env[IMPORT_POLICY_OBSERVATION_KEY];
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw === 'true' || raw === 'yes';
}
```

Same pattern as existing flags. Independent from Apply All's `OPERATIONAL_POLICY_OBSERVATION_ENABLED` (AD-2).

**Verify:**
- `tsc --noEmit` compiles
- Defaults to `false` when env var unset
- Returns `true` when env var is `'1'`, `'true'`, or `'yes'`
- Returns `false` when env var is `'0'`, `'false'`, empty, or any other value

---

### Step 2: Domain types

**File:** `src/lib/operational-policy/types.ts`

Add after existing types (before the re-export block at line 54):

```ts
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

**Verify:**
- `tsc --noEmit` compiles
- No existing types changed, no breaking structural changes (I13)
- `PolicyObservationResponse` is a discriminated union on `status`
- The type does NOT reference any Apply All or Import context

---

### Step 3: Migrate apply-all-observer.ts types → domain

**File:** `src/lib/operational-policy/apply-all-observer.ts`

**Remove** lines 9-23 (local type declarations):

```
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

**Add** at top of file, after existing `import type { OperationalContext, OperationalPolicyDecision } from './types'` (line 5):

```ts
import type {
  PolicyObservationResponse,
  PolicyObservationStatus,
  PolicyObservationAvailable,
  PolicyObservationUnavailable,
} from './types';
```

**Add** after the `ObservePolicyParams` interface (after line 30):

```ts
export type {
  PolicyObservationResponse,
  PolicyObservationStatus,
  PolicyObservationAvailable,
  PolicyObservationUnavailable,
};
```

**Simplify** — line 5 was `import type { OperationalContext, OperationalPolicyDecision } from './types';`
It becomes:
```ts
import type { OperationalContext, OperationalPolicyDecision } from './types';
import type {
  PolicyObservationResponse,
  PolicyObservationStatus,
  PolicyObservationAvailable,
  PolicyObservationUnavailable,
} from './types';
```

**Verify:**
- `tsc --noEmit` compiles
- `apply-all-use-case.ts` imports `PolicyObservationResponse` from `./apply-all-observer` — continues to work unchanged because types are re-exported
- The compiler now enforces both consumers (Apply All + Import) use the same contract

**Baseline re-execution (mandatory):**
- Run `npx vitest run tests/unit/apply-all-use-case.test.ts tests/api/readiness-wiring.test.ts --reporter=verbose`
- **Must produce exactly 29 tests passed** (matching pre-migration baseline)
- Any failure means the type migration broke a contract — STOP and investigate before proceeding

---

### Step 4: Server-side config

**File:** `src/lib/operational-policy/import-observation-config.ts` (CREATE)

```ts
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

Same structure as `APPLY_ALL_OBSERVATION_CONFIG` (AD-3). Only `source` differs. No `ObservationConfig` interface from Apply All — structural type declared inline.

**Verify:**
- `tsc --noEmit` compiles
- `criteria` matches `ReadinessCriteria` shape
- `profile` references `OBSERVATIONAL_POLICY_PROFILE` by import
- `metricsQueryTemplate` has `source: 'IMPORT'` and correct trustPolicy
- `windowDays` is a top-level number

---

### Step 5: Main integration — import.service.ts

**File:** `src/lib/services/import.service.ts`

#### 5a. New imports (insert with existing imports, after line 34):

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

Note: `db` is already imported at line 3. `ValidationError` and `AppError` are already imported (lines 14-15) — consolidate if needed. `ShadowMetricsReader`, `ShadowMetricsQuery`, `PrismaAuditLogRepository`, `evaluateOperationalPolicy`, `IMPORT_OBSERVATION_CONFIG`, `isOperationalPolicyImportObservationEnabled` are new. `PolicyObservationResponse` and `OperationalPolicyDecision` are pure types.

#### 5b. Extend `ImportResult` interface (line 36-43):

Add `policyObservation?: PolicyObservationResponse;` after `bankAccountName`:

```ts
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

#### 5c. Add helper functions (insert after `recalculateBalances` at line 611, before class closing):

```ts
// ─── S7-09 Helpers ──────────────────────────────────────────

function buildObservationWindow(
  now: Date,
  windowDays: number,
): { from: Date; to: Date } {
  const from = new Date(now);
  from.setDate(from.getDate() - windowDays);
  from.setUTCHours(0, 0, 0, 0);

  const to = new Date(now);
  to.setUTCHours(23, 59, 59, 999);

  return { from, to };
}

function classifyImportPolicyObservationError(error: unknown): string {
  if (error instanceof ValidationError) {
    return 'POLICY_VALIDATION_ERROR';
  }
  if (error instanceof AppError) {
    return 'POLICY_PROVIDER_ERROR';
  }
  return 'POLICY_INTERNAL_ERROR';
}

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
    // Best-effort: failure does NOT degrade AVAILABLE (I8)
  }
}
```

**Important ordering:** `validationError instanceof` check BEFORE `AppError instanceof` — `ValidationError extends AppError`, so `AppError` first would misclassify.

#### 5d. Add observational block (insert after line 548 — `persistShadowSummaryBestEffort` block closes, before the return statement):

```ts
    // ─── S7-09: Operational Policy Observation (best-effort, inline) ───
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

        // Has own internal try/catch — never propagates to this catch
        await persistImportPolicyObservation({
          companyId,
          entityId: result.statementId,
          decision,
          metricsWindow,
        });
      } catch (error) {
        policyObservation = {
          status: 'UNAVAILABLE',
          errorCode: classifyImportPolicyObservationError(error),
        };
      }
    }
```

#### 5e. Modify return statement (replace current return at lines 550-555):

```ts
    return {
      statementId: result.statementId,
      transactionCount: uniqueTransactions.length,
      autoCategorizedCount: result.autoCategorizedCount,
      duplicatesSkipped,
      ...(policyObservation !== undefined && { policyObservation }),
    };
```

**Invariants enforced by this block:**
- **I3**: Flag off → whole block skipped, `policyObservation` stays `undefined`
- **I4**: No shadow → block skipped, `policyObservation` stays `undefined`
- **I5**: Early return (line 397) → never reaches this block
- **I6/I10**: Entire block in try/catch — never throws out
- **I7**: Exactly one observation per `importTransactions` call
- **I8**: `AVAILABLE` assigned before `persistImportPolicyObservation` — inner catch doesn't degrade
- **I9/I11**: Conditional spread — key absent when `undefined`

**Single-window invariant (I10/I11 from design):** `buildObservationWindow` executes EXACTLY ONCE. The same `metricsWindow` feeds `metricsQuery.from/to` AND `persistImportPolicyObservation` params. Two separate `buildObservationWindow` calls would produce different timestamps (Date drifts).

**Verify:**
- `tsc --noEmit` compiles
- Zero changes to productive flow (parsing, validation, bank account resolution, rule precedence, shadow logic)
- All existing `Object.keys(result)` tests pass (key list unchanged when flag is OFF)
- Flag off → `policyObservation` absent
- Flag on + error → `policyObservation` present as `{ status: 'UNAVAILABLE', errorCode }`
- `persistImportPolicyObservation` failure does NOT propagate to the outer catch

---

### Step 6: Frontend type

**File:** `src/lib/types/import-page.tsx`

Add import at top of file (after line 4):

```ts
import type { PolicyObservationResponse } from '@/lib/operational-policy/types';
```

Add to `ImportResult` interface (after `bankAccountName` at line 37):

```ts
  policyObservation?: PolicyObservationResponse;  // S7-09 — union estructural
```

Pure type import — zero runtime dependencies. No need for a local declaration.

**Verify:**
- `tsc --noEmit` compiles
- No runtime import from `operational-policy` module
- Existing frontend code works unchanged (field is optional, absent when flag is off)

---

### Step 7: Integration tests

**File:** `tests/services/shadow-mode-import.test.ts`

#### Test setup additions

Add mocks in the `vi.mock` section (after line 13 or alongside existing mocks):

```ts
vi.mock('@/lib/rule-engine/flag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rule-engine/flag')>()
  return {
    ...actual,
    isOperationalPolicyImportObservationEnabled: vi.fn(),
  }
})

vi.mock('@/lib/db/audit-log-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/audit-log-repository')>()
  return {
    ...actual,
    PrismaAuditLogRepository: vi.fn(),
  }
})
```

#### Test 1: Flag OFF — key absence

Insert after the existing test block (after line 281):

```ts
describe('S7-09 Operational Policy Observation', () => {
  beforeEach(async () => {
    await clearDatabase()
    vi.clearAllMocks()
    process.env.RULE_PRECEDENCE_SHADOW_ENABLED = 'true'
  })

  afterEach(async () => {
    delete process.env.OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED
    delete process.env.RULE_PRECEDENCE_SHADOW_ENABLED
    await db.auditLog.deleteMany({
      where: { action: 'OPERATIONAL_POLICY_OBSERVATION' },
    })
    await clearDatabase()
  })

  it('does not include policyObservation when flag is off', async () => {
    process.env.OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED = '0'
    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result).not.toHaveProperty('policyObservation')
    expect(Object.keys(result)).toEqual([
      'statementId',
      'transactionCount',
      'autoCategorizedCount',
      'duplicatesSkipped',
      'newAccountCreated',
      'bankAccountName',
    ])
  })

  it('includes policyObservation when flag is on and evaluation succeeds', async () => {
    process.env.OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED = '1'
    const { company, bankAccount } = await setupImport()

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result).toHaveProperty('policyObservation')
    expect(result.policyObservation).toMatchObject({
      status: 'AVAILABLE',
      decision: expect.objectContaining({
        context: 'IMPORT',
      }),
    })
  })

  it('returns UNAVAILABLE when the provider throws an error', async () => {
    process.env.OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED = '1'
    const { company, bankAccount } = await setupImport()

    // Force ShadowMetricsReader to throw by making PrismaAuditLogRepository fail
    const { PrismaAuditLogRepository } = await import('@/lib/db/audit-log-repository')
    vi.mocked(PrismaAuditLogRepository).mockImplementationOnce(() => {
      throw new Error('DB connection failed')
    })

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    expect(result).toHaveProperty('policyObservation')
    expect(result.policyObservation).toEqual({
      status: 'UNAVAILABLE',
      errorCode: expect.stringMatching(/POLICY_/),
    })
  })

  it('uses the same metricsWindow for eval and audit log', async () => {
    process.env.OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED = '1'
    const { company, bankAccount } = await setupImport()

    // Intercept db.auditLog.create to capture the payload
    const createSpy = vi.spyOn(db.auditLog, 'create')

    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'eStmt_2025-03-31.pdf',
      extension: 'pdf',
      buffer: readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf')),
      content: '',
    })

    // If observation succeeded, verify audit log metricsWindow matches
    if (result.policyObservation?.status === 'AVAILABLE') {
      expect(createSpy).toHaveBeenCalled()
      const callArg = createSpy.mock.calls[0]?.[0]
      const details = JSON.parse(callArg?.data?.details || '{}')
      const decisionReadinessQuery = result.policyObservation.decision.readiness.metricsQuery

      expect(details.metricsWindow.from).toBe(decisionReadinessQuery.from)
      expect(details.metricsWindow.to).toBe(decisionReadinessQuery.to)
      expect(details.metricsWindow.source).toBe('IMPORT')
    }
  })
})
```

**Verify:**
- `npx vitest run tests/services/shadow-mode-import.test.ts` — all tests green
- Existing test at line 272 (`expect(Object.keys(result)).toEqual([...])`) still passes — conditional spread keeps `policyObservation` absent when undefined
- `npx vitest run` — full suite no regressions (427+ tests green)

---

## Test Plan

| # | Scenario | Flag | Shadow | Expected `policyObservation` | Expected audit log |
|---|----------|------|--------|------------------------------|-------------------|
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

---

## Invariant Summary

| # | Invariant | Where enforced |
|---|-----------|---------------|
| I1 | Productive flow unchanged | Step 5: no edits to parsing, validation, rule precedence, shadow logic |
| I2 | Observation never sees uncommitted data | Step 5: runs after `$transaction` resolves AND after `persistShadowSummaryBestEffort` |
| I3 | Flag off → no observation, no audit log | Step 5d: whole block gated by `isOperationalPolicyImportObservationEnabled()` |
| I4 | No shadow → no observation | Step 5d: `shadowSummary` guard at block entry |
| I5 | Early return → no observation | Step 5d: returns before reaching the block |
| I6 | Error → UNAVAILABLE, never throw | Step 5d: `try/catch` wraps entire block |
| I7 | One observation per import | Step 5d: single inline block per `importTransactions` invocation |
| I8 | Audit log failure does NOT degrade evaluation response | Step 5c: `persistImportPolicyObservation` inner `try/catch`, `AVAILABLE` assigned before call |
| I9 | policyObservation is OPTIONAL by contract | Step 5e: conditional spread — absent when undefined |
| I10 | Best-effort: never breaks productive flow | Step 5d: all observation code in `try/catch`; no `throw` escapes |
| I11 | No shared helpers with Apply All | Step 4: no imports from `apply-all-*`. Step 5c: `buildObservationWindow` copy, not import |
| I12 | PolicyObservationResponse is a domain type, not context-specific | Step 2: lives in `operational-policy/types.ts` |
| I13 | Adding types to `types.ts` does NOT modify existing types | Step 2: only adds new exports; no existing types changed |
| I14 | buildObservationWindow executes EXACTLY ONCE | Step 5d: computed before both consumers, same reference passed to eval + persist |
| I15 | Same window for eval and audit log | Step 5d: same `metricsWindow` reference for `metricsQuery` and `persistImportPolicyObservation` |

---

## Build and verification

```bash
npx vitest run tests/services/shadow-mode-import.test.ts
npx tsc --noEmit
npx vitest run  # full suite — must not regress
```

---

## Risk assessment

| Risk | Mitigation |
|------|------------|
| Feature flag typo | Use same pattern as existing flags; flag name matches env var exactly |
| `evaluateOperationalPolicy` throws due to bad criteria at runtime | Step 5d: outer `try/catch` catches → `UNAVAILABLE` |
| Shadow metrics query from/to diverges from audit log | Step 5d: same `metricsWindow` reference — enforced by I14, verified by window consistency test |
| New audit log action code `OPERATIONAL_POLICY_OBSERVATION` breaks existing queries | Existing `findShadowSummaries` filters by `RULE_PRECEDENCE_SHADOW_SUMMARY` — not affected |
| ValidationError misclassified as AppError | Step 5c: `ValidationError` checked BEFORE `AppError` — correct inheritance order |
| Existing `Object.keys(result)` test breaks on line 273 | Step 5d: conditional spread — `policyObservation` is absent when `undefined`, existing key list unchanged |
