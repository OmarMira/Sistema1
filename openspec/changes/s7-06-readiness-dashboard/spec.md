# S7-06: Readiness Operations Dashboard

## 1. Objective

Build a read-only admin UI that surfaces the canonical readiness verdict
(`CanonicalReadiness`) produced by S7-05C, allowing a human operator to
inspect shadow metrics, understand why the engine is or isn't ready, and
make an informed decision about manual activation.

The dashboard is **observational only**. It:
- Reads from the existing `GET /api/admin/shadow-metrics/readiness` endpoint.
- Renders metrics, checks, and status.
- Never modifies environment variables, feature flags, or database state.
- Never triggers or affects Import, Apply All, or any matching engine.

---

## 2. Invariant

The readiness API is the single source of truth. The dashboard is a
**renderer** — it formats what the API returns, applies **no business
logic**, and never derives its own readiness verdict.

In particular:
- No local comparison of rates against thresholds. Pass/fail state comes
  exclusively from `ReadinessCheckResult.passed` as returned by the API.
- No formula recomputation of divergence, ambiguity, or agreement rates.
- No second fetch to `/api/admin/shadow-metrics` — all metrics are
  available inside `CanonicalReadiness.metrics`.
- No component references check code strings directly. All lookups go
  through a single mapper module (see §10).

---

## 3. Scope

- Add `'admin-readiness'` view to the SPA router (`useAuthStore.ViewName`).
- Create `AdminReadinessDashboardPage` component.
- Create sub-components (see canonical list in §5).
- Register the view in `SuperAdminDashboardPage` (sidebar nav + conditional
  render).
- Add translation keys (en/es) for all new UI strings.

---

## 4. Exclusions (out of scope)

- Auto-activation of feature flags.
- Writing readiness decisions to the database.
- Caching layer (may be added later if needed).
- Notifications, alerts, or email.
- Changes to Import, Apply All, or matching engines.
- Changes to `shadow-metrics-reader.ts`, `canonical-readiness-service.ts`,
  `audit-log-repository.ts`, or any existing API route.
- New API endpoints — the dashboard consumes only
  `GET /api/admin/shadow-metrics/readiness`.
- URL-based deep linking (Zustand-only routing, consistent with existing
  admin pages).
- Pagination (the readiness endpoint returns a single verdict per query).
- Persistence of thresholds or form preferences.

---

## 5. Canonical component list

| Component | Role |
|---|---|
| `AdminReadinessDashboardPage` | Orchestrator — state, fetch, render |
| `ReadinessCriteriaForm` | Source, trust policy, date range, threshold inputs |
| `ReadinessStatusCard` | Status badge (icon + label + reasons list) |
| `ReadinessMetricsGrid` | Batch + transaction summary cards (7 metrics) |
| `ReadinessRatesGrid` | 4 rate cards with pass/fail from checks |
| `ReadinessChecksTable` | Per-check result table |
| `ReadinessRecommendationBanner` | Textual recommendation per status |
| `TrustPolicyWarning` | Warning when LEGACY_UNTRUSTED is included |

---

## 6. Three-state form architecture

The page separates three concerns to avoid stale data rendering:

```typescript
// Form state — what the user is editing (not yet submitted)
const [draftForm, setDraftForm] = useState<ReadinessForm>(initialProfile);

// Query state — what was last applied
const [appliedQuery, setAppliedQuery] = useState<ReadinessForm | null>(null);

// Result state — what the API returned for appliedQuery
const [readinessResult, setReadinessResult] = useState<CanonicalReadiness | null>(null);
```

**Rules:**
- The dashboard ALWAYS renders from `readinessResult` and `appliedQuery`.
- Editing `draftForm` never changes the displayed data.
- Only clicking "Aplicar" moves `draftForm` → `appliedQuery` and triggers
  a fetch.
- `TrustPolicyWarning` reads from `appliedQuery.trustPolicy`, not from
  `draftForm.trustPolicy`.

---

## 7. Data flow (single fetch)

```
User edits draftForm (no side effects)
    │
    ▼
User clicks "Aplicar"
    │
    ▼
1. Assign: appliedQuery = { ...draftForm }
2. Increment requestId
3. Fetch GET /api/admin/shadow-metrics/readiness
   with query params:
     companyId   = adminSelectedCompanyId
     source      = appliedQuery.source
     from        = appliedQuery.from (ISO start-of-day)
     to          = appliedQuery.to (ISO end-of-day)
     trustPolicy = appliedQuery.trustPolicy
     + 7 threshold params from appliedQuery
    │
    ▼
4. On response: check requestId matches latest
   (ignore stale responses from earlier clicks)
    │
    ▼
5. If match → setReadinessResult(response)
   If error with existing data → keep previous result, show error banner
   If error without existing data → show error state with retry
```

**Key constraints:**
- Exactly **one fetch** per "Aplicar" click. No second call to
  `/api/admin/shadow-metrics`.
- All metrics rendered from `readinessResult.metrics`.
- Concurrency protection via `AbortController` or incremental `requestId`
  to discard out-of-order responses.

---

## 8. Company selection guard

The dashboard requires `adminSelectedCompanyId` from `useAuthStore`.

```typescript
const { adminSelectedCompanyId } = useAuthStore();

if (!adminSelectedCompanyId) {
  return (
    <div className="...">
      <p>Select a company first to view readiness data.</p>
      <p>Seleccione una compañía primero para ver los datos de readiness.</p>
    </div>
  );
}
```

No fetch is executed without a companyId. No hardcoded fallback.

---

## 9. UI layout

```
┌─────────────────────────────────────────────────────────────┐
│  Header: "Readiness Operations Dashboard"                   │
│  [UseCaseAlert: observational only]                          │
├─────────────────────────────────────────────────────────────┤
│  ReadinessCriteriaForm                                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ [Source: ▼] [Trust Policy: ▼] [From: ██] [To: ██]   │  │
│  │ [▼ Thresholds (collapsible)]                          │  │
│  │   Sample: minEvalTxs [100]  minBatches [3]           │  │
│  │   Quality: minAgree [0.95] maxDiv [0.05] maxAmb [0.02]│  │
│  │   Integrity: maxError [0.01] maxInvalid [0.05]        │  │
│  │ [Aplicar]                                              │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─────────────────────┐  ┌─────────────────────────────┐   │
│  │  ReadinessStatusCard│  │  ReadinessMetricsGrid       │   │
│  │  🟢 READY            │  │  Batches:1 Evaluated:200   │   │
│  │                     │  │  Valid:200 Same:200         │   │
│  └─────────────────────┘  │  Divergent:0 Ambiguous:0    │   │
│                            │  Errors:0                   │   │
│                            └─────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ReadinessRatesGrid (4 cards, pass/fail from checks)  │   │
│  │  ┌────────┐ ┌──────────┐ ┌─────────┐ ┌──────────┐   │   │
│  │  │Agree   │ │Divergence│ │Ambiguity│ │Error     │   │   │
│  │  │ 100% ✅│ │ 0% ✅    │ │ 0% ✅   │ │ 0% ✅    │   │   │
│  │  └────────┘ └──────────┘ └─────────┘ └──────────┘   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ TrustPolicyWarning (only when appliedQuery shows ─────┐  │
│  │  INCLUDE_UNTRUSTED_HISTORY + legacyUntrustedBatches>0)  │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ReadinessChecksTable                                │   │
│  │  (always visible, even in INSUFFICIENT_DATA)         │   │
│  │  ┌──────────────┬────────┬───────┬─────────┬──────┐ │   │
│  │  │ Check        │ Status │Actual │Expected │Op    │ │   │
│  │  │ MIN_EVAL_TXS │ ✅     │ 200   │ 1       │ >=   │ │   │
│  │  │ MIN_BATCHES  │ ✅     │ 1     │ 1       │ >=   │ │   │
│  │  │ ...          │        │       │         │      │ │   │
│  │  └──────────────┴────────┴───────┴─────────┴──────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ReadinessRecommendationBanner                        │   │
│  │  "El motor cumple los criterios definidos. La        │   │
│  │   activación continúa siendo manual."                 │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 10. Rate-to-check mapper (single source of truth)

To prevent UI components from hardcoding check code strings, a single
mapper module centralises all rate-to-check lookups:

**File:** `src/lib/readiness/rate-check-mapper.ts`

```typescript
import type { ReadinessCheckResult, ReadinessCheckCode }
  from '@/lib/services/canonical-readiness-service';

export type RateKey = 'agreementRate' | 'divergenceRate' | 'ambiguityRate' | 'errorRate';

export const RATE_TO_CHECK_CODE: Record<RateKey, ReadinessCheckCode> = {
  agreementRate: 'MINIMUM_AGREEMENT_RATE',
  divergenceRate: 'MAXIMUM_DIVERGENCE_RATE',
  ambiguityRate: 'MAXIMUM_AMBIGUITY_RATE',
  errorRate: 'MAXIMUM_ERROR_RATE',
};

export function getCheckForRate(
  checks: ReadinessCheckResult[],
  rateKey: RateKey,
): ReadinessCheckResult | undefined {
  const code = RATE_TO_CHECK_CODE[rateKey];
  return checks.find(c => c.code === code);
}

export function getRatePassed(
  checks: ReadinessCheckResult[],
  rateKey: RateKey,
): boolean | undefined {
  return getCheckForRate(checks, rateKey)?.passed;
}
```

**Contract:**
- The mapper is the **only** place where check code strings exist.
- No component or sub-component imports `'MINIMUM_AGREEMENT_RATE'`
  directly.
- If a future backend version renames a check code, only this file
  changes.

**Color and status derivation:**

Colours come exclusively from `ReadinessCheckResult.passed`:

| `passed` | Visual |
|---|---|
| `true` | Green icon/indicator |
| `false` | Red/amber icon/indicator |
| `undefined` (check absent) | Gray, `"—"` |

Colour is never the sole indicator — every status includes icon + text label.

---

## 11. Null rate display

When a rate in `ShadowMetricsReport` is `null`, display `"—"` (em dash),
never `"0"`, `"0%"`, or `"N/A"`.

```typescript
function formatRate(value: number | null): string {
  return value !== null ? `${(value * 100).toFixed(1)}%` : '—';
}
```

---

## 12. Date range contract

The form sends `from` and `to` as ISO 8601 strings with explicit
time-of-day:

| Input | User sees | Sent to API |
|---|---|---|
| `from` | `YYYY-MM-DD` (date picker) | `YYYY-MM-DDT00:00:00.000Z` (start of day, UTC) |
| `to` | `YYYY-MM-DD` (date picker) | `YYYY-MM-DDT23:59:59.999Z` (end of day, UTC) |

Conversion is explicit — no reliance on `new Date('YYYY-MM-DD')` implicit
parsing:

```typescript
function toStartOfDay(isoDate: string): string {
  return `${isoDate}T00:00:00.000Z`;
}
function toEndOfDay(isoDate: string): string {
  return `${isoDate}T23:59:59.999Z`;
}
```

The applied date range is displayed next to the results so the operator
can confirm what period was queried.

---

## 13. UI states per component

| State | Loading (initial) | Loading (refetch) | Error (no data) | Error (with data) | Loaded |
|---|---|---|---|---|---|
| Status card | Skeleton | Skeleton overlay | Error + retry | Keep old + error banner | Render |
| Metrics grid | Skeletons | Keep old values | — | Keep old + error banner | Render |
| Rates grid | Skeletons | Keep old values | — | Keep old + error banner | Render |
| Checks table | Skeleton rows | Keep old rows | — | Keep old + error banner | Render |
| Banner | Hidden | Hidden | Hidden | Hidden | Render |

On initial load with no data: spinner in content area.

On refetch: old data stays visible; a subtle spinner or none at all in
the form area (the user initiated the action via "Aplicar").

On failed refetch with existing data: preserve the previous result,
append a dismissible error banner above the results.

On failed fetch with no existing data (initial): show centered error
message + retry button.

---

## 14. Concurrency protection

Every "Aplicar" click must abort any in-flight request from a previous
click. **`AbortController` is the primary mechanism.**

```typescript
const abortRef = useRef<AbortController | null>(null);

const handleApply = useCallback(async () => {
  // Cancel previous in-flight request
  abortRef.current?.abort();
  const controller = new AbortController();
  abortRef.current = controller;

  setAppliedQuery({ ...draftForm });

  try {
    const res = await fetch(url, { signal: controller.signal });
    const data = await res.json();
    setReadinessResult(data);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return;
    // handle actual error
  }
}, [draftForm]);
```

**Policy on cancelled requests:**
Aborted requests (those cancelled by a subsequent click) must NOT:
- show error banners or toasts;
- log error-level messages (debug-level is acceptable);
- change the displayed data in any way.

A cancellation is not a functional failure — it is normal UX flow.

**Fallback:** a monotonic `requestId` counter may be used alongside
AbortController to guard against edge cases where the AbortError is
swallowed or the signal is not supported. The invariant is that a late
response never overwrites a newer one.

---

## 15. Initial ReadinessProfile (UI-level, not service defaults)

Defined in its own file, outside any component:

**File:** `src/lib/readiness/default-readiness-profile.ts`

```typescript
export interface ReadinessForm {
  source: 'ALL' | 'IMPORT' | 'APPLY_ALL';
  trustPolicy: 'TRUSTED_ONLY' | 'INCLUDE_LEGACY_IMPORT' | 'INCLUDE_UNTRUSTED_HISTORY';
  from: string | null;    // computed on mount
  to: string | null;      // computed on mount
  minimumEvaluatedTransactions: number;
  minimumBatches: number;
  minimumAgreementRate: number;
  maximumDivergenceRate: number;
  maximumAmbiguityRate: number;
  maximumErrorRate: number;
  maximumInvalidRecordRate: number;
}

export const INITIAL_READINESS_PROFILE: ReadinessForm = {
  source: 'ALL',
  trustPolicy: 'INCLUDE_LEGACY_IMPORT',
  from: null,
  to: null,
  minimumEvaluatedTransactions: 100,
  minimumBatches: 3,
  minimumAgreementRate: 0.95,
  maximumDivergenceRate: 0.05,
  maximumAmbiguityRate: 0.02,
  maximumErrorRate: 0.01,
  maximumInvalidRecordRate: 0.05,
};
```

**Contract:**
- These values belong **exclusively to the client**.
- They are **editable** by the operator before each query.
- They are **not persisted** across page reloads.
- They are **not defaults of the readiness service** — the service
  requires all criteria to be supplied explicitly.
- They do **not represent authorization** to activate the canonical
  engine.
- Extracting the profile to a standalone file makes it reusable,
  testable, and avoids recreating the object on every render.

---

## 16. Input types

- **Date picker**: native `<input type="date">` for simplicity (no
  calendar popover overhead). The admin doesn't need minute-level
  precision.
- **Thresholds**: `ThresholdsAccordion` (collapsible) to keep the form
  compact. Sample section visible by default; Quality and Integrity
  collapsed by default.
- **Source/Trust policy**: shadcn `<Select>` with options from the valid
  values.

---

## 17. TrustPolicyWarning

Trigger condition: `appliedQuery.trustPolicy === 'INCLUDE_UNTRUSTED_HISTORY'`
AND `readinessResult.metrics.legacyUntrustedBatches > 0`.

Always reads from `appliedQuery` (the policy that produced the result),
never from `draftForm`.

```text
⚠️ Incluyendo datos LEGACY_UNTRUSTED
Esta visualización incluye batches de Apply All v0, que no son
totalmente confiables. Los rates pueden estar inflados o subestimados.
Considere usar "INCLUDE_LEGACY_IMPORT" para una visión más conservadora.
```

---

## 18. ReadinessRecommendationBanner

| Status | Text (es) | Text (en) |
|---|---|---|
| READY | El motor cumple los criterios definidos. La activación continúa siendo manual. | The engine meets the defined criteria. Activation remains manual. |
| NOT_READY | El motor no cumple los criterios definidos. Revise los checks fallidos antes de considerar activación. | The engine does not meet the defined criteria. Review failed checks before considering activation. |
| INSUFFICIENT_DATA | Datos insuficientes para evaluar. Es necesario acumular más batches antes de evaluar la readiness. | Insufficient data to evaluate. More batches are needed before assessing readiness. |

---

## 19. Translation keys

New keys in `admin.readiness.*`:

```
admin:
  readiness:
    title: Readiness Operations Dashboard / Panel de Readiness
    subtitle: Inspect canonical engine readiness metrics / Inspeccione las
              métricas de readiness del motor canónico
    useCaseAlert: This dashboard is observational only. It reads readiness
                  data without modifying any system state. / Este panel es
                  solo de observación. Lee datos de readiness sin modificar
                  ningún estado del sistema.
    companyRequired: Select a company first to view readiness data. /
                     Seleccione una compañía primero para ver los datos.
    source: Source / Fuente
    trustPolicy: Trust Policy / Política de confianza
    from: From / Desde
    to: To / Hasta
    apply: Apply / Aplicar
    thresholds: Thresholds / Umbrales
    sample: Sample / Muestra
    quality: Quality / Calidad
    integrity: Integrity / Integridad
    status: Status / Estado
    batches: Batches / Batches
    totalEvaluated: Total Evaluated / Evaluados
    validComparisons: Valid Comparisons / Válidos
    sameDecision: Same Decision / Misma decisión
    divergentDecision: Divergent / Divergentes
    ambiguous: Ambiguous / Ambiguos
    errors: Errors / Errores
    agreementRate: Agreement / Acuerdo
    divergenceRate: Divergence / Divergencia
    ambiguityRate: Ambiguity / Ambigüedad
    errorRate: Error / Error
    check: Check / Check
    actual: Actual / Actual
    expected: Expected / Esperado
    operator: Op / Op
    passed: Passed / Aprobado
    failed: Failed / Falló
    recommendation: Recommendation / Recomendación
    insufficientReasons: Insufficient data reasons / Motivos de datos
                         insuficientes
    untrustedWarning: Including LEGACY_UNTRUSTED data / Incluyendo datos
                      LEGACY_UNTRUSTED
    untrustedWarningDesc: This view includes Apply All v0 batches, which
                          are not fully trustworthy. / Esta visualización
                          incluye batches de Apply All v0 que no son
                          totalmente confiables.
    loading: Loading readiness data... / Cargando datos de readiness...
    refetching: Updating... / Actualizando...
    error: Failed to load readiness data / Error al cargar datos de
           readiness
    retry: Retry / Reintentar
    noData: No readiness data available / No hay datos de readiness
            disponibles
    periodLabel: Period / Período
```

---

## 20. Integration with SuperAdminDashboardPage

1. **Auth store** (`src/store/auth-store.ts`): add `'admin-readiness'` to
   the `ViewName` union type.

2. **Sidebar nav** (`SuperAdminDashboardPage.tsx`): add a nav button
   "Readiness Dashboard" between "Audit Logs" and "Back to company
   selector". Use `Activity` icon (lucide). Follow the exact same pattern
   as existing nav buttons.

3. **Conditional render** (`SuperAdminDashboardPage.tsx`): add
   `{currentView === 'admin-readiness' && <AdminReadinessDashboardPage />}`
   in the main content area, in alphabetical/logical order with existing
   views.

4. **Header title map**: add
   `'admin-readiness': t('admin.readiness.title')` to the header title
   mapping.

---

## 21. Conventions

Follow the exact patterns established by existing admin pages:

- `'use client'` at the top.
- `useLanguageStore((s) => s.t)` for translations.
- `useAuthStore()` for `adminSelectedCompanyId`.
- `useEffect` + `useCallback` + `useState` for data fetching (raw `fetch`,
  no React Query).
- `logger.error()` for error logging.
- `cn()` for conditional classnames.
- `motion.div` with `initial/animate` for entry animations.
- All icons from `lucide-react`.
- All UI primitives from `@/components/ui/*` (shadcn).
- All fetches use `credentials: 'include'` to send the session cookie
  (consistent with existing admin pages).
- Container: `space-y-6 max-w-7xl mx-auto`.
- Cards: `rounded-2xl border shadow-sm bg-card text-card-foreground`.

---

## 22. Performance

The dashboard shall minimise network activity:

- **Initial fetch**: fires once on mount (auto-apply of initial profile).
- **Subsequent fetches**: fire only on explicit "Aplicar" click or Retry.
- **No fetch while typing**: editing form fields never triggers a request.
- **No polling**: the page does not auto-refresh.
- **No debounce or throttle**: network activity is always user-initiated.

These rules ensure the dashboard is idle unless the operator explicitly
requests new data.

---

## 23. Files to create

| File | Type |
|---|---|
| `src/lib/readiness/default-readiness-profile.ts` | Profile + types |
| `src/lib/readiness/rate-check-mapper.ts` | Rate-to-check mapper |
| `src/components/spa/admin/AdminReadinessDashboardPage.tsx` | Page component |
| `src/components/spa/admin/readiness/ReadinessStatusCard.tsx` | Sub-component |
| `src/components/spa/admin/readiness/ReadinessCriteriaForm.tsx` | Sub-component |
| `src/components/spa/admin/readiness/ReadinessMetricsGrid.tsx` | Sub-component |
| `src/components/spa/admin/readiness/ReadinessRatesGrid.tsx` | Sub-component |
| `src/components/spa/admin/readiness/ReadinessChecksTable.tsx` | Sub-component |
| `src/components/spa/admin/readiness/ReadinessRecommendationBanner.tsx` | Sub-component |
| `src/components/spa/admin/readiness/TrustPolicyWarning.tsx` | Sub-component |

---

## 24. Files to modify

| File | Change |
|---|---|
| `src/store/auth-store.ts` | Add `'admin-readiness'` to `ViewName` |
| `src/components/spa/admin/SuperAdminDashboardPage.tsx` | Import + register page, add nav button, add header title |
| `src/i18n/locales/en.ts` | Add readiness translation keys |
| `src/i18n/locales/es.ts` | Add readiness translation keys |

---

## 26. Acceptance criteria

1. Page auto-fetches readiness with initial profile on mount when
   `adminSelectedCompanyId` is set.
2. Without `adminSelectedCompanyId`, shows company-required message
   and does NOT fetch.
3. Status card renders correct icon + colour for READY / NOT_READY /
   INSUFFICIENT_DATA.
4. Metrics grid renders all 7 numeric fields from
   `readinessResult.metrics`.
5. Rates grid shows 4 rates with pass/fail derived from check results,
   not from local comparison.
6. `null` rates display as `"—"`, never as `"0%"`.
7. Checks table always visible, including INSUFFICIENT_DATA.
8. INSUFFICIENT_DATA shows reasons above checks table.
9. NOT_READY shows failed checks highlighted.
10. READY shows all checks as passed.
11. TrustPolicyWarning appears only when `appliedQuery.trustPolicy ===
    INCLUDE_UNTRUSTED_HISTORY` AND `legacyUntrustedBatches > 0`.
12. Recommendation banner shows correct text per status.
13. Editing form fields does NOT change displayed data — only "Aplicar"
    does.
14. Clicking "Aplicar" triggers exactly one fetch.
15. Rapid "Aplicar" clicks do not cause stale responses to overwrite
    newer ones.
16. Initial load shows skeleton placeholders.
17. Refetch preserves existing visible data.
18. Error during initial fetch shows error + retry.
19. Error during refetch with existing data preserves previous result
    and shows error banner.
20. Sidebar shows "Readiness Dashboard" nav button.
21. Nav button navigates to the page and highlights when active.
22. All rendered text uses translation keys (es/en).
23. No new API routes, no changes to services, no DB writes.
24. No new API routes, no changes to services, no DB writes.
25. No React Query — uses existing raw fetch pattern.
26. No component performs threshold comparisons. The only pass/fail
    source is `ReadinessCheckResult.passed` from the API.
27. All lookups of check code strings go through the rate-check mapper
    — no component imports check codes directly.
