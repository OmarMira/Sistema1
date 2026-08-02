# ADR-011: Wildcard Semantics (BRE-011)

**Status:** Accepted

---

## Problem and Context

El literal `*` como valor de una condición de regla se comportaba de forma
inconsistente entre los tres motores (Legacy, Precedence y V2):

- **Legacy** (`rule-matching-engine.ts`): el guard inline trataba `*` como
  "coincide con cualquier valor no vacío" para **todo** campo y operador.
- **Precedence** y **V2**: evaluaban `*` literalmente (p. ej. `contains("*")`
  buscaba el carácter asterisco en la descripción, `amount_gt("*")` lanzaba
  `InvalidNumericValue`, `description_matches("*")` lanzaba `InvalidRegex`).

Esto producía la divergencia W-1 del eje A del harness BRE-009
(`PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`): Legacy matcheaba y Precedence no.
Además, una regla legacy almacenada con columnas `conditionType`/`conditionValue`
(`equals / "*"`) y `conditions: null` fallaba en V2 con
`conditions_normalization_failed`.

---

## Decisiones

### Decisión 1 — Contrato de runtime y rechazo en escritura/import

- **`*` es un wildcard acotado**: significa "coincide con cualquier valor no
  vacío" solo para `description_contains`, `description_eq`,
  `description_starts_with` y `description_ends_with` (superficie `WILDCARD_SURFACE`).
- **`*` no es wildcard** en `description_matches` (regex) ni en operadores de
  monto (`amount_*`). En runtime se evalúa como **no-match explícito**: nunca
  lanza `InvalidRegex`/`InvalidNumericValue`, nunca matchea.
- **Rechazo en escritura/import**: crear o importar una regla con `*` sobre
  monto o regex se rechaza en la capa compartida de dominio/API
  (`wildcardExclusionError`), aplicada en la creación vía `/api/bank-rules` y
  en el esquema `createLearningRuleSchema` (reglas aprendidas). La UI no es la
  única barrera. No hay restricción a nivel de base de datos.

### Decisión 2 — Normalización de columnas legacy (caso 4)

Cuando `conditions` no es una representación utilizable y existen
`conditionType`/`conditionValue`, el adapter MUST normalizar las columnas legacy
al modelo canónico antes de ejecutar V2. Precedencia:

1. `conditions` válidas no vacías → se usan (se ignoran las legacy).
2. Si no → fallback a columnas legacy → modelo canónico
   (`conditionType = "equals"`, `conditionValue = "*"` → `description_eq("*")`,
   enrutada por el contrato wildcard compartido).
3. Si ninguno normaliza → fail closed (`conditions_normalization_failed`).

El camino productivo NO preserva `conditions: null` (la preservación de null era
solo para el harness observacional de BRE-010).

---

## Implementación

- `src/lib/rule-engine/wildcard.ts` — módulo compartido: `WILDCARD_SURFACE`,
  `isWildcardValue`, `evaluateWildcardCondition`, `legacyConditionType` y
  `wildcardExclusionError` (barrera compartida de validación).
- Legacy (`rule-matching-engine.ts`) reemplaza su guard inline por
  `evaluateWildcardCondition`; mantiene la semántica de no-vacío.
- V2 y Precedence heredan el contrato vía el dispatcher
  (`conditions/index.ts`) y el guard temprano en
  `normalizeInputsForCompatibility` (evita coerción `Number('*') = NaN`).
- Adapter V2 (`rule-engine-adapter/index.ts`) implementa el fallback legacy con
  fail closed.
- El harness BRE-009 (`measure-rule-parity.test.ts`) actualiza W-1 a
  `SAME_WINNER` (divergencia cerrada).

---

## Alternativas consideradas

- Mantener el guard inline en cada motor → rechazado: triple duplicación y
  deriva.
- Guard solo en el dispatcher V2 → rechazado: Legacy tiene su propio camino de
  evaluación.
- Special-case para `equals / "*"` → rechazado: deja el mismo problema para
  otros valores legacy; la normalización genérica cubre todas las columnas.

---

## Consecuencias

- Paridad cross-engine en la superficie wildcard acotada (se cierra W-1).
- `*` sobre monto/regex: comportamiento determinista (no-match) para filas
  preexistentes + rechazo en nuevas escrituras.
- Ninguna migración de datos: el cambio aplica solo a condiciones con valor `*`
  (0 reglas reales, 0.00 % prevalencia).
- Rollback: revertir los consumidores de `wildcard.ts`, eliminar el módulo,
  restaurar el guard inline de Legacy y revertir la normalización legacy.
