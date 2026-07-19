# S7-04C: Tasks — Apply All Shadow Mode

## Constraints globales (aplican a todas las tasks)

- `ROLE_PRIORITY` no se asigna en S7-04C. El motor legacy no expone evidencia directa del desempate. Toda divergencia potencial por role priority se registra como `UNDETERMINED`.
- Nunca persistir datos por transacción individual. Solo contadores agregados al final del batch.
- No modificar `resolvedRule`, `winnerMap`, `matchedRuleId`, transacciones ni journal entries.
- No agregar flags nuevas. Reutilizar `RULE_PRECEDENCE_SHADOW_ENABLED`.
- No modificar `evaluateTransactionAgainstRules()`, `evaluateWinningRule()`, `transactionMatchesRule()`, ni `resolveApplyAllRule()`.
- No modificar `ShadowComparison`, `ShadowComparisonResult`, ni `runShadowComparison()` (contrato compartido con S7-02/S7-03).
- `classifyDivergenceReason()` debe ser función pura: sin AuditLog, Prisma, flags, logging ni mutaciones.

---

## Task 1: Definir tipos de divergencia y clasificación

**Archivo:** `src/lib/services/rule-precedence-shadow.ts`

Agregar los tipos nuevos sin modificar los existentes (`ShadowComparison`, `ShadowComparisonResult`, `ShadowImportSummary` se mantienen intactos).

S7-04C solo define tipos para lo que puede medir físicamente. Motivos como `SPECIFICITY`, `MATCH_QUALITY`, `DB_PRIORITY` o `ROLE_PRIORITY` requieren evidencia del motor que esta fase no produce — se agregarán cuando exista un productor real.

```typescript
export type DivergenceComparison = 'SAME' | 'DIFFERENT';

export type DivergenceReason =
  | 'NO_MATCH'
  | 'AMBIGUOUS'
  | 'UNDETERMINED'
  | 'OTHER';

export interface ComparisonEvidence {
  productiveWinnerId: string | null;
  canonicalWinnerId: string | null;
  canonicalReason: 'NO_MATCH' | 'WINNER' | 'AMBIGUOUS';
}

export interface DivergenceClassification {
  comparison: DivergenceComparison;
  reason: DivergenceReason | null;
}
```

- `DivergenceComparison` es nuevo — no reemplaza `ShadowComparison`. El tipo existente de 6 valores se mantiene para Import.
- `DivergenceClassification.reason` es `DivergenceReason | null` — cuando no hay divergencia (`SAME`), no existe motivo.
- `ComparisonEvidence` solo contiene los campos que `ShadowComparisonResult` ya expone. No incluye `canonicalCandidates`, `LegacyTieBreakEvidence`, ni `CanonicalDecisionEvidence` porque ninguno tiene un productor real en S7-04C.

**Criterio de aceptación:**
- `ShadowComparison` (6 valores) sigue existiendo sin cambios.
- `DivergenceComparison` es nuevo: `'SAME' | 'DIFFERENT'`.
- `DivergenceReason` solo incluye `NO_MATCH`, `AMBIGUOUS`, `UNDETERMINED`, `OTHER`.
- `ComparisonEvidence` no incluye `legacyEvidence` ni `canonicalCandidates`.

---

## Task 2: Implementar `classifyDivergenceReason()` como función pura

**Archivo:** `src/lib/services/rule-precedence-shadow.ts`

```typescript
function classifyDivergenceReason(evidence: ComparisonEvidence): DivergenceClassification
```

**Reglas de clasificación (en orden de precedencia):**

El clasificador no deduce tiebreakers del ranking. Solo interpreta los campos que `ShadowComparisonResult` ya expone.

1. Si `canonicalReason === 'NO_MATCH'` y `productiveWinnerId !== null` → `{ comparison: 'DIFFERENT', reason: 'NO_MATCH' }`.
2. Si `canonicalReason === 'AMBIGUOUS'` → `{ comparison: 'DIFFERENT', reason: 'AMBIGUOUS' }`.
3. Si `productiveWinnerId === null` y `canonicalWinnerId !== null` → `{ comparison: 'DIFFERENT', reason: 'OTHER' }`.
4. Si `productiveWinnerId === canonicalWinnerId` (o ambos nulos) → `{ comparison: 'SAME', reason: null }`.
5. Si `productiveWinnerId !== canonicalWinnerId` (DIFFERENT con ambos winners presentes) → `{ comparison: 'DIFFERENT', reason: 'UNDETERMINED' }`.

**Restricciones:**
- Función pura: sin efectos secundarios, sin I/O, sin logging.

**Criterio de aceptación:**
- La función existe, es pura y exportable.
- Cada caso tiene cobertura en los tests.
- No hay llamadas a AuditLog, Prisma, flags, ni logger.

---

## Task 3: Implementar acumulación de `ShadowExecutionSummary` y `ShadowPersistencePayload`

**Archivo:** `src/lib/services/rule-precedence-shadow.ts`

Separar el modelo interno del modelo de persistencia:

```typescript
export interface ShadowExecutionSummary {
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

export interface ShadowPersistencePayload {
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

Implementar:

```typescript
function createEmptyApplyAllShadowSummary(): ShadowExecutionSummary
function accumulateApplyAllShadowSummary(
  summary: ShadowExecutionSummary,
  result: ShadowExecutionResult,
  classification?: DivergenceClassification,
): ShadowExecutionSummary
function toPersistencePayload(summary: ShadowExecutionSummary): ShadowPersistencePayload
```

- `accumulateApplyAllShadowSummary` recibe el classification de forma opcional porque los errores de shadow (`ok: false`) no tienen clasificación.
- Cuando `result.ok === false`, solo incrementa `shadowErrors` y `totalEvaluated`.
- Cuando `result.ok === true` y hay classification, incrementa el contador correspondiente según `comparison` y `reason`.

**Criterio de aceptación:**
- Los contadores se actualizan correctamente para cada combinación.
- Los errores de shadow solo incrementan `shadowErrors` y `totalEvaluated`.
- `divergenceReasons` solo incluye `NO_MATCH`, `AMBIGUOUS`, `UNDETERMINED`, `OTHER`.

---

## Task 4: Integrar shadow en `matchTransactions()`

**Archivo:** `src/lib/services/apply-all-engine.ts`

Modificar `matchTransactions()` para ejecutar shadow comparison después de cada `resolveApplyAllRule()`.

**Condición exacta:** Shadow Apply All solo se ejecuta cuando el adapter flag está OFF. Si `RULE_ENGINE_ADAPTER_ENABLED=true`, el resultado productivo ya viene del canónico y la comparación sería canónico vs canónico (métrica inútil).

**Contrato:** `runShadowComparison()` permanece sin cambios y devuelve el `ShadowExecutionResult` actual. `ShadowComparisonResult` no se modifica. `apply-all-engine.ts` construye localmente `ComparisonEvidence` usando únicamente los campos que `ShadowComparisonResult` ya expone. No existe una segunda comparación del motor ni lógica duplicada.

```typescript
const shadowEnabled = isRulePrecedenceShadowEnabled() && !isRuleEngineAdapterEnabled();

let shadowRules: RulePrecedenceRule[] | undefined;
let shadowSummary: ShadowExecutionSummary | undefined;
let batchId: string | undefined;

if (shadowEnabled) {
  shadowRules = rules.map(toRulePrecedenceRule);
  shadowSummary = createEmptyApplyAllShadowSummary();
  batchId = `apply-all-${crypto.randomUUID()}`;
}
```

Dentro del loop, después de `resolveApplyAllRule()`:

```typescript
if (shadowEnabled && shadowRules && shadowSummary) {
  const txData: RulePrecedenceTransaction = {
    id: tx.id,
    date: tx.date,
    description: tx.description,
    amount: Number(tx.amount),
    bankAccountId: bankAccountByStatement.get(tx.statementId),
  };

  // runShadowComparison no se modifica.
  // ShadowComparisonResult no se modifica.
  const shadowResult = runShadowComparison(
    txData,
    shadowRules,
    resolution.matchedRuleId,
    { companyId, transactionId: tx.id },
  );

  let classification: DivergenceClassification | undefined;

  if (shadowResult.ok) {
    // ComparisonEvidence se construye únicamente desde los
    // campos existentes de ShadowComparisonResult.
    const evidence: ComparisonEvidence = {
      productiveWinnerId: shadowResult.comparison.productiveWinnerId,
      canonicalWinnerId: shadowResult.comparison.canonicalWinnerId,
      canonicalReason: shadowResult.comparison.canonicalReason,
    };

    classification = classifyDivergenceReason(evidence);
  }

  shadowSummary = accumulateApplyAllShadowSummary(shadowSummary, shadowResult, classification);
}
```

**Restricciones:**
- El resultado productivo (`resolution`) no se modifica.
- `winnerMap`, `matchedRules`, `transactions` en el `MatchResult` son idénticos con shadow ON u OFF.
- Los errores de shadow se capturan y no interrumpen el loop.
- Shadow Apply All NO se ejecuta cuando `RULE_ENGINE_ADAPTER_ENABLED=true`.

**Criterio de aceptación:**
- Con flag OFF: `matchTransactions()` ejecuta exactamente el mismo código que antes.
- Con flag ON y adapter OFF: shadow se ejecuta después de cada `resolveApplyAllRule()`.
- Con flag ON y adapter ON: shadow NO se ejecuta, no hay comparación ni persistencia.
- El resultado de `matchTransactions()` es idéntico con shadow ON y OFF.

---

## Task 5: Persistir el summary al final del batch

**Archivo:** `src/lib/services/apply-all-engine.ts`

Al finalizar `matchTransactions()`, si shadow está habilitado y hay transacciones evaluadas, persistir el summary best-effort.

**Contrato definitivo:** Se usa `ApplyAllBatch` como entity y un `batchId` único generado por ejecución. No se reutiliza `statementId` ni `companyId`.

```typescript
if (shadowSummary && shadowSummary.totalEvaluated > 0 && batchId) {
  const payload = toPersistencePayload(shadowSummary);
  await persistShadowSummaryBestEffort({
    companyId,
    entity: 'ApplyAllBatch',
    entityId: batchId,
    summary: payload,
  });
}
```

El `batchId` se genera una sola vez por ejecución de `matchTransactions()` (ver Task 4). Usar `crypto.randomUUID()` como fuente de unicidad. No usar fecha/hora como único identificador.

**Modificación necesaria en infraestructura compartida:** `persistShadowSummaryBestEffort` actualmente recibe un parámetro `statementId` con semántica de `BankStatement`. Para soportar `ApplyAllBatch` sin contaminar auditorías, se modifica para aceptar `entity` y `entityId` como parámetros opcionales que reemplazan a `statementId` cuando están presentes:

```typescript
type PersistShadowParams =
  | {
      companyId: string;
      userId?: string;
      statementId: string;
      summary: ShadowPersistencePayload;
    }
  | {
      companyId: string;
      userId?: string;
      entity: 'ApplyAllBatch';
      entityId: string;
      summary: ShadowPersistencePayload;
    };
```

- Discriminated union: nunca pueden venir `statementId` y `entity` juntos.
- TypeScript impide estados inválidos en compilación.
- Sin comprobaciones defensivas dentro de la función.

**Restricciones:**
- Best-effort: si la persistencia falla, se loguea el error y no se interrumpe el flujo.
- Solo se persisten contadores agregados — nunca datos por transacción.
- Se persiste `ShadowPersistencePayload`, no `ShadowExecutionSummary`.
- `companyId` nunca se persiste como `statementId`.

**Criterio de aceptación:**
- Con shadow ON y adapter OFF, al finalizar `matchTransactions()` se persiste un AuditLog con action `RULE_PRECEDENCE_SHADOW_SUMMARY` y entity `ApplyAllBatch`.
- Con shadow ON y adapter ON, no hay persistencia.
- Si la persistencia falla, el error se loguea y no interrumpe el flujo.
- Sin shadow, no hay persistencia.
- Los registros existentes de Import (`statementId`) no se ven afectados.

---

## Task 6: Tests unitarios de clasificación y acumulación

**Archivo:** `tests/unit/rule-precedence-shadow.test.ts`

Agregar tests para:

**`classifyDivergenceReason()`:**
- Ambos winners nulos → `SAME`, `reason: null`.
- Mismo winner → `SAME`, `reason: null`.
- Legacy tiene winner, canónico no tiene candidatos → `DIFFERENT / NO_MATCH`.
- Canónico ambiguous → `DIFFERENT / AMBIGUOUS`.
- Legacy nulo, canónico tiene winner → `DIFFERENT / OTHER`.
- Distinto winner, sin evidencia adicional → `DIFFERENT / UNDETERMINED`.

**`accumulateApplyAllShadowSummary()`:**
- Acumulación de `SAME` incrementa `sameWinner`.
- Acumulación de `DIFFERENT / UNDETERMINED` incrementa `differentWinner` y `divergenceReasons.UNDETERMINED`.
- Error de shadow incrementa `shadowErrors` y `totalEvaluated`.
- Múltiples acumulaciones producen sumas correctas.
- `createEmptyApplyAllShadowSummary()` retorna todos los contadores en 0.

**`toPersistencePayload()`:**
- Transforma `ShadowExecutionSummary` → `ShadowPersistencePayload` preservando contadores.

**Criterio de aceptación:**
- Todos los tests pasan.
- Cobertura de todos los casos de clasificación.
- La función pura no tiene efectos secundarios verificables.

---

## Task 7: Test de integración de Apply All con shadow ON/OFF

**Archivo:** `tests/unit/apply-all-engine.test.ts` (o archivo existente de tests de Apply All)

Agregar tests de integración que:

1. **Shadow OFF:** Ejecuta `matchTransactions()` — captura el resultado productivo completo.
2. **Shadow ON + Adapter OFF:** Ejecuta `matchTransactions()` — verifica que el resultado productivo sea idéntico al paso 1.
3. **Shadow ON + Adapter ON:** Ejecuta `matchTransactions()` — verifica que shadow NO se ejecuta (sin AuditLog de summary).
4. Verifica que `winnerMap` sea idéntico entre las ejecuciones con shadow ON y OFF (invariante fuerte de S7-04B).
5. Verifica que con shadow ON + adapter OFF se haya persistido un AuditLog con action `RULE_PRECEDENCE_SHADOW_SUMMARY` y entity `ApplyAllBatch`.
6. Verifica que con shadow OFF o adapter ON no exista AuditLog de summary.

**Criterio de aceptación:**
- El resultado productivo (`matchedRules`, `transactions`, `totalAmount`, `totalCount`, `remaining`) es idéntico con shadow ON y OFF.
- `winnerMap` es idéntico con shadow ON y OFF.
- Shadow ON + Adapter ON: no hay comparación ni persistencia.
- Shadow ON + Adapter OFF: existe AuditLog con entity `ApplyAllBatch`.
- Shadow OFF: no existe AuditLog.

---

## Task 8: Verificación completa

Ejecutar el protocolo de validación completo:

1. `npx tsc --noEmit` — sin errores de tipo.
2. `npx vitest run` — todos los tests pasan (1499+ tests).
3. `npm run build` — build exitoso.
4. Revisión física de cada archivo modificado para confirmar:
   - No hay cambios en `resolvedRule`, `winnerMap`, `matchedRuleId`.
   - No hay cambios en `evaluateTransactionAgainstRules()`, `evaluateWinningRule()`, `transactionMatchesRule()`, `resolveApplyAllRule()`.
   - `ShadowComparison` y `ShadowComparisonResult` no se modificaron.
   - `classifyDivergenceReason()` es función pura.
   - Sin datos por transacción en la persistencia.
   - `companyId` no se usa como `statementId`.
5. `git diff --stat` para confirmar que solo se modificaron los archivos previstos.

**Criterio de aceptación:**
- Typecheck, tests y build exitosos.
- Revisión física confirma todas las restricciones.
- Sin regresiones.