# S7-05A: Apply All Use Case — Shadow Metrics After Commit

## Objective

Extraer la persistencia de Shadow Metrics del motor de matching (`matchTransactions()`) y crear un Application Service (`executeApplyAllUseCase()`) que orqueste el caso de uso completo de Apply All POST, garantizando que las métricas de divergencia de Shadow sólo se persistan después de un commit exitoso de la transacción Prisma.

## Invariante Fundamental

S7-05A es un refactor arquitectónico del **flujo Apply All POST**. No altera el comportamiento observable del sistema bajo ninguna condición:

- `matchTransactions()` permanece **intacta**: misma firma, mismo `MatchResult`, mismo comportamiento. Ningún consumidor existente (Preview, tests) se modifica.
- `executeApplyAll()` permanece **intacta**: sin renombrar, sin cambios en su firma ni lógica.
- Preview (`GET /api/bank-rules/apply-all/preview`) sigue usando `matchTransactions()` sin cambios.
- `matchTransactionsWithShadow()` es nueva y usa el **mismo núcleo interno** de matching — nunca duplica el loop ni recalcula.
- Shadow se calcula **durante la misma iteración** del matching, no después. No existe recomputación posterior.
- La persistencia best-effort ocurre **exclusivamente después** de que `db.$transaction()` retorna exitosamente.
- `ApplyResult` permanece intacto (incluyendo `journalEntryCount`).
- `persistShadowSummaryBestEffort()` sigue siendo best-effort y devolviendo `Promise<void>`.
- No se agrega `shadowPersisted` a ningún tipo público.

## Scope

### Incluye

- Creación de núcleo interno `executeMatching()` con `MatchingMode` tipado (sin booleanos posicionales).
- `matchTransactions()` como wrapper público sobre el núcleo con shadow deshabilitado.
- `matchTransactionsWithShadow()` como nuevo wrapper público sobre el mismo núcleo con shadow habilitado.
- `MatchTransactionsWithShadowResult` como unión discriminada única (`kind: 'without-shadow' | 'with-shadow'`).
- `ShadowCollectionResult` como contrato público del shadow.
- Eliminación completa de `collectApplyAllShadowMetrics()`.
- Creación de `executeApplyAllUseCase()` como Application Service en archivo nuevo.
- Reemplazo del cuerpo del POST route por llamada al nuevo use case.
- Migración de tests existentes que afirmaban persistencia desde `matchTransactions()`.
- Tests nuevos para el use case: persistencia post-commit, no persistencia en rollback, no persistencia en early return, best-effort no afecta resultado productivo.
- Documentación de la semántica de early return: "No existe ejecución productiva de Apply All".

### Excluye

- Cambios en `matchTransactions()`, su firma o `MatchResult`.
- Cambios en `executeApplyAll()`, su firma o su lógica.
- Renombrados de funciones existentes.
- Cambios en Preview.
- Cambios en Import.
- Cambios en el schema de Prisma.
- `shadowPersisted: boolean` en `ApplyAllUseCaseResult`.
- Refactor de otros casos de uso.
- Tasks de implementación.

## Arquitectura

### Núcleo interno único

Existe un único núcleo de matching no exportado dentro de `apply-all-engine.ts`. Todas las superficies públicas son wrappers delgados sobre él.

```typescript
// No exportado — configuración de ejecución
type MatchingMode =
  | { shadow: 'disabled' }
  | { shadow: 'collect' };

// Exportado — contrato público del shadow (lo que recibe el Application Service)
export interface ShadowCollectionResult {
  summary: ShadowPersistencePayload;
  batchId: string;
}

// Exportado — único tipo discriminado del resultado de matching + shadow
// kind representa el resultado EFECTIVO de la ejecución, no la intención del caller.
// El caller puede pedir shadow: 'collect' pero recibir kind: 'without-shadow' si
// el flag está OFF, el Adapter está ON, o no hubo transacciones evaluadas.
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

// No exportado — núcleo interno del matching
// Acumula ShadowExecutionSummary durante el loop (concepto de dominio,
// sin batchId ni ShadowPersistencePayload que son de infraestructura).
// El wrapper matchTransactionsWithShadow() convierte el summary a
// ShadowCollectionResult y genera el batchId.
// No exportado — resultado interno del núcleo de matching
interface ExecuteMatchingResult {
  matchResult: MatchResult;
  shadowSummary?: ShadowExecutionSummary;
}

async function executeMatching(
  companyId: string,
  mode: MatchingMode,
  options?: MatchOptions,
): Promise<ExecuteMatchingResult>
```

`executeMatching()`:
1. Carga reglas, transacciones, contextos (una sola vez).
2. Ejecuta el loop de matching con `resolveApplyAllRule()`.
3. Si `mode.shadow === 'collect'` y las condiciones de flag lo permiten, acumula `ShadowExecutionSummary` durante el mismo loop (misma iteración, mismas reglas, mismas transacciones). No conoce `batchId`, `ShadowPersistencePayload` ni `ShadowCollectionResult`.
4. Retorna `{ matchResult, shadowSummary }` — `shadowSummary` es `undefined` si shadow no se ejecutó.

El modo `collect` no garantiza shadow en el resultado — los flags efectivos se evalúan durante la ejecución. Si `RULE_PRECEDENCE_SHADOW_ENABLED=false`, `RULE_ENGINE_ADAPTER_ENABLED=true`, o no hay transacciones evaluadas, `shadowSummary` es `undefined`.

### matchTransactionsWithShadow() — wrapper público

Convierte el resultado del núcleo interno (que trabaja con `ShadowExecutionSummary`) al contrato público `MatchTransactionsWithShadowResult` (que usa `ShadowCollectionResult`):

```
executeMatching(companyId, { shadow: 'collect' }, options)
        ↓
   shadowSummary undefined? → { kind: 'without-shadow', matchResult }
        ↓
   shadowSummary definido? →
     batchId = apply-all-${crypto.randomUUID()}
     summary = toPersistencePayload(shadowSummary)
     { kind: 'with-shadow', matchResult, shadow: { summary, batchId } }
```

No persiste. Nunca abre transacciones Prisma. Es completamente determinista desde el punto de vista del caller (el único no determinismo es el `batchId` UUID, que es puramente decorativo).

### Superficies públicas

```typescript
// apply-all-engine.ts — pública, sin cambios
export async function matchTransactions(
  companyId: string,
  options?: MatchOptions,
): Promise<MatchResult>

// apply-all-engine.ts — pública, nueva
export async function matchTransactionsWithShadow(
  companyId: string,
  options?: MatchOptions,
): Promise<MatchTransactionsWithShadowResult>
```

### Secuencia del Application Service

```
matchTransactionsWithShadow(companyId, { limit: 200 })
  └─ executeMatching(companyId, { shadow: 'collect' }, { limit: 200 })
       └─ Único loop: matching + shadow accumulation (si aplica)
  └─ RETURN: MatchTransactionsWithShadowResult

       ↓

¿early return?
  └─ matchedRules.length === 0 || totalCount === 0
       └─ SÍ → return { matchResult, applyResult: zero }
       └─ 「No existe ejecución productiva de Apply All.」
            El caso de uso comenzó y realizó matching, pero no hubo
            ejecución productiva. No se abre transacción ni se persiste.
       └─ NO → continuar

       ↓

db.$transaction(async (tx) => executeApplyAll(companyId, tx, matchResult))

       ↓

¿Commit exitoso?
  └─ SÍ → continuar
  └─ NO → la excepción se propaga (rollback). Sin persistencia.

       ↓

¿MatchTransactionsWithShadowResult.kind === 'with-shadow'?
  └─ SÍ → persistShadowSummaryBestEffort({
           companyId,
           entity: 'ApplyAllBatch',
           entityId: shadow.batchId,
           summary: shadow.summary,
         })
         └─ Best-effort: error capturado, no afecta el return
  └─ NO → no hay persistencia

       ↓

Return { matchResult, applyResult }
```

### Reglas de persistencia

1. **Sólo después de commit exitoso**: `persistShadowSummaryBestEffort()` ocurre después de que `db.$transaction()` resuelve.
2. **Early return**: si `matchedRules.length === 0 || totalCount === 0`, el use case retorna sin abrir transacción ni persistir. No existe ejecución productiva de Apply All.
3. **Shadow condicional**: si Shadow está OFF, o Adapter está ON, o no hubo transacciones evaluadas, `kind` es `'without-shadow'` — no hay persistencia. Son tres causas distintas que producen el mismo resultado efectivo.
4. **Best-effort**: si `persistShadowSummaryBestEffort()` falla, el error se captura y el resultado productivo no se afecta.

### matchTransactions() — ahora sin shadow

```
consulta (reglas, transacciones, contextos)
        ↓
executeMatching({ shadow: 'disabled' })
        ↓
return matchResult
```

Sin shadow. Sin flag checks. Sin acumulación. Sin persistencia.

### Ubicación de archivos

| Archivo | Rol |
|---|---|
| `src/lib/services/apply-all-engine.ts` | `executeMatching()` interno (sólo conoce `ShadowExecutionSummary`), `matchTransactions()` wrapper puro, `matchTransactionsWithShadow()` wrapper que arma `ShadowCollectionResult`, `executeApplyAll()` intacto. `MatchingMode` interno, no exportado. |
| `src/lib/services/apply-all-use-case.ts` **(NUEVO)** | `executeApplyAllUseCase()`, `ApplyAllUseCaseResult` |
| `src/app/api/bank-rules/apply-all/route.ts` | Controller — delega en el use case |
| `tests/unit/apply-all-engine-shadow.test.ts` | Tests de matching productivo se mantienen; tests de persistencia migran |
| `tests/unit/apply-all-use-case.test.ts` **(NUEVO)** | Tests del use case |

## Acceptance Criteria

1. **`matchTransactions()` sin cambios**: misma firma, mismo `MatchResult`, mismo comportamiento. Preview funciona sin modificaciones.
2. **Shadow se calcula en la misma iteración**: `executeMatching()` ejecuta un único loop que produce tanto el `MatchResult` como el `ShadowExecutionSummary`. No existe `collectApplyAllShadowMetrics()` ni ninguna función que recalcule shadow post-matching.
3. **`matchTransactionsWithShadow()` no persiste**: acumula shadow y convierte `ShadowExecutionSummary` a `ShadowCollectionResult`, pero nunca llama a `persistShadowSummaryBestEffort()`. Nunca abre transacciones Prisma. Nunca realiza escritura. Es completamente determinista desde el punto de vista del caller.
4. **Preview sin cambios**: usa `matchTransactions()` idéntico. No importa ni ejecuta el nuevo Application Service.
5. **Post-commit persistence**: después de que `db.$transaction()` resuelve, se invoca `persistShadowSummaryBestEffort()` si `kind === 'with-shadow'`.
6. **Rollback sin persistencia**: si `executeApplyAll()` o la transacción lanzan una excepción, `persistShadowSummaryBestEffort()` no debe ser invocada.
7. **Early return sin persistencia**: si `matchedRules.length === 0 || totalCount === 0`, el caso de uso retorna sin transacción ni persistencia. No existe ejecución productiva de Apply All.
8. **Best-effort no contamina**: si `persistShadowSummaryBestEffort()` falla, el error se captura y el resultado productivo es idéntico.
9. **Shadow OFF / Adapter ON / sin transacciones**: si Shadow está OFF, o Adapter está ON, o no hubo transacciones evaluadas, el resultado es `kind: 'without-shadow'` y no hay persistencia. Son tres causas distintas con el mismo resultado efectivo.
10. **`ApplyAllUseCaseResult` sin `shadowPersisted`**: sólo expone `matchResult` y `applyResult`.
11. **Sin regresiones**: todos los tests existentes de `matchTransactions()` pasan sin modificaciones en su lógica de aserción productiva.

## Cambios de archivos

| Archivo | Cambio |
|---|---|
| `src/lib/services/apply-all-engine.ts` | Agregar `MatchingMode` (interno, no exportado), `ShadowCollectionResult` (público), `MatchTransactionsWithShadowResult` (público único), `executeMatching()` interno (retorna `{ matchResult, shadowSummary?: ShadowExecutionSummary }` — sin `batchId` ni `ShadowPersistencePayload`). `matchTransactions()` delega en `executeMatching()` con shadow disabled. Agregar `matchTransactionsWithShadow()` que llama a `executeMatching()`, convierte `ShadowExecutionSummary` a `ShadowCollectionResult` y genera `batchId`. Remover imports de persistencia (`persistShadowSummaryBestEffort`) y toda lógica de persistencia del cuerpo de matching. `MatchResult`, `executeApplyAll()` y `ApplyResult` sin cambios. |
| `src/lib/services/apply-all-use-case.ts` | Crear. Implementar `executeApplyAllUseCase()`. `ApplyAllUseCaseResult { matchResult: MatchResult; applyResult: ApplyResult }`. |
| `src/app/api/bank-rules/apply-all/route.ts` | Reemplazar lógica inline por `executeApplyAllUseCase()`. Construir respuesta desde `ApplyAllUseCaseResult`. Mantener `requireCompanyContext()`, i18n, warning, rulesApplied, códigos de error en el controller. |
| `tests/unit/apply-all-engine-shadow.test.ts` | Tests de matching productivo se mantienen (Shadow OFF, winnerMap, matchedRules). Test de `persistShadowSummaryBestEffort` desde `matchTransactions` se migra a `apply-all-use-case.test.ts`. |
| `tests/unit/apply-all-use-case.test.ts` | Nuevo. Tests de: persistencia post-commit, no persistencia en rollback, no persistencia en early return, best-effort no contamina, shadow OFF no persiste, adapter ON no persiste, misma ejecución (shadow calculado durante matching). |
