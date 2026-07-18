# S7-04B: Tasks

## Task 1: Refactor tipos en rule-precedence-adapters.ts

### 1.1 Agregar `RuleResolution` base

```typescript
export interface RuleResolution {
  matchedRuleId: string | null;
}
```

### 1.2 Refactor `ImportRuleResolution`

Cambiar de:

```typescript
export interface ImportRuleResolution {
  matchedRuleId: string | null;
  glAccountId: string | null;
}
```

a:

```typescript
export interface ImportRuleResolution extends RuleResolution {
  glAccountId: string | null;
}
```

### 1.3 Extender `AdapterRule`

Agregar `priority?: number` al tipo existente:

```typescript
export interface AdapterRule {
  id: string;
  name?: string;
  priority?: number;
  glAccountId?: string | null;
  debitGlAccountId?: string | null;
  creditGlAccountId?: string | null;
}
```

### 1.4 Agregar tipos de Apply All

```typescript
export interface ApplyAllResolvedRule {
  id: string;
  name: string;
  priority: number;
  glAccountId: string | null;
  debitGlAccountId: string | null;
  creditGlAccountId: string | null;
}

export interface ApplyAllRuleResolution extends RuleResolution {
  resolvedRule: ApplyAllResolvedRule | null;
}
```

### 1.5 Refactor `applyAllAdapter()`

Cambiar la implementación actual (direction-aware) a una traducción pura:

- Si hay winner y el lookup encuentra la regla en `AdapterRule[]`: construir `ApplyAllResolvedRule` con id, name, priority, glAccountId, debitGlAccountId, creditGlAccountId.
- Si no hay winner o la regla no está en el array: retornar `{ matchedRuleId: match.winner?.ruleId ?? null, resolvedRule: null }`.
- No resolver GL account — solo exponer los datos crudos.
- El flujo Apply All decide qué cuenta usar según la dirección de la transacción.

### 1.6 Re-exportar tipos nuevos

Asegurar que `ApplyAllRuleResolution` y `ApplyAllResolvedRule` se exportan para el resolver.

### Archivos afectados

- `src/lib/services/rule-precedence-adapters.ts`

### Tests afectados

- `tests/unit/rule-precedence-adapters.test.ts`: actualizar tests de `applyAllAdapter` para reflejar que ya no resuelve GL account.

---

## Task 2: Crear rule-precedence-apply-all-resolver.ts

### Tipo de `entityContexts`

NO usar `unknown` ni `any`. Determinar el tipo exacto que `matchTransactions()` utiliza actualmente para los contextos de entidad y reutilizarlo directamente en el resolver. Si el tipo está definido localmente en `apply-all-engine.ts`, extraerlo a un tipo compartido o importarlo según corresponda.

### Tipo de `bankRules`

Reutilizar `RuleRecord` de `rule-precedence-import-resolver.ts`. No crear un tipo paralelo.

### Imports necesarios

- `applyAllAdapter`, `ApplyAllRuleResolution`, `ApplyAllResolvedRule`, `AdapterRule` de adapters
- `evaluateTransactionAgainstRules` del engine canónico
- `toRulePrecedenceRule` de shadow
- `transactionMatchesRule`, `evaluateWinningRule` de `rule-matching-engine`
- `isRuleEngineAdapterEnabled` de flag
- `RuleRecord` de import-resolver
- tipo de `entityContexts` (desde `apply-all-engine.ts` o según se determine)

### Dispatcher

```typescript
export interface ResolveApplyAllParams {
  id: string;
  date: Date;
  description: string;
  amount: number;
  bankAccountId: string;
  reference?: string;
}

export async function resolveApplyAllRule(
  txData: ResolveApplyAllParams,
  bankRules: RuleRecord[],
  entityContexts: /* tipo exacto de matchTransactions() */,
  companyId: string,
): Promise<ApplyAllRuleResolution>
```

### Camino legacy (flag OFF)

Reproducir exactamente el mismo algoritmo que hoy ejecuta `matchTransactions()`, recibiendo y usando `entityContexts` de forma idéntica:

```text
for each bankRule:
  if transactionMatchesRule(txData, rule, entityContexts):
    add to matchingRules[]

if matchingRules.length > 0:
  winner = evaluateWinningRule(matchingRules, txData, entityContexts)
  build ApplyAllResolvedRule from winner.rule
  return { matchedRuleId: winner.rule.id, resolvedRule }
else:
  return { matchedRuleId: null, resolvedRule: null }
```

### Camino adapter (flag ON)

```text
canonicalRules = bankRules.map(toRulePrecedenceRule)
match = evaluateTransactionAgainstRules(txData, canonicalRules)
return applyAllAdapter(match, canonicalRules)
```

### Archivos nuevos

- `src/lib/services/rule-precedence-apply-all-resolver.ts`

---

## Task 3: Integrar resolver en apply-all-engine.ts

### 3.1 Alcance del cambio

El refactor reemplaza **exclusivamente** el bloque donde se decide la regla ganadora dentro de `matchTransactions()`. NO modificar:

- Batching (cap de 200 transacciones, `maxApplyTransactions`)
- TOCTOU defense dentro de `executeApplyAll()`
- Creación de journal entries
- Manejo de transacciones de Prisma (`$transaction`)
- Límites o validaciones de negocio
- Consultas Prisma existentes
- Estructura de `MatchResult` ni `ApplyResult`

### 3.2 Cambio

En `matchTransactions()`, el bloque que itera sobre `unmatchedTransactions` y ejecuta `transactionMatchesRule` + `evaluateWinningRule` se reemplaza por una llamada a `resolveApplyAllRule()`.

```text
antes:
  for each transaction:
    filter rules via transactionMatchesRule(tx, rule, entityContexts)
    pick winner via evaluateWinningRule(matchingRules, tx, entityContexts)
    build matchedRules[]

después:
  for each transaction:
    resolution = await resolveApplyAllRule(txData, bankRules, entityContexts, companyId)
    if resolution.resolvedRule:
      group txId by resolution.resolvedRule.id
```

### 3.3 Preservar estructura de `MatchResult`

El `matchedRules[]` del `MatchResult` debe mantener exactamente la misma forma:

```typescript
matchedRules: Array<{
  rule: { id: string; name: string; priority: number | null };
  txIds: string[];
}>;
```

### 3.4 Import

Agregar import de `resolveApplyAllRule` desde el nuevo resolver.

### Archivos afectados

- `src/lib/services/apply-all-engine.ts`

---

## Task 4: Tests

### 4.1 Tests de adapter (`tests/unit/rule-precedence-adapters.test.ts`)

Actualizar tests de `applyAllAdapter`:

- Con winner y regla encontrada → `ApplyAllRuleResolution` con `resolvedRule` poblado
- Con winner pero regla no encontrada → `resolvedRule: null`
- Sin winner → `resolvedRule: null`
- Verificar que `resolvedRule` contiene todos los campos (id, name, priority, glAccountId, debitGlAccountId, creditGlAccountId)
- Verificar que NO resuelve GL account direction-aware

### 4.2 Tests del resolver (`tests/unit/rule-precedence-apply-all-resolver.test.ts`)

**Ruta legacy (flag OFF):**
- `transactionMatchesRule` es llamado con los mismos `entityContexts` que recibe hoy `matchTransactions()`
- `evaluateWinningRule` recibe las reglas matching y los mismos `entityContexts`
- Devuelve `ApplyAllRuleResolution` correcta
- No llama al canónico ni al adapter

**Ruta adapter (flag ON):**
- `evaluateTransactionAgainstRules` es llamado
- `applyAllAdapter` es llamado
- No llama a `transactionMatchesRule` ni `evaluateWinningRule`
- Devuelve `ApplyAllRuleResolution` correcta

### 4.3 Prueba de caracterización: winnerMap con flag OFF

**ANTES** de modificar `apply-all-engine.ts`, crear un fixture que capture el comportamiento legacy exacto.

Fixture debe incluir:

- Varias reglas coincidentes con prioridades distintas
- `entityContexts` (los mismos que usa `matchTransactions()` hoy)
- Transacciones débito y crédito
- Al menos una transacción sin match

Ejecutar `matchTransactions()` con esas entradas y registrar el resultado legacy como baseline:

```typescript
const legacyBaseline = {
  matchedRules: [
    { rule: { id: string; name: string; priority: number }, txIds: string[] },
  ],
  totalCount: number,
  remaining: number,
};
```

**DESPUÉS** de integrar el resolver (Task 3), ejecutar el mismo fixture con `RULE_ENGINE_ADAPTER_ENABLED=false` y comparar profundamente:

```typescript
expect(resultAfterRefactor.matchedRules).toEqual(legacyBaseline.matchedRules);
expect(resultAfterRefactor.totalCount).toBe(legacyBaseline.totalCount);
expect(resultAfterRefactor.remaining).toBe(legacyBaseline.remaining);
```

El baseline debe obtenerse y validarse **antes** del cambio, no escribirse a mano después. Esto evita reproducir en el test el mismo error introducido en el código.

---

## Orden de implementación sugerido

1. Task 1 — tipos y adapter (adapters.ts)
2. Task 4.1 — tests del adapter
3. Task 2 — resolver
4. Task 4.2 — tests del resolver
5. **Capturar baseline legacy** — ejecutar fixture y registrar resultado de `matchTransactions()` antes de modificarlo
6. Task 3 — integración del resolver en `apply-all-engine.ts`
7. Task 4.3 — prueba de caracterización: ejecutar mismo fixture con flag OFF y comparar contra baseline
8. Verificación completa: tsc, vitest, build, git diff
