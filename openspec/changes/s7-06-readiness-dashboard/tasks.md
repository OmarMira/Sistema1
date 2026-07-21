# S7-06 — Readiness Operations Dashboard — Tasks

## File manifest

| # | File | Action |
|---|------|--------|
| 1 | `src/lib/readiness/default-readiness-profile.ts` | CREATE |
| 2 | `src/lib/readiness/rate-check-mapper.ts` | CREATE |
| 3 | `src/lib/readiness/build-readiness-query-params.ts` | CREATE |
| 4 | `src/components/spa/admin/readiness/ReadinessStatusCard.tsx` | CREATE |
| 5 | `src/components/spa/admin/readiness/ReadinessCriteriaForm.tsx` | CREATE |
| 6 | `src/components/spa/admin/readiness/ReadinessMetricsGrid.tsx` | CREATE |
| 7 | `src/components/spa/admin/readiness/ReadinessRatesGrid.tsx` | CREATE |
| 8 | `src/components/spa/admin/readiness/ReadinessChecksTable.tsx` | CREATE |
| 9 | `src/components/spa/admin/readiness/ReadinessRecommendationBanner.tsx` | CREATE |
| 10 | `src/components/spa/admin/readiness/TrustPolicyWarning.tsx` | CREATE |
| 11 | `src/components/spa/admin/AdminReadinessDashboardPage.tsx` | CREATE |
| 12 | `src/store/auth-store.ts` | MODIFY |
| 13 | `src/components/spa/admin/SuperAdminDashboardPage.tsx` | MODIFY |
| 14 | `src/i18n/locales/en.ts` | MODIFY |
| 15 | `src/i18n/locales/es.ts` | MODIFY |

**Zero changes** in: `shadow-metrics-reader.ts`, `audit-log-repository.ts`,
`canonical-readiness-service.ts`, `rule-precedence-shadow.ts`,
`rule-precedence-engine.ts`, `rule-matching-engine.ts`,
`apply-all-engine.ts`, `import.service.ts`, any API route under
`src/app/api/`, resolvers, feature flags.

---

## Task 1 — Types and helpers

### 1A. `src/lib/readiness/default-readiness-profile.ts`

Define and export:

```typescript
export type SourceOption = 'ALL' | 'IMPORT' | 'APPLY_ALL';
export type TrustPolicyOption = 'TRUSTED_ONLY' | 'INCLUDE_LEGACY_IMPORT' | 'INCLUDE_UNTRUSTED_HISTORY';

export interface ReadinessForm {
  source: SourceOption;
  trustPolicy: TrustPolicyOption;
  from: string | null;   // ISO YYYY-MM-DD, computed on mount
  to: string | null;     // ISO YYYY-MM-DD, computed on mount
  minimumEvaluatedTransactions: number;
  minimumBatches: number;
  minimumAgreementRate: number;
  maximumDivergenceRate: number;
  maximumAmbiguityRate: number;
  maximumErrorRate: number;
  maximumInvalidRecordRate: number;
}

export const INITIAL_READINESS_PROFILE: Omit<ReadinessForm, 'from' | 'to'> = {
  source: 'ALL',
  trustPolicy: 'INCLUDE_LEGACY_IMPORT',
  minimumEvaluatedTransactions: 100,
  minimumBatches: 3,
  minimumAgreementRate: 0.95,
  maximumDivergenceRate: 0.05,
  maximumAmbiguityRate: 0.02,
  maximumErrorRate: 0.01,
  maximumInvalidRecordRate: 0.05,
};

// Combines static defaults + computed dates. Tests call this with
// explicit dates instead of computeDefault*() for determinism.
export function createInitialReadinessForm(from?: string, to?: string): ReadinessForm {
  return {
    ...INITIAL_READINESS_PROFILE,
    from: from ?? computeDefaultFrom(),
    to: to ?? computeDefaultTo(),
  };
}
```

Also export date helpers used by the page:

```typescript
export function toStartOfDay(isoDate: string): string {
  return `${isoDate}T00:00:00.000Z`;
}
export function toEndOfDay(isoDate: string): string {
  return `${isoDate}T23:59:59.999Z`;
}
export function computeDefaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().slice(0, 10);
}
export function computeDefaultTo(): string {
  return new Date().toISOString().slice(0, 10);
}
```

### 1B. `src/lib/readiness/rate-check-mapper.ts`

Centralises all check code lookups. This is the ONLY file that imports
check code strings.

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

**Invariant**: no component imports `'MINIMUM_AGREEMENT_RATE'` or any
other check code string directly. All lookups go through this mapper.

### 1C. `src/lib/readiness/build-readiness-query-params.ts`

Single-responsibility helper: converts a `ReadinessForm` + `companyId`
into the URL query string. This is the ONE place the HTTP contract lives
on the client side.

```typescript
import type { ReadinessForm } from './default-readiness-profile';
import { toStartOfDay, toEndOfDay } from './default-readiness-profile';

export function buildReadinessQueryParams(
  form: ReadinessForm,
  companyId: string,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('companyId', companyId);
  params.set('source', form.source);
  params.set('from', toStartOfDay(form.from!));
  params.set('to', toEndOfDay(form.to!));
  params.set('trustPolicy', form.trustPolicy);
  params.set('minimumEvaluatedTransactions', String(form.minimumEvaluatedTransactions));
  params.set('minimumBatches', String(form.minimumBatches));
  params.set('minimumAgreementRate', String(form.minimumAgreementRate));
  params.set('maximumDivergenceRate', String(form.maximumDivergenceRate));
  params.set('maximumAmbiguityRate', String(form.maximumAmbiguityRate));
  params.set('maximumErrorRate', String(form.maximumErrorRate));
  params.set('maximumInvalidRecordRate', String(form.maximumInvalidRecordRate));
  return params;
}
```

**Invariant**: the `URLSearchParams` construction is NEVER duplicated.
If the route contract changes in S7-07, this is the ONLY file to modify.

---

## Task 2 — Sub-components

Each component is a `'use client'` React functional component. All follow
the same conventions: `cn()` for classes, icons from `lucide-react`,
shadcn primitives from `@/components/ui/*`, translations via
`useLanguageStore`.

### 2A. `ReadinessStatusCard`

**Props:**

```typescript
interface ReadinessStatusCardProps {
  status: 'READY' | 'NOT_READY' | 'INSUFFICIENT_DATA';
  reasons?: string[];
  t: (key: string) => string;
}
```

**What it renders:**
- Icon: `CheckCircle` (green) for READY, `AlertTriangle` (amber) for
  NOT_READY, `MinusCircle` (gray) for INSUFFICIENT_DATA.
- Status label from translation key.
- When `reasons` is present (INSUFFICIENT_DATA), render a bullet list of
  reasons below the label.

**What it does NOT do:**
- NOT interpret status string — only renders icon + label from the given
  status value.
- NOT format reasons — renders them as-is.

### 2B. `ReadinessCriteriaForm`

**Props:**

```typescript
interface ReadinessCriteriaFormProps {
  draftForm: ReadinessForm;
  onFieldChange: (field: keyof ReadinessForm, value: string) => void;
  onApply: () => void;
  loading: boolean;
  t: (key: string) => string;
}
```

**What it renders:**
- Row 1: `SourceSelect` (shadcn `<Select>` with 3 options), `TrustPolicySelect`
  (shadcn `<Select>` with 3 options), `DateRangePicker` (two `<input type="date">`).
- Row 2: `ThresholdsAccordion` (shadcn `<Accordion>`) with 3 sections:
  Sample (2 fields), Quality (3 fields), Integrity (2 fields). All fields
  are `<input type="number">` with appropriate min/max/step.
- Row 3: "Aplicar" `<Button>` — disabled while loading.

**What it does NOT do:**
- NOT trigger any fetch on change.
- NOT store or manage its own state — receives `draftForm` and
  `onFieldChange` from parent.

**Field constraints:**
- `minimumEvaluatedTransactions`, `minimumBatches`: integer >= 0, step 1.
- `minimumAgreementRate`: number 0–1, step 0.01.
- `maximumDivergenceRate`, `maximumAmbiguityRate`, `maximumErrorRate`,
  `maximumInvalidRecordRate`: number 0–1, step 0.01.

### 2C. `ReadinessMetricsGrid`

**Props:**

```typescript
interface ReadinessMetricsGridProps {
  metrics: ShadowMetricsReport | null;
  loading: boolean;
  t: (key: string) => string;
}
```

**What it renders:**
- 7 metric cards in a responsive grid (`grid-cols-2 md:grid-cols-3 lg:grid-cols-4`).
  Each shows a label + value.
- When `loading` is true and `metrics` is null: show 7 skeleton cards.
- When `loading` is true and `metrics` is not null (refetch): keep old
  values visible, show subtle skeleton overlay or no visual change.

**Metrics displayed (in order):**
1. batches
2. totalEvaluated
3. validComparisons
4. sameDecision
5. divergentDecision
6. ambiguous
7. errors

**What it does NOT do:**
- NOT compute any derived metric.
- NOT format percentages (those are in RatesGrid).

### 2D. `ReadinessRatesGrid`

**Props:**

```typescript
interface ReadinessRatesGridProps {
  metrics: ShadowMetricsReport | null;
  checks: ReadinessCheckResult[];
  loading: boolean;
  t: (key: string) => string;
}
```

**What it renders:**
- 4 rate cards: agreementRate, divergenceRate, ambiguityRate, errorRate.
- Each card shows the formatted rate value and a pass/fail indicator.
- Pass/fail derived via `getRatePassed(checks, rateKey)` from the mapper.
- `null` rate displayed as `"—"`.

**Visual rules (same for all 4):**

| `getRatePassed(...)` | Icon | Colour |
|---|---|---|
| `true` | CheckCircle | Green |
| `false` | XCircle | Red/amber |
| `undefined` | MinusCircle | Gray |

**What it does NOT do:**
- NOT compare rate value against threshold locally.
- NOT import any check code string.

### 2E. `ReadinessChecksTable`

**Props:**

```typescript
interface ReadinessChecksTableProps {
  checks: ReadinessCheckResult[];
  failedChecks?: ReadinessCheckResult[];
  t: (key: string) => string;
}
```

**What it renders:**
- shadcn `<Table>` with columns: Check (code), Status (icon + passed/failed),
  Operator, Actual, Expected.
- Always visible (even in INSUFFICIENT_DATA state).
- When `failedChecks` is provided (NOT_READY), highlight failing rows
  (red/amber background or border).

**What it does NOT do:**
- NOT filter checks — always renders all 7.
- NOT compute or derive any column value.

### 2F. `ReadinessRecommendationBanner`

**Props:**

```typescript
interface ReadinessRecommendationBannerProps {
  status: 'READY' | 'NOT_READY' | 'INSUFFICIENT_DATA';
  t: (key: string) => string;
}
```

**What it renders:**
- A banner card (`rounded-2xl border`) with recommendation text based on
  status. Uses translation keys `admin.readiness.recommendation.ready`,
  `.notReady`, `.insufficientData`.

**What it does NOT do:**
- NOT contain business logic — the text is purely presentational.
- NOT render when status is missing or undefined.

### 2G. `TrustPolicyWarning`

**Props:**

```typescript
interface TrustPolicyWarningProps {
  trustPolicy: TrustPolicyOption;
  legacyUntrustedBatches: number;
  t: (key: string) => string;
}
```

**What it renders:**
- A warning banner (amber/dark background) only when
  `trustPolicy === 'INCLUDE_UNTRUSTED_HISTORY'` AND
  `legacyUntrustedBatches > 0`.
- Uses translation keys `admin.readiness.untrustedWarning` and
  `.untrustedWarningDesc`.

**What it does NOT do:**
- NOT read from draftForm — receives the policy that produced the result.
- NOT render when condition is not met.

---

## Task 3 — Page component

**File:** `src/components/spa/admin/AdminReadinessDashboardPage.tsx`

### State

```typescript
const [draftForm, setDraftForm] = useState<ReadinessForm>(createInitialReadinessForm());
const [appliedQuery, setAppliedQuery] = useState<ReadinessForm | null>(null);
const [readinessResult, setReadinessResult] = useState<CanonicalReadiness | null>(null);
const [loading, setLoading] = useState(false);
const [error, setError] = useState<string | null>(null);
const [hasExistingData, setHasExistingData] = useState(false);
```

### Handlers

```typescript
const handleFieldChange = useCallback((field: keyof ReadinessForm, value: string) => {
  setDraftForm(prev => ({ ...prev, [field]: value }));
}, []);

const handleApply = useCallback(() => {
  setAppliedQuery(draftForm);
  if (adminSelectedCompanyId) {
    fetchReadiness(draftForm, adminSelectedCompanyId);
  }
}, [draftForm, adminSelectedCompanyId]);
```

### Fetch logic

```typescript
const abortRef = useRef<AbortController | null>(null);
const requestIdRef = useRef(0);

const fetchReadiness = useCallback(async (query: ReadinessForm, companyId: string) => {
  abortRef.current?.abort();
  const controller = new AbortController();
  abortRef.current = controller;
  const currentId = ++requestIdRef.current;

  const params = buildReadinessQueryParams(query, companyId);

  try {
    setLoading(true);
    setError(null);
    const res = await fetch(
      `/api/admin/shadow-metrics/readiness?${params.toString()}`,
      { credentials: 'include', signal: controller.signal },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || `HTTP ${res.status}`);
    }
    const data: CanonicalReadiness = await res.json();

    if (currentId !== requestIdRef.current) return; // stale
    setReadinessResult(data);
    setHasExistingData(true);
  } catch (err) {
    if (currentId !== requestIdRef.current) return;
    if ((err as Error)?.name === 'AbortError') return;
    logger.error('Readiness fetch failed', { error: String(err) });
    if (!hasExistingData) {
      setError(String(err));
    }
    // If hasExistingData, keep previous result and show error banner
  } finally {
    if (currentId === requestIdRef.current) {
      setLoading(false);
    }
  }
}, []);
```

### Mount effect

```typescript
const { adminSelectedCompanyId } = useAuthStore();

useEffect(() => {
  const mountedForm = createInitialReadinessForm();
  setDraftForm(mountedForm);
  if (adminSelectedCompanyId) {
    setAppliedQuery(mountedForm);
    fetchReadiness(mountedForm, adminSelectedCompanyId);
  }
}, [adminSelectedCompanyId]);
```

### Guard (no companyId)

```typescript
if (!adminSelectedCompanyId) {
  return <div className="..."> /* company required message */ </div>;
}
```

### Render order

```
<div className="space-y-6 max-w-7xl mx-auto">
  <HeaderSection title + subtitle + UseCaseAlert />
  <ReadinessCriteriaForm
    draftForm={draftForm}
    onFieldChange={handleFieldChange}
    onApply={handleApply}
    loading={loading}
  />

  {error && !hasExistingData && <ErrorState message={error} onRetry={...} />}
  {error && hasExistingData && <ErrorBanner message={error} />}

  {loading && !hasExistingData && <LoadingSkeleton />}

  {readinessResult && (
    <>
      <ReadinessStatusCard status={readinessResult.status} reasons={...} />
      <ReadinessMetricsGrid metrics={readinessResult.metrics} loading={loading} />
      <ReadinessRatesGrid
        metrics={readinessResult.metrics}
        checks={readinessResult.checks}
        loading={loading}
      />
      <TrustPolicyWarning
        trustPolicy={appliedQuery!.trustPolicy}
        legacyUntrustedBatches={readinessResult.metrics.legacyUntrustedBatches}
      />
      <ReadinessChecksTable
        checks={readinessResult.checks}
        failedChecks={'failedChecks' in readinessResult ? readinessResult.failedChecks : undefined}
      />
      <ReadinessRecommendationBanner status={readinessResult.status} />
    </>
  )}
</div>
```

---

## Task 4 — Integration

### 4A. Auth store

**File:** `src/store/auth-store.ts`

Add `'admin-readiness'` to the `ViewName` union type (alphabetical
position with other admin views).

### 4B. Super admin page

**File:** `src/components/spa/admin/SuperAdminDashboardPage.tsx`

1. Import `AdminReadinessDashboardPage` at the top.
2. Add a `NavBtn` in the sidebar for `admin-readiness` — between the
   existing audit-logs nav button and the Separator. Icon: `Activity`
   (reuse — currently used by audit logs; use `BarChart3` instead).
   Label key: `t('superAdmin.readiness')`.
3. Import `BarChart3` from `lucide-react`.
4. Add conditional render in the main content area (after audit logs):
   `{currentView === 'admin-readiness' && <AdminReadinessDashboardPage />}`
5. Add header title mapping:
   `{currentView === 'admin-readiness' && t('superAdmin.readinessTitle')}`

### 4C. Translation keys — en.ts

Append inside the `superAdmin` block:

```typescript
readiness: 'Readiness Dashboard',
readinessTitle: 'Readiness Operations Dashboard',
```

Add the `admin.readiness.*` block inside the existing `admin` or as a
top-level block under `superAdmin`:

```typescript
readinessDashboard: {
  title: 'Readiness Operations Dashboard',
  subtitle: 'Inspect canonical engine readiness metrics',
  useCaseAlert: 'This dashboard is observational only. It reads readiness data without modifying any system state.',
  companyRequired: 'Select a company first to view readiness data.',
  source: 'Source',
  trustPolicy: 'Trust Policy',
  from: 'From',
  to: 'To',
  apply: 'Apply',
  thresholds: 'Thresholds',
  sample: 'Sample',
  quality: 'Quality',
  integrity: 'Integrity',
  status: 'Status',
  batches: 'Batches',
  totalEvaluated: 'Total Evaluated',
  validComparisons: 'Valid Comparisons',
  sameDecision: 'Same Decision',
  divergentDecision: 'Divergent',
  ambiguous: 'Ambiguous',
  errors: 'Errors',
  agreementRate: 'Agreement',
  divergenceRate: 'Divergence',
  ambiguityRate: 'Ambiguity',
  errorRate: 'Error',
  check: 'Check',
  actual: 'Actual',
  expected: 'Expected',
  operator: 'Op',
  passed: 'Passed',
  failed: 'Failed',
  recommendation: {
    ready: 'The engine meets the defined criteria. Activation remains manual.',
    notReady: 'The engine does not meet the defined criteria. Review failed checks before considering activation.',
    insufficientData: 'Insufficient data to evaluate. More batches are needed before assessing readiness.',
  },
  insufficientReasons: 'Insufficient data reasons',
  untrustedWarning: 'Including LEGACY_UNTRUSTED data',
  untrustedWarningDesc: 'This view includes Apply All v0 batches, which are not fully trustworthy. Consider using "INCLUDE_LEGACY_IMPORT" for a more conservative view.',
  loading: 'Loading readiness data...',
  refetching: 'Updating...',
  error: 'Failed to load readiness data',
  retry: 'Retry',
  noData: 'No readiness data available',
  periodLabel: 'Period',
}
```

### 4D. Translation keys — es.ts

Same structure with Spanish translations:

```typescript
readiness: 'Panel de Readiness',
readinessTitle: 'Panel de Readiness',
readinessDashboard: {
  title: 'Panel de Readiness',
  subtitle: 'Inspeccione las métricas de readiness del motor canónico',
  useCaseAlert: 'Este panel es solo de observación. Lee datos de readiness sin modificar ningún estado del sistema.',
  companyRequired: 'Seleccione una compañía primero para ver los datos de readiness.',
  source: 'Fuente',
  trustPolicy: 'Política de confianza',
  from: 'Desde',
  to: 'Hasta',
  apply: 'Aplicar',
  thresholds: 'Umbrales',
  sample: 'Muestra',
  quality: 'Calidad',
  integrity: 'Integridad',
  status: 'Estado',
  batches: 'Batches',
  totalEvaluated: 'Evaluados',
  validComparisons: 'Válidos',
  sameDecision: 'Misma decisión',
  divergentDecision: 'Divergentes',
  ambiguous: 'Ambiguos',
  errors: 'Errores',
  agreementRate: 'Acuerdo',
  divergenceRate: 'Divergencia',
  ambiguityRate: 'Ambigüedad',
  errorRate: 'Error',
  check: 'Check',
  actual: 'Actual',
  expected: 'Esperado',
  operator: 'Op',
  passed: 'Aprobado',
  failed: 'Falló',
  recommendation: {
    ready: 'El motor cumple los criterios definidos. La activación continúa siendo manual.',
    notReady: 'El motor no cumple los criterios definidos. Revise los checks fallidos antes de considerar activación.',
    insufficientData: 'Datos insuficientes para evaluar. Es necesario acumular más batches antes de evaluar la readiness.',
  },
  insufficientReasons: 'Motivos de datos insuficientes',
  untrustedWarning: 'Incluyendo datos LEGACY_UNTRUSTED',
  untrustedWarningDesc: 'Esta visualización incluye batches de Apply All v0, que no son totalmente confiables. Considere usar "INCLUDE_LEGACY_IMPORT" para una visión más conservadora.',
  loading: 'Cargando datos de readiness...',
  refetching: 'Actualizando...',
  error: 'Error al cargar datos de readiness',
  retry: 'Reintentar',
  noData: 'No hay datos de readiness disponibles',
  periodLabel: 'Período',
}
```

### Translation key resolution

The components receive `t` from `useLanguageStore` and access keys as:
```typescript
t('admin.readiness.title')
t('admin.readiness.recommendation.ready')
t('superAdmin.readiness')     // sidebar nav
t('superAdmin.readinessTitle') // header title
```

Verify the key hierarchy matches the existing locale file structure.
Adjust nesting as needed to fit the existing `admin` or `superAdmin`
blocks.

---

## Task 5 — Invariants

- No component imports `ReadinessCheckCode` strings directly — all
  lookups go through `rate-check-mapper.ts`.
- No component compares rate values against thresholds — pass/fail comes
  from `ReadinessCheckResult.passed`.
- No component computes agreement, divergence, ambiguity, or error rates.
- No component interprets the `status` string (READY/NOT_READY/
  INSUFFICIENT_DATA) as anything other than a display input.
- Metrics are rendered exclusively from `readinessResult.metrics`.
- The dashboard makes exactly one fetch per "Aplicar" click.
- No fetch executes without `adminSelectedCompanyId`.
- Aborted requests do not generate error banners, error logs, or UI
  changes.
- Editing `draftForm` never changes the displayed data.
- `appliedQuery` is the single source of truth for what query produced
  the current results.

---

## Task 6 — Prohibitions (zero changes)

Do NOT touch:

- `src/lib/services/shadow-metrics-reader.ts`
- `src/lib/db/audit-log-repository.ts`
- `src/lib/services/rule-precedence-shadow.ts`
- `src/lib/services/rule-precedence-engine.ts`
- `src/lib/services/rule-matching-engine.ts`
- `src/lib/services/apply-all-engine.ts`
- `src/lib/services/import.service.ts`
- `src/lib/services/canonical-readiness-service.ts`
- Any file under `src/app/api/`
- Any resolver files
- Feature flags
- `src/lib/api-error.ts`
- `src/lib/api-handler.ts`

Do NOT add:
- Auto-activation of feature flags
- Database writes
- Caching layer
- Notifications or alerts
- New API endpoints
- New feature flags
- React Query or any state management beyond `useState`/`useCallback`
- URL-based deep linking

---

## Task 7 — Tests

**File:** `tests/components/readiness-dashboard.test.tsx` (or alongside
the spec folder)

Since existing admin pages have no tests, create a focused test file for
the new feature. Use `vitest` + `@testing-library/react`.

### Helpers

- `makeReport(overrides): ShadowMetricsReport` — factory with sensible
  defaults (all zeros, all rates null).
- `makeChecks(overrides: Partial<Record<ReadinessCheckCode, boolean>>): ReadinessCheckResult[]`
  — builds 7 checks, setting `passed` for each code in the override map.
- `makeReadinessResponse(status, overrides): CanonicalReadiness`

### Component tests

| Group | Cases |
|-------|-------|
| ReadinessStatusCard | renders READY with green icon |
| ReadinessStatusCard | renders NOT_READY with amber icon |
| ReadinessStatusCard | renders INSUFFICIENT_DATA with gray icon + reasons |
| ReadinessStatusCard | renders correct translation key for each status |
| ReadinessMetricsGrid | renders all 7 metrics |
| ReadinessMetricsGrid | shows skeletons when loading and no data |
| ReadinessMetricsGrid | keeps old values visible during refetch |
| ReadinessRatesGrid | renders 4 rates with pass/fail from checks |
| ReadinessRatesGrid | null rate displays as "—" |
| ReadinessRatesGrid | color derived from check.passed, not local comparison |
| ReadinessChecksTable | renders all 7 checks |
| ReadinessChecksTable | highlights failed checks when failedChecks provided |
| ReadinessChecksTable | visible in all states including INSUFFICIENT_DATA |
| ReadinessRecommendationBanner | correct text per status |
| TrustPolicyWarning | visible when INCLUDE_UNTRUSTED + legacyUntrustedBatches > 0 |
| TrustPolicyWarning | hidden when INCLUDE_LEGACY_IMPORT |
| TrustPolicyWarning | hidden when legacyUntrustedBatches === 0 |
| TrustPolicyWarning | uses trustPolicy from prop, not from form |

### Integration tests (page-level)

| Group | Cases |
|-------|-------|
| No companyId | renders company-required message, no fetch |
| Initial load | fetches with defaults on mount |
| Apply button | triggers fetch with current draftForm values |
| Apply button | sets appliedQuery, does not re-render with draft-only changes |
| Stale responses | late response does not overwrite newer one |
| AbortController | previous fetch is aborted on new Apply click |
| Error (no data) | shows error + retry |
| Error (with data) | preserves previous result, shows error banner |
| Loading states | skeleton shown on initial load |
| Loading states | old data visible during refetch |

### Invariant tests

| Case | Asserts |
|------|---------|
| No local threshold comparison | All rate cards derive from `getRatePassed()`, spy on mapper |
| No check code strings in components | grep test (or explicit assertion) that no component file imports `'MINIMUM_'` |
| Single fetch per Apply | spy on `globalThis.fetch`, assert exactly one call per Apply click |
| Mapper exhaustiveness | Test reads all `ReadinessCheckCode` values from canonical service. If a new rate-related code appears without a `RATE_TO_CHECK_CODE` entry, the test fails |

---

## Task 8 — Verification commands

```bash
npx tsc --noEmit
npx vitest run tests/components/readiness-dashboard.test.tsx
npx vitest run
npm run build
git diff --check
git diff
git status --short
```

---

## Out of scope

- Export CSV or data download
- Charts, sparklines, or visualizations
- Trend/history over time
- Auto-refresh or polling
- Auto-activation of feature flags
- Profile persistence (save/load profiles per user)
- Deep links or URL-based routing to specific criteria
- Cross-company comparison
- Notifications or alerts
- Caching layer
- Keyboard shortcuts
- Accessibility skip-links

## Implementation order

1. `src/lib/readiness/default-readiness-profile.ts` — types + helpers (no dates)
2. `src/lib/readiness/rate-check-mapper.ts` — mapper
3. `src/lib/readiness/build-readiness-query-params.ts` — HTTP contract
4. Each sub-component from simplest to most complex:
   - ReadinessRecommendationBanner
   - TrustPolicyWarning
   - ReadinessStatusCard
   - ReadinessMetricsGrid
   - ReadinessRatesGrid
   - ReadinessChecksTable
   - ReadinessCriteriaForm
4. `AdminReadinessDashboardPage` — orchestrator
5. Auth store (`ViewName`)
6. SuperAdminDashboardPage — sidebar + render + header
7. Translation keys (en + es)
8. Tests
9. TypeScript check + build
