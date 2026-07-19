# S7-04C: Functional Divergence Evaluation — Apply All Shadow Mode

## Objective

Medir divergencias funcionales de Apply All entre el motor legacy y el canónico sin modificar el comportamiento productivo.

## Invariante Fundamental

S7-04C es una fase de **observación y medición**. No altera el comportamiento observable del sistema bajo ninguna condición:

- El flujo productivo de Apply All sigue usando exclusivamente el motor legacy.
- Shadow compara legacy contra canónico sin afectar el resultado productivo.
- No se modifica `matchedRuleId`, `resolvedRule`, `winnerMap`, transacciones ni journal entries.
- Cualquier error de Shadow debe ser best-effort y nunca propagarse al flujo productivo.
- Role priority queda congelado: ni se porta al canónico ni se elimina del legacy.
- No se toca direction filtering (ya es equivalente en ambos motores).
- No se toca GL account resolution.
- No se agregan flags nuevas — se reutiliza `RULE_PRECEDENCE_SHADOW_ENABLED`.
- Shadow solo se ejecuta cuando el adapter flag está OFF (`!isRuleEngineAdapterEnabled()`). Si el adapter está ON, el resultado productivo ya viene del canónico y la comparación sería canónico vs canónico (métrica inútil).

## Scope

### Incluye

- Shadow Mode en el flujo Apply All (hoy solo existe en Import).
- Comparación por transacción entre el winner legacy y el winner canónico.
- Clasificación del motivo de divergencia limitada a motivos físicamente medibles desde `ShadowComparisonResult`.
- Persistencia agregada de métricas de divergencia por lote (vía AuditLog).
- Tests unitarios de la comparación, clasificación y acumulación.

### Excluye

- Portar role priority al motor canónico.
- Eliminar role priority del motor legacy.
- Direction filtering (ya es equivalente en ambos motores).
- Centralizar GL account resolution.
- Flags nuevas (se reutiliza `RULE_PRECEDENCE_SHADOW_ENABLED`).
- Modificaciones a `matchedRuleId`, `resolvedRule`, `winnerMap`, transacciones, journal entries.
- Cambios en el motor canónico (`evaluateTransactionAgainstRules` o `RuleMatchOutput`).
- Cambios en el motor legacy (`evaluateWinningRule` o `transactionMatchesRule`).
- Cambios en el dispatcher (`resolveApplyAllRule`).
- Cambios en Preview, Import, Recon, o Single Apply.
- Prisma schema, migraciones, UI.

## Arquitectura

### Inyección de Shadow en Apply All

El shadow mode existente en Import (`runShadowComparison` en `rule-precedence-shadow.ts`) se reutiliza como base. La inyección en Apply All sigue el mismo patrón:

```
matchTransactions() loop:
  resolution = resolveApplyAllRule(tx, rules, companyId, legacyCtx)  // productivo, siempre legacy
  if (shadowEnabled && !isRuleEngineAdapterEnabled()):
    shadowRules = rules.map(toRulePrecedenceRule)  // una vez antes del loop
    shadowResult = runShadowComparison(txData, shadowRules, resolution.matchedRuleId, context)
    classification = classifyDivergenceReason(evidence)
    accumulateApplyAllShadowSummary(summary, shadowResult, classification)
```

**Condición exacta:** Shadow Apply All solo se ejecuta cuando el adapter flag está OFF. Si `RULE_ENGINE_ADAPTER_ENABLED=true`, el resultado productivo ya viene del canónico y la comparación sería canónico vs canónico (métrica inútil). `shadowRules` se construye una vez fuera del loop. `batchId` se genera una sola vez con `crypto.randomUUID()`.

El shadow se ejecuta **después** de la resolución productiva, dentro del mismo loop, sin alterar el flujo. Los errores de shadow se capturan y no se propagan.

### Secuencia de procesamiento

El orden de las operaciones está definido y no debe alterarse:

```
resolver legacy (productivo)
        ↓
shadow (ejecuta canónico, compara)
        ↓
comparación (SAME / DIFFERENT)
        ↓
clasificación (asigna motivo)
        ↓
acumulación en summary
        ↓
persistencia (best-effort, al final del batch)
```

La clasificación nunca ocurre después de la persistencia ni depende de ella. Si mañana cambia el storage (AuditLog, archivo, métricas, Prometheus), la clasificación sigue siendo exactamente la misma.

### Función pura de clasificación

`classifyDivergenceReason()` debe ser una **función pura**:

- No escribe AuditLog.
- No consulta Prisma.
- No lee feature flags.
- No hace logging.
- No modifica ningún objeto.

Su única responsabilidad:

```
ComparisonEvidence → DivergenceClassification
```

Esto la hace trivial de testear y mantiene la clasificación aislada de efectos secundarios.

### Clasificación de divergencia

`classifyDivergenceReason()` es una **función pura** que solo interpreta los campos que `ShadowComparisonResult` ya expone. No accede al ranking canónico ni a información del motor legacy.

Separa dos conceptos:

1. **Comparación** — hecho observado: `SAME` o `DIFFERENT`.
2. **Explicación** — causa identificada con evidencia: `NO_MATCH`, `AMBIGUOUS`, `UNDETERMINED`, `OTHER`.

Cuando la evidencia disponible no alcanza para una causa unívoca, se clasifica como `UNDETERMINED`. Motivos como `SPECIFICITY`, `MATCH_QUALITY`, `DB_PRIORITY` o `ROLE_PRIORITY` requieren evidencia del ranking canónico que esta fase no produce — se agregarán en una fase futura cuando exista un productor real de esa evidencia.

### Reglas de clasificación (en orden de precedencia)

| # | Condición | Comparación | Motivo |
|---|---|---|---|
| 1 | `canonicalReason === 'NO_MATCH'` y `productiveWinnerId !== null` | `DIFFERENT` | `NO_MATCH` |
| 2 | `canonicalReason === 'AMBIGUOUS'` | `DIFFERENT` | `AMBIGUOUS` |
| 3 | `productiveWinnerId === null` y `canonicalWinnerId !== null` | `DIFFERENT` | `OTHER` |
| 4 | `productiveWinnerId === canonicalWinnerId` (o ambos nulos) | `SAME` | `null` |
| 5 | `productiveWinnerId !== canonicalWinnerId` (default) | `DIFFERENT` | `UNDETERMINED` |

#### `NO_MATCH`

**Cuándo se asigna:** El motor legacy encontró un winner (`matchedRuleId !== null`) pero el canónico no encontró ningún candidato.

#### `AMBIGUOUS`

**Cuándo se asigna:** El motor legacy encontró un winner pero el canónico reporta ambigüedad (dos o más candidatos empatados).

#### `OTHER`

**Cuándo se asigna:** Casos residuales donde el legacy no encontró winner pero el canónico sí.

#### `UNDETERMINED`

**Cuándo se asigna:** Casos `DIFFERENT` donde ambos motores tienen winners distintos y no hay evidencia adicional para clasificar la causa.

### Persistencia de métricas

Se reutiliza el mismo mecanismo que Import: acumulación de un summary durante el batch, y persistencia best-effort vía `createAuditLogWithRetry` con action `RULE_PRECEDENCE_SHADOW_SUMMARY` al finalizar.

**Restricciones de datos (misma disciplina que S7-03):**
- Nunca persistir descripción bancaria, montos, número de cuenta, texto completo de condiciones ni rankings completos.
- Solo contadores agregados y motivos de divergencia.
- No se persiste información por transacción individual — solo el summary del batch.

El summary de Apply All se modela en dos tipos: `ShadowExecutionSummary` (acumulación interna) y `ShadowPersistencePayload` (lo que se persiste, que excluye campos agregados intermedios):

```typescript
interface ShadowExecutionSummary {
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

interface ShadowPersistencePayload {
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

### Feature flag

`RULE_PRECEDENCE_SHADOW_ENABLED` — misma env var que Import. Default OFF.

El flag controla si `matchTransactions()` ejecuta shadow comparison después de la resolución productiva. Cuando está OFF, no hay overhead de shadow.

## Acceptance Criteria

1. **Flag OFF:** `matchTransactions()` ejecuta exactamente el mismo código que antes de S7-04C. Sin overhead de shadow.
2. **Flag ON:** Después de cada `resolveApplyAllRule()`, se ejecuta shadow comparison entre el winner legacy y el canónico.
3. **Shadow errors:** Cualquier error en shadow se captura, se loguea, y no interrumpe el loop de Apply All.
4. **Clasificación de motivos:** Cada divergencia se clasifica en dos niveles: comparación (`SAME`/`DIFFERENT`) y explicación (`NO_MATCH`, `AMBIGUOUS`, `UNDETERMINED`, `OTHER`).
5. **Persistencia:** Al finalizar `matchTransactions()`, el summary acumulado se persiste best-effort vía AuditLog.
6. **Sin cambios productivos:** `matchedRuleId`, `resolvedRule`, `winnerMap`, transacciones, journal entries, y respuesta HTTP son idénticos antes y después de S7-04C.
7. **Sin regresiones:** Todos los tests existentes pasan sin modificaciones.

## Cambios de archivos

| Archivo | Cambio |
|---------|--------|
| `src/lib/services/rule-precedence-shadow.ts` | Agregar tipos `DivergenceComparison`, `DivergenceReason`, `ComparisonEvidence`, `DivergenceClassification`, `ShadowExecutionSummary`, `ShadowPersistencePayload`, `PersistShadowParams`; agregar `classifyDivergenceReason()`, `createEmptyApplyAllShadowSummary()`, `accumulateApplyAllShadowSummary()`, `toPersistencePayload()`; refactorizar `persistShadowSummaryBestEffort` a unión discriminada |
| `src/lib/services/apply-all-engine.ts` | Inyectar shadow comparison después de `resolveApplyAllRule()` en el loop de `matchTransactions()`, flaggeado por `RULE_PRECEDENCE_SHADOW_ENABLED` y condicionado a `!isRuleEngineAdapterEnabled()` |
| `tests/unit/rule-precedence-shadow.test.ts` | Tests de `classifyDivergenceReason()`, `createEmptyApplyAllShadowSummary()`, `accumulateApplyAllShadowSummary()`, `toPersistencePayload()` |
| `tests/unit/apply-all-engine-shadow.test.ts` | Tests de integración de Apply All con Shadow ON/OFF/Adapter ON |

## Dependencias

- S7-04B (completado): dispatcher `resolveApplyAllRule` integrado en `apply-all-engine.ts`.
- Shadow mode existente (`rule-precedence-shadow.ts`): tipos, `compareRuleDecisions`, `runShadowComparison`, `accumulateShadowSummary`, `persistShadowSummaryBestEffort`.
- Ningún cambio en S7-04A, S7-04B, ni en fases anteriores.
