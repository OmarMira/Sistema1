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

## Scope

### Incluye

- Shadow Mode en el flujo Apply All (hoy solo existe en Import).
- Comparación por transacción entre el winner legacy y el winner canónico.
- Clasificación del motivo de divergencia con evidencia del ranking.
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
  if (shadowEnabled):
    canonicalRules = rules.map(toRulePrecedenceRule)
    shadowResult = runApplyAllShadow(tx, canonicalRules, resolution.matchedRuleId, context)
    accumulateApplyAllShadowSummary(summary, shadowResult)
```

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

### Inmutabilidad del ranking canónico

El ranking devuelto por `evaluateTransactionAgainstRules()` (el array `candidates`) es **read-only** para la clasificación:

- No reordenarlo.
- No filtrarlo.
- No modificar scores.
- No eliminar candidatos.

La clasificación observa el ranking; no lo transforma.

### Clasificación de motivos de divergencia

La clasificación separa dos conceptos:

1. **Comparación** — hecho observado: `SAME` o `DIFFERENT`.
2. **Explicación** — causa identificada con evidencia: `NO_MATCH`, `AMBIGUOUS`, `SPECIFICITY`, `MATCH_QUALITY`, `DB_PRIORITY`, `ROLE_PRIORITY`, `UNDETERMINED`, `OTHER`.

No toda divergencia (`DIFFERENT`) tiene una explicación única. Cuando la evidencia no alcanza para identificar una causa unívoca, se clasifica como `UNDETERMINED`.

### Comparación

| Comparación | Condición |
|---|---|
| `SAME` | Legacy winner ID === Canonical winner ID, o ambos nulos |
| `DIFFERENT` | Legacy winner ID !== Canonical winner ID, o uno nulo y el otro no |

### Explicación (motivo)

#### `NO_MATCH`

**Cuándo se asigna:** El motor legacy encontró un winner (`matchedRuleId !== null`) pero el canónico no encontró ningún candidato (`reason === 'NO_MATCH'`).

**Evidencia requerida:**
- Legacy: `matchedRuleId` no nulo.
- Canónico: `candidates.length === 0`.

#### `AMBIGUOUS`

**Cuándo se asigna:** El motor legacy encontró un winner pero el canónico reporta `reason === 'AMBIGUOUS'` (dos o más candidatos empatados en specificity, match quality cercana, y mismo priority).

**Evidencia requerida:**
- Canónico: `ambiguous === true`, `reason === 'AMBIGUOUS'`.
- Top 2 candidatos del canónico disponibles para inspección.

#### `SPECIFICITY`

**Cuándo se asigna:** Ambos motores encontraron winner, los winners son distintos, y la divergencia se explica porque el canónico eligió un candidato con mayor `specificityScore` que el ganador legacy.

**Evidencia requerida:**
- Legacy winner ID ≠ Canonical winner ID.
- El candidato canónico ganador tiene `specificityScore` estrictamente mayor que el candidato legacy dentro del ranking canónico.
- Si el legacy winner no está en el ranking canónico, se asigna `UNDETERMINED` (la regla no pasó el filtro canónico).

#### `MATCH_QUALITY`

**Cuándo se asigna:** Ambos motores encontraron winner, los winners son distintos, la `specificityScore` del top 1 y top 2 canónicos es idéntica, y la divergencia se explica porque el canónico eligió por mejor `matchQuality`.

**Evidencia requerida:**
- Legacy winner ID ≠ Canonical winner ID.
- `specificityScore` del top 1 y top 2 canónicos son iguales.
- `matchQuality` del top 1 es mayor que la del top 2.
- `priority` de ambos candidatos es la misma (de lo contrario sería `DB_PRIORITY`).

#### `DB_PRIORITY`

**Cuándo se asigna:** Ambos motores encontraron winner, los winners son distintos, `specificityScore` y `matchQuality` del top 1 y top 2 canónicos son iguales (o no aplican por ser el mismo candidato), y la divergencia se explica porque el canónico eligió por `priority ASC` (DB priority) mientras que el legacy eligió por otro criterio.

**Evidencia requerida:**
- Legacy winner ID ≠ Canonical winner ID.
- `specificityScore` y `matchQuality` del top 1 y top 2 canónicos son iguales.
- `priority` del top 1 es menor (más prioritaria) que la del top 2.
- El legacy winner NO está en el top 2 del ranking canónico, o está pero con `priority` mayor.

#### `ROLE_PRIORITY`

**Cuándo se asigna:** El legacy winner y el canonical winner son distintos, y la divergencia se explica porque el legacy eligió por `rolePriority ASC` (desempate por rol de entidad) mientras que el canónico no tiene ese concepto.

**Evidencia requerida (estricta):**
- Legacy winner ID ≠ Canonical winner ID.
- El legacy winner NO está en el top 2 del ranking canónico, O está pero perdió por `specificityScore` o `matchQuality` (no por `priority`).
- El legacy winner ganó en el motor legacy por tener `rolePriority` menor que otros candidatos legacy.
- Se debe demostrar que el legacy NO habría ganado por DB priority únicamente: si el legacy winner tiene `rolePriority === 999` (default, sin rol) y ganó solo por `dbPriority`, se clasifica como `DB_PRIORITY`, no `ROLE_PRIORITY`.

**Regla estricta:** `ROLE_PRIORITY` solo se asigna cuando pueda demostrarse que el legacy ganó por ese desempate y no por otra señal anterior. Si el legacy winner tiene `rolePriority === 999` (default, sin matching de rol), se clasifica como `DB_PRIORITY` aunque el campo técnico sea `rolePriority`.

#### `OTHER`

**Cuándo se asigna:** Casos realmente excepcionales donde la divergencia no encaja en ninguna categoría anterior. Incluye:
- El legacy winner no aparece en el ranking canónico (no pasó el direction filter o las condiciones del canónico).
- Casos donde la regla legacy no existe en el conjunto canónico.

#### `UNDETERMINED`

**Cuándo se asigna:** La evidencia disponible no alcanza para identificar una causa unívoca de la divergencia. Incluye:
- El legacy winner está en el ranking canónico pero no es posible determinar por qué ganó en legacy vs canónico.
- `ROLE_PRIORITY` no puede confirmarse porque no hay evidencia directa del desempate legacy (el canónico no conoce `rolePriority`).
- Cualquier divergencia `DIFFERENT` donde la evidencia del ranking canónico no sea suficiente para atribuir una causa específica.

**Regla:** `ROLE_PRIORITY` nunca se infiere desde el ranking canónico. Solo puede asignarse cuando exista evidencia directa del proceso de desempate legacy. Si esa evidencia no está disponible, la clasificación se degrada a `UNDETERMINED`.

### Persistencia de métricas

Se reutiliza el mismo mecanismo que Import: acumulación de un summary durante el batch, y persistencia best-effort vía `createAuditLogWithRetry` con action `RULE_PRECEDENCE_SHADOW_SUMMARY` al finalizar.

**Restricciones de datos (misma disciplina que S7-03):**
- Nunca persistir descripción bancaria, montos, número de cuenta, texto completo de condiciones ni rankings completos.
- Solo contadores agregados y motivos de divergencia.
- No se persiste información por transacción individual — solo el summary del batch.

El summary de Apply All incluye los mismos contadores que `ShadowImportSummary` más un desglose por motivo de divergencia:

```typescript
interface ApplyAllShadowSummary {
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
    SPECIFICITY: number;
    MATCH_QUALITY: number;
    DB_PRIORITY: number;
    ROLE_PRIORITY: number;
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
4. **Clasificación de motivos:** Cada divergencia se clasifica en dos niveles: comparación (`SAME`/`DIFFERENT`) y explicación (`NO_MATCH`, `AMBIGUOUS`, `SPECIFICITY`, `MATCH_QUALITY`, `DB_PRIORITY`, `ROLE_PRIORITY`, `UNDETERMINED`, `OTHER`).
5. **Persistencia:** Al finalizar `matchTransactions()`, el summary acumulado se persiste best-effort vía AuditLog.
6. **Sin cambios productivos:** `matchedRuleId`, `resolvedRule`, `winnerMap`, transacciones, journal entries, y respuesta HTTP son idénticos antes y después de S7-04C.
7. **Sin regresiones:** Todos los tests existentes pasan sin modificaciones.

## Cambios de archivos

| Archivo | Cambio |
|---------|--------|
| `src/lib/services/rule-precedence-shadow.ts` | Agregar tipos `DivergenceReason`, `ApplyAllShadowSummary`; agregar `classifyDivergenceReason()`; agregar `accumulateApplyAllShadowSummary()` |
| `src/lib/services/apply-all-engine.ts` | Inyectar shadow comparison después de `resolveApplyAllRule()` en el loop de `matchTransactions()`, flaggeado por `RULE_PRECEDENCE_SHADOW_ENABLED` |
| `tests/unit/rule-precedence-shadow.test.ts` | Tests de `classifyDivergenceReason()` y `accumulateApplyAllShadowSummary()` |

## Dependencias

- S7-04B (completado): dispatcher `resolveApplyAllRule` integrado en `apply-all-engine.ts`.
- Shadow mode existente (`rule-precedence-shadow.ts`): tipos, `compareRuleDecisions`, `runShadowComparison`, `accumulateShadowSummary`, `persistShadowSummaryBestEffort`.
- Ningún cambio en S7-04A, S7-04B, ni en fases anteriores.
