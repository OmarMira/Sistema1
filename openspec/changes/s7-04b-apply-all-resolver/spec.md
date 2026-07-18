# S7-04B: Apply All Rule Resolution Dispatcher

## Objective

Desacoplar el flujo Apply All del motor de reglas legacy, introduciendo un resolver con feature flag que enrute al motor canónico cuando el flag está activado, sin cambiar el comportamiento observable cuando el flag está desactivado.

## Invariante Fundamental (Flag OFF)

Para cualquier transacción procesada con `RULE_ENGINE_ADAPTER_ENABLED=false`, `resolveApplyAllRule()` debe producir exactamente el mismo resultado que el flujo legacy actual. Esto incluye:

- Mismo `matchedRuleId`.
- Misma estructura de datos de la regla ganadora (`id`, `name`, `priority`, campos de GL account).
- Misma cantidad de transacciones seleccionadas por `matchTransactions()`.
- Mismo winnerMap (agrupación de txIds por regla ganadora).
- Mismos journal entries generados por `executeApplyAll()`.
- Misma respuesta HTTP en los endpoints POST y GET preview.

No existe desviación permitida cuando el flag está desactivado. Cualquier diferencia es una regresión que debe corregirse antes de considerar la fase completa.

Cuando el flag está activado, las divergencias funcionales (posibles diferencias de winner o GL account por distinto scoring) quedan para evaluación en S7-04C, y el flag permanece desactivado por defecto.

## Scope

### Incluye

- `RuleResolution` base type compartido (adapters) — **NUEVO en S7-04B**
- Refactor de `ImportRuleResolution` para extender `RuleResolution`
- Ampliación de `AdapterRule` con `priority?: number` (adapters)
- `ApplyAllResolvedRule` type puente (adapters)
- `ApplyAllRuleResolution extends RuleResolution` type (adapters)
- `applyAllAdapter()` — **refactor** del existente en S7-04A, traducción pura del engine al contrato del flujo
- `rule-precedence-apply-all-resolver.ts` con dispatcher (2 caminos)
- Integración en `matchTransactions()` de `apply-all-engine.ts`
- `RULE_ENGINE_ADAPTER_ENABLED` flag (ya existe, misma variable que Import)
- Tests unitarios del adapter y del resolver

### Excluye

- Direction filtering en el motor canónico (S7-04C)
- Role priority scoring legacy (S7-04C)
- Shadow mode para Apply All (S7-04C)
- Cambios en `evaluateTransactionAgainstRules()` o `RuleMatchOutput`
- GL account resolution direction-aware — se mantiene en el flujo Apply All, no en el adapter (S7-04C si se decide centralizar)
- Cambios en Preview, Recon, Import, o Single Apply
- Prisma schema, migraciones, UI

## Arquitectura

### Interfaces (rule-precedence-adapters.ts)

```typescript
interface RuleResolution {
  matchedRuleId: string | null;
}
```

`ImportRuleResolution` se refactoriza para extender `RuleResolution`:
- `matchedRuleId: string | null` (heredado)
- `glAccountId: string | null` (se mantiene como estaba en S7-04A)

```typescript
interface ApplyAllResolvedRule {
  id: string;
  name: string;
  priority: number;
  glAccountId: string | null;
  debitGlAccountId: string | null;
  creditGlAccountId: string | null;
}

interface ApplyAllRuleResolution extends RuleResolution {
  resolvedRule: ApplyAllResolvedRule | null;
}
```

`RuleResolution` solo contiene `matchedRuleId`. La GL account NO se resuelve en el adapter — es responsabilidad del flujo Apply All decidir qué cuenta usar según la dirección de la transacción.

### AdapterRule (adapters)

Se amplía el tipo existente de S7-04A para soportar `applyAllAdapter()`:

```typescript
interface AdapterRule {
  id: string;
  name?: string;
  priority?: number;
  glAccountId?: string | null;
  debitGlAccountId?: string | null;
  creditGlAccountId?: string | null;
}
```

`name` y `priority` se mantienen opcionales por compatibilidad con `importAdapter()`. `applyAllAdapter()` solo produce `resolvedRule` cuando el winner tiene los campos requeridos; si faltan, retorna `resolvedRule: null`.

### `applyAllAdapter()` (adapters — refactor)

Recibe `RuleMatchOutput + AdapterRule[]`. Traduce el resultado del engine al contrato del flujo:

- Si hay winner y el lookup encuentra la regla: retorna `resolvedRule` con los datos (id, name, priority, glAccountId, debitGlAccountId, creditGlAccountId).
- Si no hay winner o la regla no se encuentra en el array: retorna `resolvedRule: null`.

NO decide qué GL account usar — solo expone los datos para que el flujo decida.

No se usa en legacy path — solo en adapter path.

### `resolveApplyAllRule()` (rule-precedence-apply-all-resolver.ts)

Dispatcher con dos caminos. Recibe el contexto de entidades necesario para el camino legacy:

```typescript
resolveApplyAllRule(txData, bankRules, entityContexts, companyId)

  RULE_ENGINE_ADAPTER_ENABLED = true
    → evaluateTransactionAgainstRules(canonicalRules)
    → applyAllAdapter(match, canonicalRules)
    → ApplyAllRuleResolution

  RULE_ENGINE_ADAPTER_ENABLED = false
    → transactionMatchesRule(tx, rules, entityContexts)
    → evaluateWinningRule(matchingRules, tx, entityContexts)
    → ApplyAllRuleResolution
```

Notas:
- No incluye camino V2 (Apply All nunca usó V2).
- El camino legacy recibe y conserva `entityContexts` para preservar exactamente el uso actual de entity-first y role priority.
- El camino adapter ignora `entityContexts` (el canónico tiene su propia lógica de entidades).

### Integración (apply-all-engine.ts)

`matchTransactions()` delegará la resolución de la regla ganadora al resolver, reemplazando la lógica actual de filtrado y selección. La estructura de `MatchResult` (matchedRules[]) no cambia — solo cambia cómo se determina qué regla gana para cada transacción.

El bloque `executeApplyAll()` (mutación dentro de tx) no se modifica.

### Flag

`RULE_ENGINE_ADAPTER_ENABLED` — misma env var que Import. Default OFF.

El flag NO controla si se usa el resolver o no (`matchTransactions()` usa el resolver siempre). El flag controla exclusivamente qué motor ejecuta el resolver internamente:

```
Flag OFF → resolver ejecuta legacy (transactionMatchesRule + evaluateWinningRule)
Flag ON  → resolver ejecuta canónico (evaluateTransactionAgainstRules + applyAllAdapter)
```

## Acceptance Criteria

1. **Flag OFF:** `resolveApplyAllRule()` produce salida idéntica al comportamiento actual en matchedRuleId, estructura de regla, transacciones seleccionadas, winnerMap, journal entries, y respuesta HTTP.
2. **Flag ON:** `resolveApplyAllRule()` ejecuta exclusivamente el motor canónico y `applyAllAdapter()`; no llama a `transactionMatchesRule()` ni a `evaluateWinningRule()`.
3. **Flag OFF:** Preview idéntico al comportamiento actual.
4. **Flag ON:** Preview usa el resultado canónico; divergencias funcionales quedan para S7-04C (flag OFF por defecto).
5. Ningún cambio observable en Import.
6. Ningún cambio observable en Recon.
7. Sin cambios en Prisma schema.
8. Sin migraciones de base de datos.
9. Sin cambios en la API (mismos endpoints, mismos contratos de respuesta).
10. Sin regresiones en tests existentes.
11. Tests nuevos: adapter direction-agnostic, resolver flag ON/OFF, verificación de invariante.

## Cambios de archivos

| Archivo | Cambio |
|---------|--------|
| `src/lib/services/rule-precedence-adapters.ts` | Agregar `RuleResolution` (nuevo), refactor `ImportRuleResolution` para extenderlo, ampliar `AdapterRule` con `priority?: number`, agregar `ApplyAllResolvedRule`, `ApplyAllRuleResolution`, refactor `applyAllAdapter()` |
| `src/lib/services/rule-precedence-apply-all-resolver.ts` | **NUEVO**: dispatcher con 2 caminos, recibe `entityContexts`, preserva legacy exacto |
| `src/lib/services/apply-all-engine.ts` | Reemplazar lógica de decisión de regla por `resolveApplyAllRule()` |
| `tests/unit/rule-precedence-adapters.test.ts` | Tests de `applyAllAdapter` refactorizado |
| `tests/unit/rule-precedence-apply-all-resolver.test.ts` | **NUEVO**: tests del dispatcher (flag ON/OFF, preservación de contextos) |

## Dependencias

- S7-04A (completado): `rule-precedence-adapters.ts` (adapter base, ImportRuleResolution, AdapterRule), flag `RULE_ENGINE_ADAPTER_ENABLED`
- `RuleResolution` es **NUEVO en S7-04B** (no existía en S7-04A)
- `applyAllAdapter()` fue creado en S7-04A y se **refactoriza** en S7-04B
- Compatibilidad total hacia atrás: flag OFF = mismo comportamiento que antes de S7-04B
