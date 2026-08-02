# Wildcard Semantics: August 2026 (BRE-011)

## Before

El literal `*` como valor de condición se comportaba distinto entre motores
(Legacy vs Precedence/V2):

- **Legacy**: `*` = "coincide con cualquier valor no vacío" en todo campo.
- **Precedence / V2**: `*` evaluado literalmente → divergencia W-1 del eje A
  (`PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`), `InvalidNumericValue` en montos y
  `InvalidRegex` en `description_matches`.
- Reglas legacy `equals / "*"` con `conditions: null` fallaban en V2 con
  `conditions_normalization_failed`.

## What was done

| Área | Acción |
|---|---|
| **Contrato compartido** | Nuevo `src/lib/rule-engine/wildcard.ts`: superficie `WILDCARD_SURFACE` (4 operadores de descripción), `isWildcardValue`, `evaluateWildcardCondition`, `wildcardExclusionError` |
| **Legacy** | Guard inline reemplazado por el contrato compartido; semántica de no-vacío preservada |
| **V2 / Precedence** | Dispatcher (`conditions/index.ts`) enruta `*` antes de los evaluadores; `normalizeInputsForCompatibility` evita coerción `Number('*')` |
| **Monto / regex** | `*` → no-match explícito (nunca excepción) |
| **Validación (Decisión #1)** | Rechazo en escritura/import de `*` sobre monto/regex en capa compartida (`/api/bank-rules`, `createLearningRuleSchema`) |
| **Normalización legacy (Decisión #2)** | Adapter V2: conditions-first, fallback legacy → canónico, fail closed |
| **Harness BRE-009** | W-1 actualizado a `SAME_WINNER` (divergencia cerrada); métricas 12/12 |
| **Corpus BRE-011** | Convertido de observacional a matriz de aceptación (7 tests / 8 casos) |

## Key decisions made

- `*` es wildcard solo en `description_contains`, `description_eq`,
  `description_starts_with`, `description_ends_with`.
- `*` sobre monto/regex: no-match en runtime + rechazo en escritura/import
  (shared layer, no solo UI).
- Normalización legacy genérica (no special-case) con fail closed.
- Detalle completo: ver `docs/adr/ADR-011-wildcard-semantics.md`.

## Outcome

- Paridad cross-engine en la superficie wildcard acotada (W-1 cerrado).
- Sin migración de datos; el cambio afecta solo condiciones con valor `*`.
- Validación: `npx tsc --noEmit` limpio; suite completa verde (excepto
  `measure-real-rule-parity` que aborta sin la variable `BRE010_FIXTURE_PATH`,
  preexistente y ambiental).

## What remains for the future

- Restricción a nivel de base de datos para `*` (excluida explícitamente en la
  Decisión #1).
- Vigilar patrones con asterisco literal en descripciones reales de transacción.
