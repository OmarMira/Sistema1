# S7-05B: Shadow Metrics Reporting — Reader y Agregador desde AuditLog

## 1. Objective

Diseñar e implementar un lector y agregador de métricas Shadow persistidas en AuditLog con `action = 'RULE_PRECEDENCE_SHADOW_SUMMARY'`. El reader debe soportar dos fuentes incompatibles (Import y Apply All), clasificar registros por confianza según esquema y fuente, validar invariantes internas, normalizar ambos esquemas a una taxonomía común, y producir un reporte agregado con tasas de acuerdo, divergencia, ambigüedad y error.

## 2. Invariante Fundamental

S7-05B es una fase de **lectura, validación y agregación**. No modifica ningún registro existente, no altera el comportamiento de Import ni Apply All, y no escribe en AuditLog:

- Los registros de AuditLog son inmutables desde la perspectiva de esta fase.
- No existe corrección silenciosa de payloads inválidos — se clasifican como `INVALID` y se reportan en `invalidRecords`.
- No existe deduplicación silenciosa — registros repetidos se reportan o se define una estrategia explícita.
- El reader no lee `process.env` — recibe configuración explícita vía parámetros.
- Las tasas se calculan exclusivamente a partir de registros confiables según `trustPolicy`.
- Apply All v0 queda excluido de tasas por defecto.
- Ningún umbral de activación se define en esta fase — el reader produce métricas, no decisiones.

## 3. Scope / Exclusions

### Incluye

- `ShadowMetricsReader` como parser/validador/clasificador/agregador puro (sin efectos secundarios).
- `ShadowMetricsQuery` como entrada tipada del reader (sin `process.env`).
- `ShadowMetricsReport` como contrato de salida.
- `ShadowMetricsEnvelopeV1` como formato de persistencia nuevo (schemaVersion: 1).
- Clasificación de confianza: `TRUSTED`, `LEGACY`, `LEGACY_UNTRUSTED`, `INVALID`.
- Normalización de esquemas Import v0 (BankStatement) a taxonomía común.
- Normalización de esquemas Apply All v0 (ApplyAllBatch) a taxonomía común.
- Validación de invariantes: `totalEvaluated = sum(categorías)` y `agreementRate + divergenceRate + ambiguityRate = 1`.
- Route `/api/admin/shadow-metrics` como controller que resuelve company context, parsea query params, llama al reader y devuelve el reporte.
- Corrección del fixture en `tests/unit/apply-all-use-case.test.ts` que usa `diverged`/`errors` en lugar de `ShadowPersistencePayload`.

### Excluye

- Modificaciones a Import, Apply All o cualquier flujo productivo.
- Modificaciones a `rule-precedence-shadow.ts` (tipos ya existen).
- Cambios en Prisma schema o migraciones.
- UI de ningún tipo.
- Thresholds o reglas de activación (responsabilidad de fase posterior).
- Tasks de implementación.
- Commit o push.

## 4. Schemas Físicos v0

### 4.1 Import v0 — BankStatement (entity = 'BankStatement', sin schemaVersion)

Payload es `ShadowImportSummary` serializado con `JSON.stringify()`:

```typescript
interface ShadowImportSummaryV0 {
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

Almacenado en `auditLog.details` (Prisma `String?`) sin schemaVersion, sin envelope.

### 4.2 Apply All v0 — ApplyAllBatch (entity = 'ApplyAllBatch', sin schemaVersion)

Payload es `ShadowPersistencePayload` serializado con `JSON.stringify()`:

```typescript
interface ShadowPersistencePayloadV0 {
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

Nota: `bothNoMatch`, `productiveMatchCanonicalNoMatch`, `productiveNoMatchCanonicalMatch`, `canonicalAmbiguous` no se persisten en Apply All v0. Se pierden en la transformación `toPersistencePayload()` en `rule-precedence-shadow.ts:285`.

### 4.3 Legacy Issue — Apply All v0 sin bothNoMatch

Dado que Apply All v0 persiste `ShadowPersistencePayload`, los campos `bothNoMatch`, `productiveMatchCanonicalNoMatch`, `productiveNoMatchCanonicalMatch`, y `canonicalAmbiguous` nunca se escriben. El split interno de `sameDecision` (sameWinner vs bothNoMatch) no es recuperable para Apply All v0.

## 5. Envelope V1

### 5.1 Formato

Todos los registros nuevos deben persistirse con el siguiente envelope versionado:

```typescript
interface ShadowMetricsEnvelopeV1 {
  schemaVersion: 1;
  source: 'IMPORT' | 'APPLY_ALL';
  metrics: ShadowMetricsPayloadV1;
}
```

### 5.2 Payload V1 — unificado

```typescript
interface ShadowMetricsPayloadV1 {
  totalEvaluated: number;
  sameWinner: number;
  bothNoMatch: number;
  productiveMatchCanonicalNoMatch: number;
  productiveNoMatchCanonicalMatch: number;
  differentWinner: number;
  canonicalAmbiguous: number;
  shadowErrors: number;
  divergenceReasons: {
    NO_MATCH: number;
    AMBIGUOUS: number;
    UNDETERMINED: number;
    OTHER: number;
  };
}
```

Equivalente a `ShadowExecutionSummary` pero con schema explícito y obligatorio.

### 5.3 Política de detección

- Si `details` es un objeto JSON con `schemaVersion === 1` y `source` válido → es V1.
- Si `details` es un objeto JSON sin `schemaVersion` o con `schemaVersion !== 1` → es v0.
- Si `details` no es JSON válido o es `null` → `INVALID`.

### 5.4 Compatibilidad futura

`schemaVersion` es `number`, no `string`. Versiones futuras incrementan el número. El reader rechaza `schemaVersion > 1` como `INVALID` (schema no soportado).

## 6. Trust Classification

### 6.1 Tipo

```typescript
type ShadowRecordTrust =
  | 'TRUSTED'
  | 'LEGACY'
  | 'LEGACY_UNTRUSTED'
  | 'INVALID';
```

### 6.2 Política exacta

| Condición | Trust |
|---|---|
| `schemaVersion === 1` y payload V1 válido (invariantes OK) | `TRUSTED` |
| `schemaVersion === 1` y payload V1 inválido (invariantes rotas) | `INVALID` |
| entity `BankStatement`, v0, y `ShadowImportSummaryV0` válido | `LEGACY` |
| entity `ApplyAllBatch`, v0, y `ShadowPersistencePayloadV0` válido | `LEGACY_UNTRUSTED` |
| Entity `BankStatement` o `ApplyAllBatch`, raw contiene `diverged` o `errors` (campos que no existen en ningún schema productivo) | `INVALID` (`BUGGY_FIXTURE_SCHEMA`) |
| JSON inválido o `null` | `INVALID` |
| Campos negativos (e.g., `totalEvaluated < 0`, `shadowErrors < 0`) | `INVALID` |
| Invariante `totalEvaluated` rota (ver sección 9) | `INVALID` |
| Schema version `> 1` | `INVALID` |
| entity desconocido o source inválido | `INVALID` |
| source V1 contradice entity (ej: `source: 'IMPORT'` con `entity: 'ApplyAllBatch'`) | `INVALID` (`SOURCE_ENTITY_MISMATCH`) |

### 6.3 Default trust policy para tasas

Por defecto, las tasas principales incluyen únicamente:
- `TRUSTED`
- `LEGACY` (Import v0)

`LEGACY_UNTRUSTED` (Apply All v0) queda excluido de tasas por defecto.

`INVALID` nunca entra en tasas.

### 6.4 Trust policies configurables

```typescript
type ShadowMetricsTrustPolicy =
  | 'TRUSTED_ONLY'                          // Solo V1
  | 'INCLUDE_LEGACY_IMPORT'                 // TRUSTED + LEGACY (default)
  | 'INCLUDE_UNTRUSTED_HISTORY';            // TRUSTED + LEGACY + LEGACY_UNTRUSTED
```

`INCLUDE_UNTRUSTED_HISTORY` permite incluir Apply All v0 en los contadores históricos, pero las tasas principales deben indicar claramente si fueron calculadas incluyendo datos no confiables (ver sección 12).

## 7. Normalización — Import

### 7.1 Mapeo desde V0 (ShadowImportSummary) y V1

| Taxonomía común | Fuente V0 | Fuente V1 |
|---|---|---|
| `sameDecision` | `sameWinner + bothNoMatch` | `sameWinner + bothNoMatch` |
| `divergentDecision` | `productiveMatchCanonicalNoMatch + productiveNoMatchCanonicalMatch + differentWinner` | `productiveMatchCanonicalNoMatch + productiveNoMatchCanonicalMatch + differentWinner` |
| `ambiguous` | `canonicalAmbiguous` | `canonicalAmbiguous` |
| `errors` | `shadowErrors` | `shadowErrors` |
| `validComparisons` | `totalEvaluated - shadowErrors` | `totalEvaluated - shadowErrors` |

### 7.2 Taxonomía exacta

```
sameDecision = sameWinner + bothNoMatch

divergentDecision = productiveMatchCanonicalNoMatch
                  + productiveNoMatchCanonicalMatch
                  + differentWinner

ambiguous = canonicalAmbiguous

errors = shadowErrors

validComparisons = totalEvaluated - errors
```

### 7.3 Validación obligatoria

```
totalEvaluated = sameDecision + divergentDecision + ambiguous + errors
```

Si no se cumple → `INVALID`.

## 8. Normalización — Apply All

### 8.1 Mapeo desde V0 (ShadowPersistencePayload) y V1

| Taxonomía común | Fuente V0 | Fuente V1 |
|---|---|---|
| `divergentDecision` | `divergenceReasons.NO_MATCH + divergenceReasons.OTHER + divergenceReasons.UNDETERMINED` | `productiveMatchCanonicalNoMatch + productiveNoMatchCanonicalMatch + differentWinner` |
| `ambiguous` | `divergenceReasons.AMBIGUOUS` | `canonicalAmbiguous` |
| `errors` | `shadowErrors` | `shadowErrors` |
| `sameDecision` | `validComparisons - divergentDecision - ambiguous` | `sameWinner + bothNoMatch` |
| `validComparisons` | `totalEvaluated - shadowErrors` | `totalEvaluated - shadowErrors` |

**Importante para V0:** No existe `bothNoMatch` ni `productiveMatchCanonicalNoMatch` ni `productiveNoMatchCanonicalMatch` ni `canonicalAmbiguous` en el payload persistido de Apply All v0. El split interno de `sameDecision` (sameWinner vs bothNoMatch) no es recuperable.

**Para V1:** Apply All usa el mismo `ShadowMetricsPayloadV1` que Import, con `divergenceReasons` redundante con los contadores funcionales. Esto permite reportar `reasons` incluso en V1 sin depender de V0.

### 8.2 Taxonomía exacta

```
divergentDecision = divergenceReasons.NO_MATCH
                  + divergenceReasons.OTHER
                  + divergenceReasons.UNDETERMINED

ambiguous = divergenceReasons.AMBIGUOUS

errors = shadowErrors

validComparisons = totalEvaluated - errors

sameDecision = validComparisons - divergentDecision - ambiguous
```

### 8.3 Validaciones obligatorias

```
differentWinner === divergenceReasons.UNDETERMINED
sameDecision >= 0
```

Si falla cualquiera → `INVALID`.

**Importante:** `differentWinner` no se suma junto con `divergenceReasons` porque eso duplicaría `UNDETERMINED`. En Apply All v0, `differentWinner` es un contador que SIEMPRE debe ser igual a `divergenceReasons.UNDETERMINED` por construcción. Si no coinciden, el registro es inconsistente.

### 8.4 Limitación documentada

`bothNoMatch` no está persistido en Apply All v0. Se deriva por resta dentro de `sameDecision`. No se puede recuperar el split interno `sameWinner` vs `bothNoMatch` para Apply All v0.

## 9. Invariantes

### 9.1 Invariante de totalEvaluated (Import v0/v1, Apply All v1)

```
totalEvaluated = sameWinner
               + bothNoMatch
               + productiveMatchCanonicalNoMatch
               + productiveNoMatchCanonicalMatch
               + differentWinner
               + canonicalAmbiguous
               + shadowErrors
```

### 9.2 Invariante de divergencia (Apply All v0)

```
differentWinner === divergenceReasons.UNDETERMINED
sameDecision >= 0
```

### 9.3 Invariante de campo negativo

Ningún campo numérico puede ser negativo. Si cualquier contador es `< 0`, el registro es `INVALID`.

### 9.4 Invariante de no-NaN

Ningún campo numérico puede ser `NaN`. `JSON.parse` nativo rechaza `NaN` (no es JSON válido), pero `Infinity` también debe rechazarse.

## 10. Fórmulas

### 10.1 Definiciones

```typescript
agreementRate =
  validComparisons > 0
    ? sameDecision / validComparisons
    : null

divergenceRate =
  validComparisons > 0
    ? divergentDecision / validComparisons
    : null

ambiguityRate =
  validComparisons > 0
    ? ambiguous / validComparisons
    : null

errorRate =
  totalEvaluated > 0
    ? errors / totalEvaluated
    : null
```

### 10.2 Consistencia

```
agreementRate + divergenceRate + ambiguityRate = 1
```

Salvo error de redondeo de punto flotante. El reader debe redondear a precisión razonable (e.g., 6 decimales) si es necesario para reporte, pero la validación de consistencia debe tolerar diferencias de hasta `Number.EPSILON * validComparisons`.

### 10.3 null semantics

Los rates son `null` cuando el denominador es 0 (no hay datos). `null` indica "no calculable", no "0%".

## 11. ShadowMetricsQuery

### 11.1 Interfaz

```typescript
interface ShadowMetricsQuery {
  companyId: string;
  source: 'IMPORT' | 'APPLY_ALL' | 'ALL';
  from: Date;
  to: Date;
  trustPolicy?: ShadowMetricsTrustPolicy;
}
```

`trustPolicy` default: `'INCLUDE_LEGACY_IMPORT'`.

### 11.2 Reglas

- `companyId` es obligatorio.
- `from` y `to` definen la ventana de tiempo del `createdAt` del AuditLog.
- `source` filtra por entity: `IMPORT` → entity `'BankStatement'`, `APPLY_ALL` → entity `'ApplyAllBatch'`, `ALL` → ambos.
- `trustPolicy` controla qué registros entran en las tasas (ver sección 6.4). Por defecto: `'INCLUDE_LEGACY_IMPORT'`.
- `trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY'` puede incluir Apply All v0 en contadores, pero NO se recomienda para decisiones de activación.

### 11.3 El reader no lee process.env

`ShadowMetricsReader` recibe `ShadowMetricsQuery` como entrada. No accede a variables de entorno, feature flags ni configuración global. La route o Application Service resuelve configuración externa y la pasa como parámetro.

## 12. ShadowMetricsReport

### 12.1 Contrato

```typescript
interface ShadowMetricsReport {
  source: 'IMPORT' | 'APPLY_ALL' | 'ALL';
  period: {
    from: Date;
    to: Date;
  };

  batches: number;            // Total de registros procesados
  trustedBatches: number;     // Registros TRUSTED
  legacyBatches: number;      // Registros LEGACY
  legacyUntrustedBatches: number; // Registros LEGACY_UNTRUSTED
  invalidRecords: number;     // Registros INVALID

  totalEvaluated: number;     // Suma agregada de totalEvaluated (solo registros en tasas)
  validComparisons: number;   // Suma agregada de validComparisons (solo registros en tasas)
  sameDecision: number;       // Suma agregada de sameDecision (solo registros en tasas)
  divergentDecision: number;  // Suma agregada de divergentDecision (solo registros en tasas)
  ambiguous: number;          // Suma agregada de ambiguous (solo registros en tasas)
  errors: number;             // Suma agregada de errors (solo registros en tasas)

  agreementRate: number | null;
  divergenceRate: number | null;
  ambiguityRate: number | null;
  errorRate: number | null;

  reasons: {
    NO_MATCH: number;
    AMBIGUOUS: number;
    UNDETERMINED: number;
    OTHER: number;
  };
}
```

### 12.2 Data quality vs contadores existentes

Los contadores `batches`, `trustedBatches`, `legacyBatches`, `legacyUntrustedBatches` e `invalidRecords` ya proporcionan visibilidad de calidad de datos a nivel de agregación. No se necesita una sección separada de `dataQuality` en esta fase. Si en el futuro se requiere calidad a nivel de registro individual (errores de parseo, schemas inesperados), se puede agregar un array `errors: string[]` opcional o una sección `dataQuality` separada sin romper el contrato actual.

### 12.3 Reglas de agregación

- `totalEvaluated`, `validComparisons`, `sameDecision`, `divergentDecision`, `ambiguous`, `errors`: sumas de todos los registros que entran en tasas según `trustPolicy`.
- `batches`: todos los registros procesados (incluyendo `INVALID`).
- `trustedBatches`, `legacyBatches`, `legacyUntrustedBatches`: según clasificación de confianza (incluyendo registros no incluidos en tasas).
- `invalidRecords`: registros `INVALID`.
- `reasons`: suma de `divergenceReasons` de todos los registros que entran en tasas. Disponible incluso cuando `source` es `'IMPORT'` — Import V1 también incluye `divergenceReasons`.

### 12.4 Rates

Los rates se calculan sobre los totales agregados:
- `agreementRate = validComparisons > 0 ? sameDecision / validComparisons : null`
- `divergenceRate = validComparisons > 0 ? divergentDecision / validComparisons : null`
- `ambiguityRate = validComparisons > 0 ? ambiguous / validComparisons : null`
- `errorRate = totalEvaluated > 0 ? errors / totalEvaluated : null`

## 13. Pipeline Interno — Etapas con Responsabilidad Única

### 13.1 Contrato normalizado interno

Entre el normalizador y el agregador existe un contrato interno `NormalizedShadowRecord`:

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

El agregador conoce `source` como dimensión de agrupación, pero **no conoce ni bifurca por los esquemas físicos** `ShadowImportSummary` o `ShadowPersistencePayload`. La normalización aísla al agregador de la diversidad de schemas históricos.

### 13.2 Resultado discriminado del pipeline

Cada registro procesado produce un resultado discriminado. El agregador recibe **todos** los resultados (incluyendo rechazados) para poder contabilizar `invalidRecords` y `legacyUntrustedBatches` sin estado lateral:

```typescript
type ShadowRecordProcessingResult =
  | {
      kind: 'normalized';
      record: NormalizedShadowRecord;
    }
  | {
      kind: 'rejected';
      trust: 'INVALID';
      reason: ShadowRecordRejectionReason;
    };
```

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

### 13.3 Pipeline — 5 etapas secuenciales

Cada etapa tiene una responsabilidad única. Las etapas 1-4 procesan un registro individual. La etapa 5 agrega el conjunto completo.

**Invariante del pipeline:** cada fila de `AuditLog` produce exactamente un `ShadowRecordProcessingResult`. Nunca cero resultados (toda fila leída genera normalized o rejected). Nunca más de uno. Es una transformación 1→1.

```
AuditLog.details (string | null)
   │
   ▼
┌──────────────────────────────────────┐
│ 1. parseJson(details)                │  RawJson | null
│    JSON.parse(details)               │  null → rejected(INVALID_JSON)
└──────────────────────────────────────┘
   │ raw
   ▼
┌──────────────────────────────────────┐
│ 2. detectSchema(raw, entity)         │  SchemaInfo | null
│    schemaVersion check               │  source vs entity cross-validation
│    v0 shape detection                │  null → rejected(UNKNOWN_SCHEMA,
│    fixture diverged/errors           │             UNSUPPORTED_VERSION, etc.)
└──────────────────────────────────────┘
   │ schemaInfo
   ▼
┌──────────────────────────────────────┐
│ 3. validateInvariants(schemaInfo)    │  ValidRawRecord | null
│    totalEvaluated sum invariant      │  differentWinner === UNDETERMINED
│    sameDecision >= 0                 │  null → rejected(NEGATIVE_COUNTER,
│    no negative fields, no NaN        │             INVARIANT_VIOLATION, etc.)
└──────────────────────────────────────┘
   │ valid
   ▼
┌──────────────────────────────────────┐
│ 4. normalize(valid, schemaInfo)      │  NormalizedShadowRecord
│    Import → sección 7                │  trust se asigna según sección 6.2
│    Apply All → sección 8             │
└──────────────────────────────────────┘
   │
   └── ShadowRecordProcessingResult ────┘
   │
   ▼ (array de todos los registros leídos)
┌──────────────────────────────────────┐
│ 5. aggregate(results[], query)       │  ShadowMetricsReport
│    rejected → cuenta (siempre)       │  normalized → filtra por trustPolicy
│    suma contadores, calcula rates    │
└──────────────────────────────────────┘
   │
   ▼
Response JSON
```

### 13.4 Responsabilidades detalladas

#### parseJson(details: string | null): RawJson | null

- `JSON.parse(details)`.
- Si `details` es `null` o el parseo lanza → `null`.
- No clasifica trust aún — solo determina si hay JSON válido.

#### detectSchema(raw: RawJson, entity: string): SchemaInfo | null

- Si `raw.schemaVersion === 1`:
  - Valida que `raw.source` sea `'IMPORT'` o `'APPLY_ALL'`.
  - **Validación cruzada source/entity**: si `raw.source === 'IMPORT'` pero `entity !== 'BankStatement'` → `null`. Si `raw.source === 'APPLY_ALL'` pero `entity !== 'ApplyAllBatch'` → `null`.
  - Si pasa → V1.
- Si no hay `schemaVersion`:
  - `entity === 'BankStatement'` y raw tiene los 7 campos de `ShadowImportSummary` → v0 Import.
  - `entity === 'ApplyAllBatch'` y raw tiene `divergenceReasons`, `differentWinner`, `shadowErrors` → v0 Apply All.
  - Si raw contiene `diverged` o `errors` (campos que no existen en ningún schema válido) → fixture contaminado.
  - Si `raw.schemaVersion > 1` → schema no soportado.
- Si no clasifica → `null`.

#### validateInvariants(schemaInfo: SchemaInfo): ValidRawRecord | null

- Import v0/v1: verifica `totalEvaluated = sameWinner + bothNoMatch + productiveMatchCanonicalNoMatch + productiveNoMatchCanonicalMatch + differentWinner + canonicalAmbiguous + shadowErrors`.
- Apply All v0: verifica `differentWinner === divergenceReasons.UNDETERMINED` y `sameDecision >= 0` (derivado por resta).
- Todos: ningún campo negativo, ningún campo NaN/Infinity.
- Si falla → `null`.

#### normalize(valid: ValidRawRecord, schemaInfo: SchemaInfo): NormalizedShadowRecord

- Mapea campos según source (sección 7 para Import, sección 8 para Apply All).
- Produce `NormalizedShadowRecord`.
- La clasificación `trust` se resuelve combinando `schemaInfo` + resultado de validación (sección 6.2).

#### aggregate(results: ShadowRecordProcessingResult[], query: ShadowMetricsQuery): ShadowMetricsReport

- Recibe el array completo de resultados del pipeline (uno por fila de AuditLog leída).
- **Los contadores `batches`, `trustedBatches`, `legacyBatches`, `legacyUntrustedBatches` e `invalidRecords` representan el universo completo de filas AuditLog leídas, independientemente del `trustPolicy`.** No se filtran por trustPolicy.
- `batches`: cantidad total de filas AuditLog procesadas (normalizadas + rechazadas).
- `trustedBatches`: cantidad de resultados normalizados con `trust === 'TRUSTED'`.
- `legacyBatches`: cantidad de resultados normalizados con `trust === 'LEGACY'`.
- `legacyUntrustedBatches`: cantidad de resultados normalizados con `trust === 'LEGACY_UNTRUSTED'` (Apply All v0 que pasó validación — no es un rejected, es un registro perfectamente válido pero no confiable para métricas por defecto).
- `invalidRecords`: cantidad de resultados `{ kind: 'rejected', trust: 'INVALID' }` (no pudo normalizarse por schema inválido, invariantes rotas, JSON malformado, etc.).
- **Invariante del agregador:** `batches = trustedBatches + legacyBatches + legacyUntrustedBatches + invalidRecords`. Siempre se cumple. Si alguien rompe el pipeline, esta igualdad deja de cumplirse.
- **Conceptualmente** `INVALID` y `LEGACY_UNTRUSTED` son categorías ortogonales: `INVALID` no pudo normalizarse; `LEGACY_UNTRUSTED` sí se normalizó pero su fuente histórica (Apply All v0 previo a envelope) no es confiable para tasas por defecto.
- Los resultados normalizados se filtran por `trustPolicy` para el cálculo de tasas y contadores acumulados (`totalEvaluated`, `sameDecision`, etc.), pero los contadores de batches son siempre sobre el total leído.
- Filtrado por `trustPolicy`:
  - `TRUSTED_ONLY`: solo `trust === 'TRUSTED'` entra en tasas.
  - `INCLUDE_LEGACY_IMPORT` (default): `TRUSTED` + `LEGACY` entran en tasas.
  - `INCLUDE_UNTRUSTED_HISTORY`: todos los normalizados entran en tasas.
- Suma contadores de los incluidos.
- Calcula rates (sección 10).
- Retorna `ShadowMetricsReport`.

### 13.5 Capa de aplicación — Route

```
src/app/api/admin/shadow-metrics/route.ts
```

1. Valida company context (`requireCompanyContext()`).
2. Parsea query params: `from`, `to`, `source` (default `'ALL'`), `trustPolicy` (default `'INCLUDE_LEGACY_IMPORT'`).
3. Construye `ShadowMetricsQuery`.
4. Llama al pipeline completo.
5. Devuelve `ShadowMetricsReport` como JSON.

La route es responsable de resolver configuración externa (por ahora, sólo defaults). En el futuro, podría leer config de company o feature flags y pasarlos en `trustPolicy`.

### 13.6 Flujo completo

```
HTTP GET /api/admin/shadow-metrics?from=...&to=...&source=...&trustPolicy=...
  ↓
requireCompanyContext() — valida sesión y company
  ↓
Parse query params → ShadowMetricsQuery { companyId, source, from, to, trustPolicy }
  ↓
fetch AuditLog records (action, companyId, source entity, createdAt range)
  ↓
for each record:
  parseJson() → detectSchema() → validateInvariants() → normalize()
  │                                              └─ null → ShadowRecordProcessingResult{ rejected }
  └─────────────────── ShadowRecordProcessingResult ───────────────────┘
  ↓
aggregate(results[], query) → ShadowMetricsReport
  ├─ batches, invalidRecords, legacyUntrustedBatches = siempre del total leído
  ├─ trustedBatches, legacyBatches = del total leído
  └─ totalEvaluated, rates, reasons = solo registros que pasan trustPolicy
  ↓
Response JSON
```

## 14. Compatibilidad Histórica

### 14.1 Políticas documentadas

| Principio | Regla |
|---|---|
| Apply All v0 en tasas | No entra por defecto. `trustPolicy: 'INCLUDE_UNTRUSTED_HISTORY'` lo incluye. |
| Import v0 en tasas | Entra por defecto (LEGACY). `trustPolicy: 'TRUSTED_ONLY'` lo excluye. |
| Registros INVALID en tasas | Nunca entran. Se contabilizan en `invalidRecords`. |
| Fecha de commit como criterio de confianza | No usar. La confianza deriva del schema, no de cuándo se escribió. |
| Corrección silenciosa | No corregir payloads inválidos. Reportar como INVALID. |
| Deduplicación silenciosa | No deduplicar. Repetir registros se refleja en contadores. Si se identifica duplicación real (mismo entityId, misma source, mismo batch), documentar y considerar estrategia explícita en fase futura. |

### 14.2 Riesgo histórico conocido

En S7-04C, durante el desarrollo de Apply All shadow, algunos fixtures de test pueden haber persistido payloads con forma `{ totalEvaluated, sameWinner, diverged, errors }` (campos incorrectos). Estos registros, si existen en producción, se clasificarán como `INVALID` con `reason: 'BUGGY_FIXTURE_SCHEMA'`:

- El parseo detecta campos extraños (`diverged`, `errors`) que no corresponden a `ShadowImportSummary` ni a `ShadowPersistencePayload`. No existe ningún schema productivo que incluya esos campos. El registro no puede normalizarse → `INVALID`. No entra en tasas bajo ningún trustPolicy.

## 15. Manejo de Duplicados

### 15.1 Política actual

No se realiza deduplicación. Si dos registros de AuditLog tienen el mismo `entityId` y misma fuente, ambos se procesan y agregan. Esto es intencional porque:

- AuditLog no garantiza unicidad por `entityId` (un batch podría generar múltiples registros en caso de re-ejecución).
- La deduplicación requeriría definir una estrategia (último registro gana? merge?). Es una decisión de producto para una fase futura.
- La repetición de registros es detectable por el usuario al comparar `batches` vs el número esperado.

### 15.2 Recomendación futura

Si la duplicación resulta ser un problema en reportes, implementar en una fase posterior:

- Opción A: Deducir por `entityId` + `source` (último `createdAt`).
- Opción B: Incluir `batchId` en el envelope V1 y deduplicar por él.
- Opción C: Reportar duplicados en una sección separada sin filtrarlos.

Cualquier estrategia debe ser explícita y opt-in, no silenciosa.

## 16. Acceptance Criteria

1. **Reader puro**: `ShadowMetricsReader` no lee `process.env`, no escribe, no modifica datos.
2. **Versionado**: Registros con `schemaVersion: 1` se clasifican como `TRUSTED` si las invariantes pasan.
3. **V0 legacy**: BankStatement v0 válido es `LEGACY` y entra en tasas por defecto.
4. **V0 legacy untrusted**: ApplyAllBatch v0 válido es `LEGACY_UNTRUSTED` y NO entra en tasas por defecto.
5. **INVALID**: JSON inválido, campos negativos, invariantes rotas, schema > 1 → `INVALID`. Nunca entra en tasas.
6. **Taxonomía Import**: `sameDecision = sameWinner + bothNoMatch`. `totalEvaluated` invariant validated.
7. **Taxonomía Apply All**: `divergentDecision = divergenceReasons.NO_MATCH + OTHER + UNDETERMINED`. `differentWinner === divergenceReasons.UNDETERMINED` validated. `sameDecision >= 0`.
8. **No double-count**: `differentWinner` no se suma con `divergenceReasons` en Apply All.
9. **Rates**: `agreementRate + divergenceRate + ambiguityRate = 1` (tolera redondeo).
10. **Rates null**: rates son `null` cuando denominador es 0.
11. **Report**: Contiene `batches`, `trustedBatches`, `legacyBatches`, `legacyUntrustedBatches`, `invalidRecords`, `reasons`, y todos los contadores agregados.
12. **Source filter**: `IMPORT` filtra entity `BankStatement`, `APPLY_ALL` filtra entity `ApplyAllBatch`, `ALL` incluye ambos.
13. **ShadowMetricsTrustPolicy**: `TRUSTED_ONLY` excluye v0. `INCLUDE_LEGACY_IMPORT` incluye BankStatement v0 (default). `INCLUDE_UNTRUSTED_HISTORY` incluye todos los normalizados, incluyendo Apply All v0.
14. **Route**: `/api/admin/shadow-metrics` valida company, parsea query params, devuelve reporte JSON.
15. **Fixture corregido**: `tests/unit/apply-all-use-case.test.ts` usa `ShadowPersistencePayload` con `divergenceReasons`, no `diverged`/`errors`.
16. **Sin thresholds**: el reader no define umbrales de activación.
17. **Sin deduplicación silenciosa**: registros repetidos no se filtran.

## 17. Archivos Previstos

| Archivo | Cambio |
|---|---|
| `src/lib/services/shadow-metrics-reader.ts` | Crear. `ShadowMetricsQuery`, `ShadowMetricsReport`, `ShadowMetricsEnvelopeV1`, `ShadowMetricsPayloadV1`, `ShadowRecordTrust`, `ShadowMetricsTrustPolicy`, `ShadowRecordProcessingResult`, `ShadowRecordRejectionReason`, `NormalizedShadowRecord`. `ShadowMetricsReader.read(query)`. |
| `src/app/api/admin/shadow-metrics/route.ts` | Crear. GET endpoint. Validar company context, parsear query params, llamar al reader, devolver reporte. |
| `tests/unit/apply-all-use-case.test.ts` | Corregir fixture en `makeSuccessResult()`: reemplazar `diverged: 0, errors: 0` por `ShadowPersistencePayload` completo con `divergenceReasons`. |

## 18. Decisiones Abiertas

1. **Paginación**: Si hay muchos registros de AuditLog (miles), ¿el reader debe paginar? Propuesta inicial: sin paginación. Si es necesario, el `from`/`to` permite ventanas pequeñas. Agregar paginación si hay evidencia de timeout.

2. **Caché**: El reporte se calcula en cada request. Propuesta inicial: sin caché. Si el volumen crece, considerar caché con TTL configurable.

3. **Data quality section**: Por ahora los contadores de clasificación de confianza son suficientes. Si se necesita granularidad por error de parseo vs invariante vs schema, agregar en fase futura.

4. **Deduplicación**: Pendiente de decisión de producto. Ver sección 15.

5. **Source ALL mixto**: Cuando `source: 'ALL'`, ¿se agregan fuentes heterogéneas en el mismo reporte? Sí — el reporte combinado da visión global. Si se necesita separado, el cliente puede hacer dos llamadas con source específico.

6. **Rates en source ALL**: Al agregar Import + Apply All, los rates son sobre el total combinado. Esto es correcto para visión global; el cliente puede filtrar por source si necesita rates separados.

7. **Exposición de registros individuales**: El reporte es agregado. Si se necesita debugging por registro individual, crear un endpoint separado más adelante.
