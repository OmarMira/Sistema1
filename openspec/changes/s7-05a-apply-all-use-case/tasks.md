# S7-05A: Tasks — Apply All Use Case

## Orden de implementación

Cada fase debe completarse y verificarse antes de pasar a la siguiente. Las fases están diseñadas para minimizar el riesgo de regresión: primero se caracterizan los contratos actuales, luego se refactoriza el motor, luego se agrega el nuevo wrapper, luego se crea el Application Service, luego se conecta el controller, y finalmente se validan tests y build.

---

## Fase 1 — Caracterización de contratos actuales

Crear tests de caracterización que congelen el comportamiento actual de `matchTransactions()`, `executeApplyAll()`, `MatchResult` y `ApplyResult` **antes** de cualquier refactor.

### Tarea 1.1: Caracterizar `matchTransactions()`

**Archivo:** `tests/unit/apply-all-engine-characterization.test.ts` (NUEVO)

**Qué hacer:**
- Testear que `matchTransactions(companyId)` retorna `Promise<MatchResult>`.
- Testear que `matchTransactions(companyId, { limit: 200 })` retorna `Promise<MatchResult>`.
- Testear que `MatchResult` contiene exactamente `matchedRules`, `transactions`, `totalAmount`, `totalCount`, `remaining`.
- Testear que no contiene `shadowSummary`, `shadowBatchId`, `shadow` ni ningún campo de shadow.
- Testear que Preview (`GET /preview`) consume `matchTransactions()` sin cambios — verificar que el import sigue siendo `from '@/lib/services/apply-all-engine'`.

**Verificación:** `npx vitest run tests/unit/apply-all-engine-characterization.test.ts`

### Tarea 1.2: Caracterizar `executeApplyAll()`

**Archivo:** `tests/unit/apply-all-engine-characterization.test.ts`

**Qué hacer:**
- Testear que `executeApplyAll(companyId, tx, matchResult)` retorna `Promise<ApplyResult>`.
- Testear que `ApplyResult` contiene exactamente `appliedCount` y `journalEntryCount`.
- Testear que `journalEntryCount` está presente.

**Verificación:** `npx vitest run tests/unit/apply-all-engine-characterization.test.ts`

### Tarea 1.3: Caracterizar la ausencia de dependencias de shadow

**Archivo:** `tests/unit/apply-all-engine-characterization.test.ts`

**Qué hacer:**
- Verificar que ningún test existente de `matchTransactions()` (en `apply-all-engine-shadow.test.ts`, `characterization-apply-all-legacy.test.ts`, `characterization-apply-all-adapter.test.ts`) depende del side effect de persistencia de shadow.
- Documentar que el único test acoplado es `apply-all-engine-shadow.test.ts` línea 150 (`persistShadowSummaryBestEffort is called with ApplyAllBatch`) y será migrado en Fase 6.

---

## Fase 2 — Refactor: núcleo interno `executeMatching()`

### Tarea 2.1: Agregar tipos

**Archivo:** `src/lib/services/apply-all-engine.ts`

**Qué hacer:**
- Agregar (no exportado) `MatchingMode` — tipo interno de configuración de ejecución:

```typescript
type MatchingMode =
  | { shadow: 'disabled' }
  | { shadow: 'collect' };
```

- Agregar (exportado) `ShadowCollectionResult` — contrato público del shadow, lo que recibe el Application Service:

```typescript
export interface ShadowCollectionResult {
  summary: ShadowPersistencePayload;
  batchId: string;
}
```

- Agregar (exportado) `MatchTransactionsWithShadowResult` — único tipo discriminado del resultado de matching + shadow. `kind` representa el resultado EFECTIVO de la ejecución, no la intención del caller (el caller puede pedir `shadow: 'collect'` pero recibir `kind: 'without-shadow'` si flags, adapter o transacciones lo impiden):

```typescript
export type MatchTransactionsWithShadowResult =
  | {
      kind: 'without-shadow';
      matchResult: MatchResult;
    }
  | {
      kind: 'with-shadow';
      matchResult: MatchResult;
      shadow: ShadowCollectionResult;
    };
```

- `kind` con `'with-shadow'` SIEMPRE tiene `shadow` — no debe permitir estados inválidos.

- **No crear** `ShadowExecutionSummary` como tipo exportado — es un concepto puramente interno del flujo de `executeMatching()`. No necesita declaración type-level separada; se representa como `shadowSummary?: {...}` en el retorno.

**Verificación:** `npx tsc --noEmit`

### Tarea 2.2: Crear `executeMatching()` interno

**Archivo:** `src/lib/services/apply-all-engine.ts`

**Qué hacer:**
- Crear función interna (no exportada) que retorna el resultado del núcleo de matching en un formato intermedio: `{ matchResult, shadowSummary }` donde `shadowSummary` es un objeto de dominio sin batchId ni ShadowPersistencePayload.

```typescript
interface ExecuteMatchingResult {
  matchResult: MatchResult;
  shadowSummary?: {
    // contenido de ShadowExecutionSummary inline
    totalRules: number;
    skippedRules: number;
    errors: ShadowError[];
    matchedCount: number;
    legacyCount: number;
  };
}

async function executeMatching(
  companyId: string,
  mode: MatchingMode,
  options?: MatchOptions,
): Promise<ExecuteMatchingResult>
```

- **No exportar** esta función — es implementación privada.
- **Reglas:**
  - Carga reglas, transacciones, contextos una sola vez.
  - Ejecuta el loop de matching con `resolveApplyAllRule()`.
  - Si `mode.shadow === 'collect'` y las condiciones de flag lo permiten (RULE_PRECEDENCE_SHADOW_ENABLED=true y RULE_ENGINE_ADAPTER_ENABLED=false), acumula shadow durante el mismo loop:
    - `shadowRules` se mapean una sola vez antes del loop.
    - `createEmptyApplyAllShadowSummary()` se llama una sola vez.
    - Por cada transacción, ejecuta `runShadowComparison()`, `classifyDivergenceReason()` y `accumulateApplyAllShadowSummary()`.
    - No conoce `batchId`, `ShadowPersistencePayload` ni `ShadowCollectionResult` — son responsabilidad del wrapper público.
  - Si `mode.shadow === 'disabled'`, no hay flag checks de shadow, no hay acumulación, no hay importación de tipos de shadow.
  - No llama a `persistShadowSummaryBestEffort()` bajo ninguna condición.
  - Si shadow no se ejecutó (flags OFF, adapter ON, sin transacciones evaluadas), `shadowSummary` es `undefined`.
- Conservar toda la lógica productiva actual: `winnerMap`, `matchedRules`, `transactions`, `totalAmount`, `totalCount`, `remaining`, `eligibleForClassificationWhere`, `effectiveCap`, `MAX_PER_BATCH`, `entityContexts`, `rolePriorities`, `legacyCtx`, etc.
- `MatchingMode` no exportado — el tipo es interno.

**Verificación:** `npx tsc --noEmit` + `npx vitest run tests/unit/apply-all-engine-characterization.test.ts`

### Tarea 2.3: Refactorizar `matchTransactions()` como wrapper

**Archivo:** `src/lib/services/apply-all-engine.ts`

**Qué hacer:**
- Reemplazar el cuerpo actual de `matchTransactions()` por una delegación a `executeMatching()`:

```typescript
export async function matchTransactions(
  companyId: string,
  options?: MatchOptions,
): Promise<MatchResult> {
  const { matchResult } = await executeMatching(companyId, { shadow: 'disabled' }, options);
  return matchResult;
}
```

- No cambiar la firma, el tipo de retorno ni el nombre exportado.
- Remover del cuerpo de `matchTransactions()` toda la lógica de shadow: imports de shadow, flag checks, `shadowRules`, `shadowSummary`, batchId, shadow loop, llamadas a `classifyDivergenceReason`, `accumulateApplyAllShadowSummary`, `toPersistencePayload`, `persistShadowSummaryBestEffort`.
- Remover imports de shadow que ya no se usen desde `apply-all-engine.ts` (los que se movieron a `executeMatching()`). Mantener imports que `executeMatching()` necesita dentro del mismo archivo.

**Verificación:**
- `npx vitest run tests/unit/apply-all-engine-characterization.test.ts` — pasa.
- `npx vitest run tests/unit/characterization-apply-all-legacy.test.ts` — pasa sin cambios.
- `npx vitest run tests/unit/characterization-apply-all-adapter.test.ts` — pasa sin cambios.
- Preview (`GET /preview`) funciona: `npx vitest run tests/unit/apply-all-engine-shadow.test.ts` — los tests productivos (Shadow OFF, winnerMap) pasan.

---

## Fase 3 — Agregar `matchTransactionsWithShadow()`

### Tarea 3.1: Implementar `matchTransactionsWithShadow()`

**Archivo:** `src/lib/services/apply-all-engine.ts`

**Qué hacer:**
- Agregar función pública que llama al núcleo interno y convierte el resultado de dominio (`shadowSummary`) al contrato público (`ShadowCollectionResult`):

```typescript
export async function matchTransactionsWithShadow(
  companyId: string,
  options?: MatchOptions,
): Promise<MatchTransactionsWithShadowResult> {
  const { matchResult, shadowSummary } = await executeMatching(
    companyId, { shadow: 'collect' }, options,
  );

  if (!shadowSummary) {
    return { kind: 'without-shadow', matchResult };
  }

  return {
    kind: 'with-shadow',
    matchResult,
    shadow: {
      batchId: `apply-all-${crypto.randomUUID()}`,
      summary: toPersistencePayload(shadowSummary),
    },
  };
}
```

- `batchId` se genera AQUÍ, no en `executeMatching()`. El núcleo interno no conoce infraestructura (batchId, persistence payload).
- Sin narrowing adicional, sin casts, sin `as`, sin `any`.
- No debe llamar a `persistShadowSummaryBestEffort()` ni a ninguna función de persistencia.
- Nunca abre transacciones Prisma. Es puramente computacional + mapeo de tipos.
- Es determinista desde el punto de vista del caller (el único no determinismo es el UUID del batchId, puramente decorativo).

**Verificación:** `npx tsc --noEmit`

---

## Fase 4 — Crear Application Service

### Tarea 4.1: Crear `apply-all-use-case.ts`

**Archivo:** `src/lib/services/apply-all-use-case.ts` (NUEVO)

**Qué hacer:**
- Crear el archivo. El Application Service conoce únicamente `MatchTransactionsWithShadowResult` y `ShadowCollectionResult` (contratos públicos del motor).

```typescript
import { db } from '@/lib/db';
import {
  matchTransactionsWithShadow,
  executeApplyAll,
} from '@/lib/services/apply-all-engine';
import { persistShadowSummaryBestEffort } from '@/lib/services/rule-precedence-shadow';
import type { MatchResult, ApplyResult } from '@/lib/services/apply-all-engine';

export interface ApplyAllUseCaseResult {
  matchResult: MatchResult;
  applyResult: ApplyResult;
}

export async function executeApplyAllUseCase(
  companyId: string,
): Promise<ApplyAllUseCaseResult> {
  // 1. Matching + shadow collect (misma iteración, misma ejecución)
  const result = await matchTransactionsWithShadow(companyId, { limit: 200 });
  const { matchResult } = result;

  // 2. Early return (condición exacta del código actual)
  if (matchResult.matchedRules.length === 0 || matchResult.totalCount === 0) {
    return {
      matchResult,
      applyResult: { appliedCount: 0, journalEntryCount: 0 },
    };
  }

  // 3. Transacción productiva
  const applyResult = await db.$transaction(async (tx) => {
    return executeApplyAll(companyId, tx, matchResult);
  });

  // 4. Post-commit: shadow persistence best-effort
  //    Narrowing directo por kind — sin helpers, sin casts.
  if (result.kind === 'with-shadow') {
    await persistShadowSummaryBestEffort({
      companyId,
      entity: 'ApplyAllBatch',
      entityId: result.shadow.batchId,
      summary: result.shadow.summary,
    });
  }

  return { matchResult, applyResult };
}
```

- Sin `as`, sin type assertions, sin `any`, sin helpers intermedios.
- El narrowing por `kind` es directo, idiomático TypeScript.

**Verificación:** `npx tsc --noEmit`

### Tarea 4.2: Conectar el controller POST

**Archivo:** `src/app/api/bank-rules/apply-all/route.ts`

**Qué hacer:**
- Reemplazar la lógica inline actual (matchTransactions → early return → db.$transaction → response) por una llamada a `executeApplyAllUseCase()`:

```typescript
const { matchResult, applyResult } = await executeApplyAllUseCase(companyId);
```

- **Conservar en el controller:**
  - `requireCompanyContext()` (línea 26).
  - `locale` y i18n (líneas 29-30).
  - Construcción de `warning` (líneas 63-69).
  - Construcción de `rulesApplied` (líneas 72-76).
  - Estructura de `response` (líneas 79-85).
  - Códigos de error y manejo de excepciones de `apiHandler`.
- El early return ahora lo maneja el use case, no el controller. El controller recibe `matchResult` y `applyResult` y construye la respuesta HTTP igual que hoy.
- Remover imports de `matchTransactions` y `executeApplyAll` desde `apply-all-engine` si ya no se usan directamente.
- Agregar import de `executeApplyAllUseCase` desde `apply-all-use-case`.

**Verificación:** `npx tsc --noEmit`

---

## Fase 5 — Preview y controller: validación de no regresión

### Tarea 5.1: Verificar Preview

**Archivo:** `src/app/api/bank-rules/apply-all/preview/route.ts`

**Qué hacer:**
- No modificar este archivo.
- Verificar que sigue importando `matchTransactions` desde `@/lib/services/apply-all-engine`.
- Verificar que no importa nada desde `apply-all-use-case`.
- Verificar que la respuesta HTTP es idéntica.

**Verificación:** `npx vitest run` — los tests existentes de Preview pasan.

### Tarea 5.2: Verificar controller POST

**Archivo:** `src/app/api/bank-rules/apply-all/route.ts`

**Qué hacer:**
- Verificar que la respuesta HTTP del POST conserva exactamente su estructura actual.
- Verificar que `requireCompanyContext()`, i18n, warning, rulesApplied y códigos de error están en el controller, no en el use case.
- Verificar que el objeto `ApplyAllUseCaseResult` no expone `shadowPersisted`.

---

## Fase 6 — Migración y nuevos tests

### Tarea 6.1: Migrar test de persistencia desde `matchTransactions()`

**Archivo:** `tests/unit/apply-all-engine-shadow.test.ts`

**Qué hacer:**
- Remover el test "Shadow ON + Adapter OFF: persistShadowSummaryBestEffort is called with ApplyAllBatch" (líneas 150-163).
- Mantener todos los demás tests de matching productivo (Shadow OFF, winnerMap, matchedRules, same baseline, etc.).
- Verificar que los tests restantes no importan ni dependen de `persistShadowSummaryBestEffort`.

**Verificación:** `npx vitest run tests/unit/apply-all-engine-shadow.test.ts`

### Tarea 6.2: Agregar tests del Application Service

**Archivo:** `tests/unit/apply-all-use-case.test.ts` (NUEVO)

**Qué hacer:**
- Crear tests que verifiquen:

| Test | Qué verifica |
|---|---|
| Persistencia post-commit | `persistShadowSummaryBestEffort` es invocado DESPUÉS de que `db.$transaction` resuelve (mock del persistidor y mock de transacción exitosa) |
| Orden: transacción antes que persistencia | `db.$transaction` se llama ANTES que `persistShadowSummaryBestEffort` |
| Rollback sin persistencia | `db.$transaction` lanza excepción → `persistShadowSummaryBestEffort` NO es invocado |
| Early return sin transacción ni persistencia | `matchedRules.length === 0` o `totalCount === 0` → ni `db.$transaction` ni `persistShadowSummaryBestEffort` son invocados |
| Shadow OFF no persiste | `RULE_PRECEDENCE_SHADOW_ENABLED=false` → `persistShadowSummaryBestEffort` no invocado |
| Adapter ON no persiste | `RULE_ENGINE_ADAPTER_ENABLED=true` → `persistShadowSummaryBestEffort` no invocado |
| Best-effort falla sin alterar resultado | `persistShadowSummaryBestEffort` lanza error → `ApplyAllUseCaseResult` es idéntico al caso exitoso |
| Misma ejecución y cero recomputación | Verificar que `matchTransactionsWithShadow` se llama 1 vez, que `resolveApplyAllRule` se llama N veces (1 por transacción), y que no hay segundas llamadas a carga de reglas o transacciones. No inspeccionar funciones privadas — verificar comportamiento observable. |
| Preview sin side effects | Preview no importa ni ejecuta `executeApplyAllUseCase` |

**Requerimientos técnicos de los tests:**
- Usar `vi.mock` para mockear `db.$transaction`, `persistShadowSummaryBestEffort` y `matchTransactionsWithShadow`.
- Para el test de "misma ejecución": mockear `matchTransactionsWithShadow` y verificar que se llama exactamente 1 vez. Mockear las funciones que el núcleo interno llama (`resolveApplyAllRule`, `runShadowComparison`) y verificar que se llaman N veces (1 por transacción) — esto demuestra un único loop sin inspeccionar funciones privadas.
- Los mocks deben permitir simular tanto éxito como fallo de `db.$transaction`.
- No inspeccionar funciones no exportadas. No usar `vi.spyOn` sobre `executeMatching` (privado).

**Verificación:** `npx vitest run tests/unit/apply-all-use-case.test.ts`

---

## Fase 7 — Verificación final

### Tarea 7.1: TypeScript

```bash
npx tsc --noEmit
```
Sin errores de tipo.

### Tarea 7.2: Suites específicas

```bash
npx vitest run tests/unit/apply-all-engine-characterization.test.ts
npx vitest run tests/unit/apply-all-engine-shadow.test.ts
npx vitest run tests/unit/apply-all-use-case.test.ts
npx vitest run tests/unit/characterization-apply-all-legacy.test.ts
npx vitest run tests/unit/characterization-apply-all-adapter.test.ts
```
100% passing.

### Tarea 7.3: Suite completa

```bash
npx vitest run
```
Sin regresiones.

### Tarea 7.4: Build

```bash
npm run build
```
Build exitoso.

### Tarea 7.5: Diff físico

```bash
git diff
```
Verificar que los únicos cambios son los planificados:
- `src/lib/services/apply-all-engine.ts` — refactor interno, nuevos tipos, nueva exportación.
- `src/lib/services/apply-all-use-case.ts` — archivo nuevo.
- `src/app/api/bank-rules/apply-all/route.ts` — delega en use case.
- `tests/unit/apply-all-engine-characterization.test.ts` — archivo nuevo.
- `tests/unit/apply-all-engine-shadow.test.ts` — test de persistencia removido.
- `tests/unit/apply-all-use-case.test.ts` — archivo nuevo.
- `openspec/changes/s7-05a-apply-all-use-case/tasks.md` — este archivo.

### Tarea 7.6: Status

```bash
git status
```
Confirmar que no hay archivos modificados fuera del plan.

---

## Resumen de archivos afectados

| Archivo | Fase | Cambio |
|---|---|---|
| `src/lib/services/apply-all-engine.ts` | 2, 3 | Agregar `MatchingMode` (interno, no exportado), `ShadowCollectionResult` (público), `MatchTransactionsWithShadowResult` (público único). `executeMatching()` interno retorna `{ matchResult, shadowSummary }` sin batchId ni ShadowPersistencePayload. `matchTransactions()` wrapper delega en `executeMatching()`. `matchTransactionsWithShadow()` wrapper que convierte shadowSummary a ShadowCollectionResult con batchId. Remover persistencia. |
| `src/lib/services/apply-all-use-case.ts` | 4 | NUEVO. `ApplyAllUseCaseResult` y `executeApplyAllUseCase()`. |
| `src/app/api/bank-rules/apply-all/route.ts` | 4 | Reemplazar lógica inline por `executeApplyAllUseCase()`. Mantener controller intacto. |
| `tests/unit/apply-all-engine-characterization.test.ts` | 1 | NUEVO. Tests de caracterización de contratos actuales. |
| `tests/unit/apply-all-engine-shadow.test.ts` | 6 | Remover test de persistencia (líneas 150-163). Mantener tests productivos. |
| `tests/unit/apply-all-use-case.test.ts` | 6 | NUEVO. Tests del Application Service. |
| `openspec/changes/s7-05a-apply-all-use-case/spec.md` | — | Ya existe, no modificar. |
| `openspec/changes/s7-05a-apply-all-use-case/tasks.md` | — | Este archivo. |
