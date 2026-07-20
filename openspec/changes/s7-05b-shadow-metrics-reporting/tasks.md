# S7-05B — Shadow Metrics Reporting: Tasks

> Source: `openspec/changes/s7-05b-shadow-metrics-reporting/spec.md`
> Alcance: Reader + pipeline + endpoint para métricas de shadow desde AuditLog.

---

## 0. Pre-condición: fixture correction (antes de tocar reader)

**Archivo:** `tests/unit/apply-all-use-case.test.ts`

Corregir `makeSuccessResult()` para que devuelva un `ShadowPersistencePayload` real tipado, no un objeto plano con `diverged`/`errors`. La constante debe declararse con tipo explícito `ShadowPersistencePayload` — si el contrato cambia en el futuro, TypeScript rompe el test inmediatamente:

```typescript
const summary: ShadowPersistencePayload = {
  totalEvaluated: 1,
  sameWinner: 1,
  differentWinner: 0,
  shadowErrors: 0,
  divergenceReasons: {
    NO_MATCH: 0,
    AMBIGUOUS: 0,
    UNDETERMINED: 0,
    OTHER: 0,
  },
};
```

Nota: `ShadowPersistencePayload` usa `sameWinner: number` + `differentWinner: number` (contadores). `sameDecision` no pertenece al payload persistido — es un valor normalizado derivado por el reader.

**Verificar:** `npx vitest run tests/unit/apply-all-use-case.test.ts` pasa.

---

## 1. Types & Contracts

**Archivo:** `src/lib/services/shadow-metrics-reader.ts`

Definir en orden (sin implementación de lógica aún):

### 1.1 `ShadowRecordTrust`

```typescript
type ShadowRecordTrust = 'TRUSTED' | 'LEGACY' | 'LEGACY_UNTRUSTED' | 'INVALID';
```

### 1.2 `ShadowMetricsTrustPolicy`

```typescript
type ShadowMetricsTrustPolicy =
  | 'TRUSTED_ONLY'
  | 'INCLUDE_LEGACY_IMPORT'
  | 'INCLUDE_UNTRUSTED_HISTORY';
```

### 1.3 `ShadowRecordRejectionReason`

```typescript
type ShadowRecordRejectionReason =
  | 'DETAILS_MISSING'
  | 'INVALID_JSON'
  | 'UNKNOWN_SCHEMA'
  | 'UNSUPPORTED_VERSION'
  | 'SOURCE_ENTITY_MISMATCH'
  | 'INVALID_FIELD_TYPE'
  | 'NEGATIVE_COUNTER'
  | 'NON_FINITE_COUNTER'
  | 'INVARIANT_VIOLATION'
  | 'BUGGY_FIXTURE_SCHEMA';
```

### 1.4 `NormalizedShadowRecord`

```typescript
interface NormalizedShadowRecord {
  trust: ShadowRecordTrust;
  source: 'IMPORT' | 'APPLY_ALL';
  totalEvaluated: number;
  sameDecision: number;
  divergentDecision: number;
  ambiguous: number;
  errors: number;
  reasons: {
    NO_MATCH: number;
    AMBIGUOUS: number;
    UNDETERMINED: number;
    OTHER: number;
  };
}
```

### 1.5 `ShadowRecordProcessingResult`

```typescript
type ShadowRecordProcessingResult =
  | { kind: 'normalized'; record: NormalizedShadowRecord }
  | { kind: 'rejected'; trust: 'INVALID'; reason: ShadowRecordRejectionReason };
```

### 1.6 `ShadowMetricsQuery`

```typescript
interface ShadowMetricsQuery {
  companyId: string;
  source: 'IMPORT' | 'APPLY_ALL' | 'ALL';
  from: Date;
  to: Date;
  trustPolicy: ShadowMetricsTrustPolicy;
}
```

### 1.7 `ShadowMetricsReport`

```typescript
interface ShadowMetricsReport {
  // Batch counters (always from total records read)
  batches: number;
  trustedBatches: number;
  legacyBatches: number;
  legacyUntrustedBatches: number;
  invalidRecords: number;

  // Aggregated counters (only from records that pass trustPolicy)
  totalEvaluated: number;
  validComparisons: number;
  sameDecision: number;
  divergentDecision: number;
  ambiguous: number;
  errors: number;

  // Rates (null when denominator is 0)
  agreementRate: number | null;
  divergenceRate: number | null;
  ambiguityRate: number | null;
  errorRate: number | null;

  // Reason breakdown (only from records that pass trustPolicy)
  reasons: {
    NO_MATCH: number;
    AMBIGUOUS: number;
    UNDETERMINED: number;
    OTHER: number;
  };
}
```

### 1.8 `ImportMetricsV0`

```typescript
interface ImportMetricsV0 {
  totalEvaluated: number;
  sameWinner: number;
  bothNoMatch: number;
  productiveMatchCanonicalNoMatch: number;
  productiveNoMatchCanonicalMatch: number;
  differentWinner: number;
  canonicalAmbiguous: number;
  shadowErrors: number;
}
```

### 1.9 `ApplyAllMetricsV0`

```typescript
interface ApplyAllMetricsV0 {
  totalEvaluated: number;
  sameWinner: number;
  differentWinner: number;
  shadowErrors: number;
  divergenceReasons: {
    NO_MATCH: number;
    AMBIGUOUS: number;
    UNDETERMINED: number;
    OTHER: number;
  };
}
```

### 1.10 `ImportMetricsV1`

```typescript
interface ImportMetricsV1 {
  totalEvaluated: number;
  sameWinner: number;
  bothNoMatch: number;
  productiveMatchCanonicalNoMatch: number;
  productiveNoMatchCanonicalMatch: number;
  differentWinner: number;
  canonicalAmbiguous: number;
  shadowErrors: number;
}
```

### 1.11 `ApplyAllMetricsV1`

```typescript
interface ApplyAllMetricsV1 {
  totalEvaluated: number;
  sameWinner: number;
  differentWinner: number;
  shadowErrors: number;
  divergenceReasons: {
    NO_MATCH: number;
    AMBIGUOUS: number;
    UNDETERMINED: number;
    OTHER: number;
  };
}
```

### 1.12 `ShadowMetricsEnvelopeV1`

```typescript
type ShadowMetricsEnvelopeV1 =
  | {
      schemaVersion: 1;
      source: 'IMPORT';
      metrics: ImportMetricsV1;
    }
  | {
      schemaVersion: 1;
      source: 'APPLY_ALL';
      metrics: ApplyAllMetricsV1;
    };
```

### 1.13 `DetectedShadowRecord` — preserva payload completo

`detectSchema()` devuelve una unión discriminada que conserva el payload real. Cada variante incluye source, version, entity y el payload tipado:

```typescript
type DetectedShadowRecord =
  | {
      source: 'IMPORT';
      version: 'V0';
      entity: 'BankStatement';
      payload: ImportMetricsV0;
    }
  | {
      source: 'IMPORT';
      version: 'V1';
      entity: 'BankStatement';
      payload: ImportMetricsV1;
    }
  | {
      source: 'APPLY_ALL';
      version: 'V0';
      entity: 'ApplyAllBatch';
      payload: ApplyAllMetricsV0;
    }
  | {
      source: 'APPLY_ALL';
      version: 'V1';
      entity: 'ApplyAllBatch';
      payload: ApplyAllMetricsV1;
    };
```

### 1.14 `ValidShadowRecord` — wrapper semántico

Wrapper para garantizar que `normalize()` solo recibe registros que pasaron `validateInvariants()`:

```typescript
interface ValidShadowRecord {
  detected: DetectedShadowRecord;
}
```

### 1.15 `StageResult` — resultado tipado de pipeline

Preserva el motivo de rechazo en cada etapa, a diferencia de `T | null`:

```typescript
type StageResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: ShadowRecordRejectionReason };
```

### 1.16 Tipos de soporte

```typescript
type RawJson = Record<string, unknown>;
```

### 1.17 `ShadowAuditLogRecord`

```typescript
interface ShadowAuditLogRecord {
  id: string;
  companyId: string;
  action: string;
  entity: string;
  entityId: string | null;
  details: string | null;
  createdAt: Date;
}
```

### 1.18 `AuditLogRepository` (contrato)

```typescript
export interface AuditLogRepository {
  findShadowSummaries(query: ShadowMetricsQuery): Promise<ShadowAuditLogRecord[]>;
}
```

**Adapter concreto** (archivo: `src/lib/db/audit-log-repository.ts`):

```typescript
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import type { AuditLogRepository } from '../services/shadow-metrics-reader';

export const prismaAuditLogRepository: AuditLogRepository = {
  async findShadowSummaries(query) {
    const where: Prisma.AuditLogWhereInput = {
      companyId: query.companyId,
      action: 'RULE_PRECEDENCE_SHADOW_SUMMARY',
      createdAt: {
        gte: query.from,
        lte: query.to,
      },
    };

    if (query.source !== 'ALL') {
      where.entity = query.source === 'IMPORT' ? 'BankStatement' : 'ApplyAllBatch';
    }

    const records = await db.auditLog.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        companyId: true,
        action: true,
        entity: true,
        entityId: true,
        details: true,
        createdAt: true,
      },
    });

    return records.map((r) => ({
      id: r.id,
      companyId: r.companyId,
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      details: r.details,
      createdAt: r.createdAt,
    }));
  },
};
```

---

## 2. Pipeline — Pure Functions

Cada función es pura: recibe datos, devuelve datos. Sin side effects.

**Separación estricta de responsabilidades:**
- `detectSchema()` = **detección + validación estructural**: identifica schema, source, versión, **y** valida forma estricta del payload (campos requeridos presentes, campos prohibidos ausentes, source/entity correspondencia). **Nunca valida contadores** (sumas, rangos, invariantes numéricas).
- `validateInvariants()` solo valida sumas y rangos. **Nunca clasifica trust. Nunca normaliza.**
- `normalize()` solo transforma a `NormalizedShadowRecord`. **Nunca invalida registros. Nunca recalcula invariantes.**

**Invariante del pipeline:** cada fila de AuditLog produce exactamente un `ShadowRecordProcessingResult`. Nunca cero. Nunca más de uno. Transformación 1→1.

### 2.1 `parseJson(details: string | null): StageResult<RawJson>`

- `details === null` → `{ ok: false, reason: 'DETAILS_MISSING' }`.
- `details === ''` (cadena vacía) → `{ ok: false, reason: 'INVALID_JSON' }`.
- Parseo lanza (JSON malformado) → `{ ok: false, reason: 'INVALID_JSON' }`.
- Éxito → `{ ok: true, value: RawJson }`.
- **Test:** null, `''` (cadena vacía), JSON inválido, JSON válido. Debe haber pruebas y casos separados para ambos motivos (`DETAILS_MISSING` vs `INVALID_JSON`).

### 2.2 `detectSchema(raw: RawJson, entity: string): StageResult<DetectedShadowRecord>`

**Orden de validación V1 (estricto, en este orden):**
1. `schemaVersion === 1` → versión soportada.
2. `raw.source` es `'IMPORT' | 'APPLY_ALL'` → source válido.
3. Correspondencia `source/entity`: `source: 'IMPORT'` && `entity !== 'BankStatement'` → `{ ok: false, reason: 'SOURCE_ENTITY_MISMATCH' }`. `source: 'APPLY_ALL'` && `entity !== 'ApplyAllBatch'` → `{ ok: false, reason: 'SOURCE_ENTITY_MISMATCH' }`.
4. Forma estricta del payload: Import V1 no acepta campos de Apply All (`divergenceReasons`); Apply All V1 no acepta campos exclusivos de Import (`bothNoMatch`, `productiveMatchCanonicalNoMatch`, `productiveNoMatchCanonicalMatch`, `canonicalAmbiguous`). Fallo → `{ ok: false, reason: 'INVALID_FIELD_TYPE' }`.
5. Preserva el payload completo en `DetectedShadowRecord`.
- Sin `schemaVersion`:
  - `entity === 'BankStatement'` && 7 campos de `ShadowImportSummary` → V0 Import.
  - `entity === 'ApplyAllBatch'` && `divergenceReasons, differentWinner, shadowErrors` → V0 Apply All.
  - `diverged` o `errors` en raw → `{ ok: false, reason: 'BUGGY_FIXTURE_SCHEMA' }`.
  - `schemaVersion > 1` → `{ ok: false, reason: 'UNSUPPORTED_VERSION' }`.
- No clasifica → `{ ok: false, reason: 'UNKNOWN_SCHEMA' }`.

**Test casos:** v0 Import, v0 Apply All, V1 Import, V1 Apply All, fixture contaminado, schema no soportado, source/entity mismatch, entity inválido, Import V1 híbrido con `divergenceReasons`, Apply All V1 con campos de Import, V1 ausencia de campo obligatorio.

### 2.3 `validateInvariants(detected: DetectedShadowRecord): StageResult<ValidShadowRecord>`

Recibe el `DetectedShadowRecord` completo (payload incluido). Valida invariantes numéricas según source y versión. En éxito, envuelve en `ValidShadowRecord`:

```typescript
return { ok: true, value: { detected } };
```

- Import v0/v1: verifica `totalEvaluated = sameWinner + bothNoMatch + productiveMatchCanonicalNoMatch + productiveNoMatchCanonicalMatch + differentWinner + canonicalAmbiguous + shadowErrors`.
- Apply All v0/v1: verifica `differentWinner === divergenceReasons.UNDETERMINED` y `sameDecision >= 0` (derivado por resta).
- Todos: ningún campo negativo, ningún campo NaN/Infinity → `{ ok: false, reason: 'NEGATIVE_COUNTER' | 'NON_FINITE_COUNTER' | 'INVARIANT_VIOLATION' }`.
- Éxito → `{ ok: true, value: ValidShadowRecord }`.

**Test casos:** invariante OK, invariante rota, campos negativos, NaN, Infinity.

### 2.4 `normalize(valid: ValidShadowRecord): NormalizedShadowRecord`

Extrae `detected` del wrapper validado y mapea a `NormalizedShadowRecord` usando narrowing por `source` + `version`:

```typescript
const { detected } = valid;

switch (detected.source) {
  case 'IMPORT':
    // spec sección 7: sameDecision = sameWinner + bothNoMatch; etc.
    break;
  case 'APPLY_ALL':
    // spec sección 8: divergentDecision = divergenceReasons.NO_MATCH + OTHER + UNDETERMINED; etc.
    break;
}
```

- Mapea campos Import (spec sección 7) a `NormalizedShadowRecord`.
- Mapea campos Apply All (spec sección 8) a `NormalizedShadowRecord`.
- Clasifica `trust` según spec sección 6.2.
- `normalize` **nunca** retorna un resultado de rechazo. Si no puede mapear, falló en una etapa anterior.
- **No usa búsquedas dinámicas de nombres de campos** — accede a propiedades tipadas directamente.

**Trust classification (spec 6.2):**

| Condición | Trust |
|---|---|
| `schemaVersion === 1` && payload V1 válido | `TRUSTED` |
| `schemaVersion === 1` && payload V1 inválido | `INVALID` (rejected) |
| BankStatement v0 válido | `LEGACY` |
| ApplyAllBatch v0 válido | `LEGACY_UNTRUSTED` |
| `diverged`/`errors` en raw | `INVALID` (rejected, BUGGY_FIXTURE_SCHEMA) |
| JSON inválido / null | `INVALID` (rejected, INVALID_JSON) |
| Invariantes rotas | `INVALID` (rejected, INVARIANT_VIOLATION) |

**Test casos:** normalized Import v0, normalized Apply All v0, normalized V1.

### 2.5 `aggregate(results: ShadowRecordProcessingResult[], query: ShadowMetricsQuery): ShadowMetricsReport`

- Recibe array completo de resultados del pipeline (1:1 con filas AuditLog).
- **NO modifica `ShadowRecordProcessingResult` ni `NormalizedShadowRecord`.** Construye un `ShadowMetricsReport` nuevo.
- `batches`: total del array.
- `invalidRecords`: count de `{ kind: 'rejected' }`.
- `trustedBatches`: count de normalized con `trust === 'TRUSTED'`.
- `legacyBatches`: count de normalized con `trust === 'LEGACY'`.
- `legacyUntrustedBatches`: count de normalized con `trust === 'LEGACY_UNTRUSTED'`.
- **Invariante:** `batches = trustedBatches + legacyBatches + legacyUntrustedBatches + invalidRecords`.
- Normalizados filtrados por `trustPolicy` para métricas y tasas:
  - `TRUSTED_ONLY`: solo `trust === 'TRUSTED'`.
  - `INCLUDE_LEGACY_IMPORT` (default): `TRUSTED` + `LEGACY`.
  - `INCLUDE_UNTRUSTED_HISTORY`: todos los normalizados.
- Tasas: null cuando denominador es 0.
- **Test casos:** mezcla de normalized/rejected, cada trustPolicy, denominador cero, duplicados.

---

## 3. Reader

**Archivo:** `src/lib/services/shadow-metrics-reader.ts`

```typescript
class ShadowMetricsReader {
  constructor(private readonly auditLogRepo: AuditLogRepository) {}

  async read(query: ShadowMetricsQuery): Promise<ShadowMetricsReport> {
    // 1. Fetch AuditLog records via injected repository
    const records = await this.auditLogRepo.findShadowSummaries(query);

    // 2. For each record: parseJson → detectSchema → validateInvariants → normalize
    //    Each stage preserves the rejection reason via StageResult<T>.
    //    If any stage returns { ok: false }, the record becomes:
    //    { kind: 'rejected', trust: 'INVALID', reason }.
    //    Payload se preserva tipado entre todas las etapas.
    const results: ShadowRecordProcessingResult[] = records.map((record) => {
      const parsed = parseJson(record.details);
      if (!parsed.ok) return { kind: 'rejected', trust: 'INVALID', reason: parsed.reason };

      const detected = detectSchema(parsed.value, record.entity);
      if (!detected.ok) return { kind: 'rejected', trust: 'INVALID', reason: detected.reason };

      const validated = validateInvariants(detected.value);
      if (!validated.ok) return { kind: 'rejected', trust: 'INVALID', reason: validated.reason };

      const normalized = normalize(validated.value);
      return { kind: 'normalized', record: normalized };
    });

    // 3. Call aggregate(results, query)
    // 4. Return ShadowMetricsReport
    return aggregate(results, query);
  }
}
```

**Reglas:**
- No lee `process.env`.
- No escribe datos.
- No modifica datos.
- **Recibe el repositorio inyectado por constructor.** Nunca hace `new PrismaClient()`. Nunca importa Prisma directamente.

---

## 4. Route

**Archivo:** `src/app/api/admin/shadow-metrics/route.ts`

```
GET /api/admin/shadow-metrics?from=...&to=...&source=...&trustPolicy=...
```

1. `requireCompanyContext()` — valida sesión y company.
2. Recibe parámetros HTTP como strings de consulta (`from`, `to`, `source`, `trustPolicy`).
3. Valida y parsea las fechas:
   - Valida que `from` esté presente y sea un string de fecha ISO válido. Si es inválido, retorna HTTP 400.
   - Valida que `to` esté presente y sea un string de fecha ISO válido. Si es inválido, retorna HTTP 400.
   - Valida que `from <= to`. Si `from > to` (from mayor que to), retorna HTTP 400.
   - Convierte los strings de fecha válidos a objetos `Date` nativos (`new Date(from)`, `new Date(to)`).
4. Valida y parsea `source` y `trustPolicy`:
   - `source` debe ser `'IMPORT' | 'APPLY_ALL' | 'ALL'`. Default: `'ALL'`. Retorna HTTP 400 ante valores inválidos.
   - `trustPolicy` debe ser `'TRUSTED_ONLY' | 'INCLUDE_LEGACY_IMPORT' | 'INCLUDE_UNTRUSTED_HISTORY'`. Default: `'INCLUDE_LEGACY_IMPORT'`. Retorna HTTP 400 ante valores inválidos.
5. Construye el objeto `ShadowMetricsQuery` estrictamente tipado (con `from: Date`, `to: Date`, y `trustPolicy: ShadowMetricsTrustPolicy` resuelto).
6. Crea `ShadowMetricsReader` inyectando el adapter `prismaAuditLogRepository` (desde `src/lib/db/audit-log-repository.ts`).
7. Llama a `reader.read(query)`.
8. Devuelve `ShadowMetricsReport` como JSON con HTTP 200.
9. La route es la única responsable de resolver la configuración externa e interpretar los parámetros HTTP. El reader permanece puro sin volver a interpretar strings ni usar variables de entorno.

**Test casos en Route (integración):**
- GET sin autenticación o con companyId inválido → HTTP 401/403.
- GET con parámetros válidos → HTTP 200 + reporte JSON.
- GET con `from` inválido (ej: "no-fecha") → HTTP 400.
- GET con `to` inválido (ej: "no-fecha") → HTTP 400.
- GET con `from > to` (ej: from=2026-07-20&to=2026-07-10) → HTTP 400.
- GET con `source` o `trustPolicy` con valores fuera del enum → HTTP 400.
- GET filtra por company y rango de periodo de forma precisa.

---

## 5. Tests exhaustivos

**Archivo:** `tests/unit/shadow-metrics-reader.test.ts`

### 5.1 parseJson
- `details: null` → `{ ok: false, reason: 'DETAILS_MISSING' }`
- `details: ''` (cadena vacía) → `{ ok: false, reason: 'INVALID_JSON' }`
- `details: 'invalid json'` → `{ ok: false, reason: 'INVALID_JSON' }`
- `details: '{"key": "value"}'` → `{ ok: true, value: RawJson }`

### 5.2 detectSchema (retorna `StageResult<DetectedShadowRecord>`)
- V1 IMPORT + entity BankStatement → `{ ok: true }` con `DetectedShadowRecord` que preserva `payload` tipado
- V1 APPLY_ALL + entity ApplyAllBatch → `{ ok: true }` con `DetectedShadowRecord`
- V1 IMPORT + entity ApplyAllBatch → `{ ok: false, reason: 'SOURCE_ENTITY_MISMATCH' }`
- v0 Import (BankStatement, 7 campos) → `{ ok: true }` con `DetectedShadowRecord` + `ImportMetricsV0`
- v0 Apply All (ApplyAllBatch, divergenceReasons) → `{ ok: true }` con `DetectedShadowRecord` + `ApplyAllMetricsV0`
- Fixture diverged/errors → `{ ok: false, reason: 'BUGGY_FIXTURE_SCHEMA' }`
- schemaVersion > 1 → `{ ok: false, reason: 'UNSUPPORTED_VERSION' }`
- Entity desconocido → `{ ok: false, reason: 'UNKNOWN_SCHEMA' }`
- Import V1 híbrido con `divergenceReasons` → `{ ok: false, reason: 'INVALID_FIELD_TYPE' }`
- Apply All V1 con campos exclusivos de Import (`bothNoMatch`, `productiveMatch...`) → `{ ok: false, reason: 'INVALID_FIELD_TYPE' }`
- Import V1 sin campo obligatorio → `{ ok: false, reason: 'INVALID_FIELD_TYPE' }`
- Apply All V1 sin `divergenceReasons` → `{ ok: false, reason: 'INVALID_FIELD_TYPE' }`

### 5.3 validateInvariants (retorna `StageResult<ValidShadowRecord>`)
- Import sum check OK → `{ ok: true }` con `ValidShadowRecord` (wrapper alrededor de `DetectedShadowRecord`)
- Import sum check fail → `{ ok: false, reason: 'INVARIANT_VIOLATION' }`
- Apply All `differentWinner === UNDETERMINED` OK → `{ ok: true }`
- Apply All `differentWinner !== UNDETERMINED` → `{ ok: false, reason: 'INVARIANT_VIOLATION' }`
- Apply All `sameDecision < 0` → `{ ok: false, reason: 'INVARIANT_VIOLATION' }`
- Campo negativo → `{ ok: false, reason: 'NEGATIVE_COUNTER' }`
- NaN → `{ ok: false, reason: 'NON_FINITE_COUNTER' }`
- Infinity → `{ ok: false, reason: 'NON_FINITE_COUNTER' }`

### 5.4 normalize
- Import v0 → `{ kind: 'normalized', record.trust === 'LEGACY' }`
- Import V1 → `{ kind: 'normalized', record.trust === 'TRUSTED' }`
- Apply All v0 → `{ kind: 'normalized', record.trust === 'LEGACY_UNTRUSTED' }`
- Apply All V1 → `{ kind: 'normalized', record.trust === 'TRUSTED' }`
- Mapeo de campos correcto para cada source (Import: spec sección 7, Apply All: spec sección 8)

### 5.5 aggregate
- Solo normalized → batches = len(normalized), invalidRecords = 0
- Solo rejected → batches = len(rejected), invalidRecords = len(rejected)
- Mezcla → invariant `batches = trustedBatches + legacyBatches + legacyUntrustedBatches + invalidRecords`
- TRUSTED_ONLY excluye LEGACY y LEGACY_UNTRUSTED
- INCLUDE_LEGACY_IMPORT incluye LEGACY, excluye LEGACY_UNTRUSTED
- INCLUDE_UNTRUSTED_HISTORY incluye todos
- Denominador cero → rates null
- Duplicados → no se deduplican

### 5.6 Integration: reader
- Company sin AuditLog → reporte vacío (0 en todos los contadores)
- Mezcla de todos los tipos de registro → reporte coherente
- Filtro por source APPLY_ALL solo devuelve registros ApplyAllBatch
- Filtro por source IMPORT solo devuelve registros BankStatement
- Filtro por periodo from/to
- `entityId` es `null` en AuditLog → no rompe el reader

### 5.7 Route
- GET sin autenticación → error
- GET con parámetros válidos → 200 + ShadowMetricsReport JSON
- GET con trustPolicy inválido → error
- GET con source inválido → error
- GET con `from` inválido → HTTP 400
- GET con `to` inválido → HTTP 400
- GET con `from > to` → HTTP 400

---

## 6. Verificación final

```bash
npx tsc --noEmit
npx vitest run tests/unit/shadow-metrics-reader.test.ts
npx vitest run tests/unit/apply-all-use-case.test.ts
npx vitest run
npm run build
git diff --check
git status --short
```

---

## Resumen de archivos

| Archivo | Acción |
|---|---|
| `tests/unit/apply-all-use-case.test.ts` | Corregir fixture `makeSuccessResult()` con `ShadowPersistencePayload` real |
| `src/lib/services/shadow-metrics-reader.ts` | Crear (types + StageResult + pipeline functions + reader + AuditLogRepository interface) |
| `src/lib/db/audit-log-repository.ts` | Crear (`prismaAuditLogRepository` adapter concreto) |
| `src/app/api/admin/shadow-metrics/route.ts` | Crear (GET endpoint, inyecta adapter al reader) |
| `tests/unit/shadow-metrics-reader.test.ts` | Crear (tests exhaustivos) |
