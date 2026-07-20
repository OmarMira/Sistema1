# S7-05C: Canonical Readiness Service

## 1. Objective

Design a read-only service that evaluates the readiness of the canonical
rule-matching engine (`rule-precedence-engine`) based on aggregated shadow
metrics produced by S7-05B (`ShadowMetricsReport`).

The service must answer the question:

> Given the shadow comparison data collected so far, is the canonical engine
> reliable enough to consider for future activation?

The service **never** activates flags, never modifies matching behaviour,
never changes business rules, and never writes data.

---

## 2. Invariante fundamental

Shadow metrics are **observational**. The readiness service is one more
observer — it consumes an aggregated report and produces a structured
verdict. It must never mutate state, never call Prisma directly, and never
bypass the `ShadowMetricsReader` pipeline.

---

## 3. Scope

- Define `ShadowMetricsProvider` interface (abstraction over the reader).
- Define `ReadinessCriteria` (input thresholds, no defaults).
- Define `ReadinessCheckResult` (structured per-check outcome).
- Define `CanonicalReadiness` (discriminated union verdict).
- Implement `evaluateCanonicalReadiness` (pure orchestration function).
- Evaluate endpoint strategy (extend existing route vs new route).
- Mandate test coverage for every state and edge case.

---

## 4. Exclusions (out of scope)

- Auto-activation of feature flags.
- Dashboards or UI components.
- Persistence of readiness verdicts.
- Caching layer (may be added later if needed).
- Notifications or alerts.
- Changes to matching engines, resolvers, or dispatchers.
- Changes to `shadow-metrics-reader.ts` or `audit-log-repository.ts`.
- Changes to `rule-precedence-shadow.ts`, `rule-precedence-engine.ts`,
  `rule-matching-engine.ts`, `apply-all-engine.ts`, or `import.service.ts`.
- Business defaults for `ReadinessCriteria` — those belong to the caller.

---

## 5. Arquitectura

```
                    ┌──────────────────────────────────┐
                    │  API Route / handler              │
                    │  (decide endpoint in §15)          │
                    └──────────────┬───────────────────┘
                                   │
                    ┌──────────────▼───────────────────┐
                    │  canonical-readiness-service.ts  │
                    │                                   │
                    │  evaluateCanonicalReadiness(      │
                    │    query, criteria, provider      │
                    │  ): CanonicalReadiness             │
                    └──────────────┬───────────────────┘
                                   │  depends on
                                   │  ShadowMetricsProvider
                                   │  (interface)
                                   │
                    ┌──────────────▼───────────────────┐
                    │  ShadowMetricsProvider            │
                    │  ┌──────────────────────────┐    │
                    │  │  ShadowMetricsReader      │    │
                    │  │  (existing — not touched) │    │
                    │  └──────────────────────────┘    │
                    └──────────────────────────────────┘
```

The service sits between the API handler and the reader. It never calls
Prisma, never reads `process.env`, and never instantiates the reader.

---

## 6. ShadowMetricsProvider

```typescript
import type { ShadowMetricsQuery, ShadowMetricsReport }
  from '@/lib/services/shadow-metrics-reader';

export interface ShadowMetricsProvider {
  read(query: ShadowMetricsQuery): Promise<ShadowMetricsReport>;
}
```

**Rationale**: Decouples the readiness service from the concrete reader
implementation. Future providers could wrap a cache, a snapshot file, or
a different backend without changing the evaluation logic.

The existing `ShadowMetricsReader` already conforms to this interface
(its `read(query)` signature is identical), so no adapter is needed.

---

## 7. ReadinessCriteria

```typescript
export interface ReadinessCriteria {
  sample: SampleCriteria;
  quality: QualityCriteria;
  integrity: IntegrityCriteria;
}

export interface SampleCriteria {
  minimumEvaluatedTransactions: number;
  minimumBatches: number;
}

export interface QualityCriteria {
  minimumAgreementRate: number;
  maximumDivergenceRate: number;
  maximumAmbiguityRate: number;
}

export interface IntegrityCriteria {
  maximumErrorRate: number;
  maximumInvalidRecordRate: number;
}
```

**No defaults.** Every field is required. The caller must supply all values.

**Rationale for grouping**: separates concerns so the same service structure
can be reused if future metrics change what constitutes "sample", "quality"
or "integrity". Each group maps to one stage of the decision algorithm (§11).

The service validates the criteria before calling the provider (see §12).

---

## 8. ReadinessCheckResult

```typescript
export type ReadinessCheckOperator = '>=' | '<=';

export interface ReadinessCheckResult {
  code: ReadinessCheckCode;
  operator: ReadinessCheckOperator;
  passed: boolean;
  actual: number | null;
  expected: number;
}

export type ReadinessCheckCode =
  | 'MINIMUM_EVALUATED_TRANSACTIONS'
  | 'MINIMUM_BATCHES'
  | 'MINIMUM_AGREEMENT_RATE'
  | 'MAXIMUM_DIVERGENCE_RATE'
  | 'MAXIMUM_AMBIGUITY_RATE'
  | 'MAXIMUM_ERROR_RATE'
  | 'MAXIMUM_INVALID_RECORD_RATE';
```

**Operator families:**

| Family | Operator | Direction | Example |
|---|---|---|---|
| Sample / agreement | `>=` | actual must be **at least** expected | `agreementRate >= 0.95` |
| Divergence / error | `<=` | actual must be **at most** expected | `divergenceRate <= 0.05` |

Having `operator` as data lets any consumer render or log a check without
encoding which direction each code uses.

Each check is a **deterministic comparison** of `actual` vs `expected`:
`passed = actual !== null && compare(actual, operator, expected)`.

When `actual` is `null`, `passed` is always `false` — a missing value
cannot satisfy any threshold, regardless of direction.

---

## 9. CanonicalReadiness

```typescript
interface CanonicalReadinessBase {
  metrics: ShadowMetricsReport;
  checks: ReadinessCheckResult[];
}

export type CanonicalReadiness =
  | (CanonicalReadinessBase & {
      status: 'READY';
    })
  | (CanonicalReadinessBase & {
      status: 'NOT_READY';
      failedChecks: ReadinessCheckResult[];
    })
  | (CanonicalReadinessBase & {
      status: 'INSUFFICIENT_DATA';
      reasons: string[];
    });
```

**Invariante**: `failedChecks` is always a subset of `checks`:

```
failedChecks ⊆ checks
failedChecks = checks.filter(c => !c.passed)
```

The `reasons` array in `INSUFFICIENT_DATA` contains human-readable
explanations of which sample thresholds were not met and by how much.

The original `metrics` object is returned **unmutated** in all three
variants. The caller can inspect it independently of the verdict.

---

## 10. Algoritmo de evaluación

The algorithm has two distinct phases. Phase 1 produces check data.
Phase 2 consumes that data to produce a single verdict. Checks never
decide the state; the algorithm does.

```
Phase 1 — Build checks (pure data)

  1. Validate criteria (§12). Reject early if invalid.

  2. Call provider.read(query) → report.

  3. Compute effective invalidRecordRate:
       invalidRecordRate = batches > 0
         ? invalidRecords / batches
         : null

  4. Build all 7 checks with operator, actual, expected:

     ┌────────────────────────────────┬──────────┬──────────────────────────────┐
     │ Code                           │ operator │ actual                       │
     ├────────────────────────────────┼──────────┼──────────────────────────────┤
     │ MINIMUM_EVALUATED_TRANSACTIONS │ >=       │ report.totalEvaluated        │
     │ MINIMUM_BATCHES                │ >=       │ report.batches               │
     │ MINIMUM_AGREEMENT_RATE         │ >=       │ report.agreementRate         │
     │ MAXIMUM_DIVERGENCE_RATE        │ <=       │ report.divergenceRate        │
     │ MAXIMUM_AMBIGUITY_RATE         │ <=       │ report.ambiguityRate         │
     │ MAXIMUM_ERROR_RATE             │ <=       │ report.errorRate             │
     │ MAXIMUM_INVALID_RECORD_RATE    │ <=       │ computed invalidRecordRate   │
     └────────────────────────────────┴──────────┴──────────────────────────────┘

  5. For each check:
       passed = actual !== null
         && (operator === '>=' ? actual >= expected : actual <= expected)

Phase 2 — Determine status (§11)

  6. Apply the precedence rules to compute status.

  7. Return CanonicalReadiness verdict.
```

---

## 11. Precedencia de estados

The three states are mutually exclusive and evaluated in strict order.
Once a state matches, evaluation stops.

```
                    ┌──────────────────────────┐
                    │  Build all 7 checks      │
                    │  (Phase 1 complete)      │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │  1. Sample sufficiency?  │
                    │     MIN_EVAL_TRANSACTIONS│
                    │     MINIMUM_BATCHES      │
                    └────────────┬─────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼ (any sample      │ (all sample       │
              │  check fails)    │  checks pass)     │
              │                  │                   │
    ┌─────────▼────────┐  ┌─────▼──────────────────┐
    │ INSUFFICIENT     │  │ 2. Quality + integrity │
    │   _DATA          │  │    All remaining checks│
    │                  │  └─────┬──────────────────┘
    │ reasons[]        │        │
    │ explains which   │   ┌────▼──────────────────┐
    │ threshold(s)     │   │ All pass?             │
    │ were not met     │   │                       │
    └──────────────────┘   └────┬──────────────────┘
                                │
                     ┌──────────┼──────────┐
                     │ YES      │ NO       │
                     ▼          ▼          │
              ┌──────────┐ ┌──────────┐    │
              │  READY   │ │NOT_READY │    │
              │          │ │          │    │
              │          │ │failed    │    │
              │          │ │Checks[]  │    │
              └──────────┘ └──────────┘    │
                                            └── (impossible —
                                                 exhaustive)
```

**INSUFFICIENT_DATA** has absolute priority.

If `totalEvaluated < criteria.sample.minimumEvaluatedTransactions` OR
`batches < criteria.sample.minimumBatches`, the result is immediately
INSUFFICIENT_DATA. Quality and integrity checks are not evaluated. No
null rate can escalate to NOT_READY when the sample itself is
insufficient.

**NOT_READY**: sample is sufficient, but at least one quality or
integrity check fails. `failedChecks` contains every failing check.

**READY**: sample is sufficient and all quality + integrity checks pass.

This strict layering ensures that "not enough data" and "poor quality"
are never conflated.

---

## 12. Validación de criterios

Before calling the provider, the service MUST validate all fields in
`ReadinessCriteria`:

| Group | Field                         | Valid if                          |
|-------|-------------------------------|-----------------------------------|
| sample | `minimumEvaluatedTransactions` | integer >= 0, finite             |
| sample | `minimumBatches`              | integer >= 0, finite              |
| quality | `minimumAgreementRate`       | number in [0, 1], finite          |
| quality | `maximumDivergenceRate`      | number in [0, 1], finite          |
| quality | `maximumAmbiguityRate`       | number in [0, 1], finite          |
| integrity | `maximumErrorRate`         | number in [0, 1], finite          |
| integrity | `maximumInvalidRecordRate` | number in [0, 1], finite          |

If any field is invalid → throw a `ValidationError` (or equivalent typed
error). Do NOT coerce, clamp, or default invalid values. Silent correction
hides bugs from the caller.

---

## 13. Tratamiento de null rates

Rates in `ShadowMetricsReport` can be `null` when the denominator is zero:

| Rate               | null when              |
|--------------------|------------------------|
| `agreementRate`    | `validComparisons > 0` |
| `divergenceRate`   | `validComparisons > 0` |
| `ambiguityRate`    | `validComparisons > 0` |
| `errorRate`        | `totalEvaluated > 0`   |

When `actual` is `null`, the corresponding check **must** have
`passed: false`.

**Due to strict priority (§11), a null rate can never cause
INSUFFICIENT_DATA.** The sample checks (`totalEvaluated`, `batches`)
are always non-null integers. If they pass, the sample is sufficient,
and null rates are evaluated as quality/integrity failures (→ NOT_READY).

The `invalidRecordRate` is computed by the service itself and follows
the same rule: `null` when `batches === 0`.

---

## 14. Trust policy

The service receives `trustPolicy` as part of `ShadowMetricsQuery`. It
does not replace or override it. No default is assumed at the service
level. The caller decides which trust policy to use (e.g.
`INCLUDE_LEGACY_IMPORT` for a balanced picture, `TRUSTED_ONLY` for a
strict evaluation).

---

## 15. Decisión de endpoint

Two alternatives considered:

### A. Extender endpoint existente

```
GET /api/admin/shadow-metrics?readiness=true
```

The existing handler would detect the query param and, if present, call
`evaluateCanonicalReadiness` instead of (or in addition to) the raw report.

| Aspecto | Evaluación |
|---|---|
| Separación de responsabilidades | Media — el handler mezcla dos contratos (reporte crudo vs evaluación) |
| Backward compatibility | Alta — el cambio es aditivo, no rompe clientes existentes |
| Claridad del contrato | Media — `?readiness=true` oculta que la respuesta cambia de tipo |
| Reutilización | Media — el handler necesita lógica condicional |
| Testing | Medio — tests del handler se vuelven más complejos |

### B. Nueva ruta dedicada

```
GET /api/admin/shadow-metrics/readiness
```

| Aspecto | Evaluación |
|---|---|
| Separación de responsabilidades | Alta — cada ruta expone un recurso distinto |
| Backward compatibility | Alta — no afecta la ruta existente en absoluto |
| Claridad del contrato | Alta — `GET /shadow-metrics` devuelve el reporte; `GET /shadow-metrics/readiness` devuelve el veredicto |
| Reutilización | Alta — la nueva ruta puede tener su propio middleware o validaciones |
| Testing | Alta — tests aislados por ruta |

### Decisión

**Se elige la opción B: `GET /api/admin/shadow-metrics/readiness`**.

Justificación: el reporte crudo (S7-05B) y la evaluación de readiness
(S7-05C) son recursos diferentes con contratos de respuesta distintos.
Mezclarlos bajo una misma ruta usando query params oscurece el contrato
y añade complejidad condicional al handler. Una ruta separada mantiene
cada recurso en su propio archivo, facilita el testing independiente, y
evita sorpresas de backward compatibility cuando uno de los dos evoluciona.

La nueva ruta compartirá el middleware `apiHandler` con
`requireSuperAdmin: true` y recibirá los mismos query params que la ruta
existente (`companyId`, `source`, `from`, `to`, `trustPolicy`) más el
nuevo parámetro de criterios de readiness (a definir en tasks).

---

## 16. Manejo de errores

| Situación | Comportamiento |
|---|---|
| `ReadinessCriteria` inválido | Throw `ValidationError` (no llamar al provider) |
| `provider.read()` lanza error | Propagar el error sin atraparlo — el handler lo convierte en 500 |
| `metrics` tiene `null` en campos no esperados | Tratar como datos válidos (el pipeline ya los validó en S7-05B) |
| Query params de ruta inválidos | El handler existente de S7-05B ya los rechaza con 400; la nueva ruta replica esa validación |

---

## 17. Acceptance Criteria

The implementation must pass tests for:

1. **READY** — all checks pass, sample size sufficient.
2. **NOT_READY** by each individual check (7 tests minimum).
3. **INSUFFICIENT_DATA** due to `totalEvaluated < minimum`.
4. **INSUFFICIENT_DATA** due to `batches < minimum`.
5. **INSUFFICIENT_DATA** when both thresholds fail.
6. `null` rates (`agreementRate`, `divergenceRate`, etc.) produce
   `passed: false`.
7. `invalidRecordRate` computed correctly (`invalidRecords / batches`
   when `batches > 0`, `null` when `batches === 0`).
8. Invalid `ReadinessCriteria` rejected with `ValidationError` before
   provider is called.
9. Provider called **exactly once** per `evaluateCanonicalReadiness` call.
10. `metrics` object not mutated after the call.
11. Provider error propagated (not caught by the service).
12. `trustPolicy` from `query` is used verbatim (no override).
13. No access to Prisma, `process.env`, or `ShadowMetricsReader` in the
    service file.

---

## 18. Archivos previstos

| Archivo | Tipo | Acción |
|---|---|---|
| `src/lib/services/canonical-readiness-service.ts` | Service | Crear |
| `src/app/api/admin/shadow-metrics/readiness/route.ts` | API route | Crear |
| `tests/unit/canonical-readiness-service.test.ts` | Tests | Crear |
| `openspec/changes/s7-05c-canonical-readiness/tasks.md` | Tasks | Crear (next phase) |

No se modifican archivos existentes.

---

## 19. Decisiones abiertas

- **ReadinessCriteria serialization in the API**: how should the caller
  pass criteria in the query string? Options: individual query params
  (`quality.minimumAgreementRate=0.95`) or a single JSON-encoded param
  (`criteria={"sample":{"minimumEvaluatedTransactions":100,...}}`).
  To be decided in tasks.

- **Error type for invalid criteria**: `ValidationError` from
  `@/lib/api-error` (existing) or a new type. To be decided in tasks.

- **Exact query param names for the readiness route**: same as S7-05B
  plus criteria serialization. To be decided in tasks.

- **ReadinessCriteria grouping stability**: the split into
  `sample`/`quality`/`integrity` is designed for future reuse. If a
  future S7-06 introduces different metrics, the same three groups
  should accommodate them without changing the service interface.
