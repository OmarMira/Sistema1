# Ranking Semantics: August 2026 (BRE-012)

## Before

Los tres motores rankeaban reglas con heurísticas propias y divergentes:

- **Legacy**: `evaluateWinningRule` ordenaba por `rolePriority → dbPriority →
  input order` (stable sort). Ante empate con prioridad de regla igual, el
  ganador dependía del orden de llegada (load-bearing).
- **Precedence** (Precedence-DB): suma acumulada de `rankings.rank` +
  `rankings.extra_rank` como score; la dirección contaba como señal de ranking.
- **V2**: pre-ponderaba por tier/category y usaba `compareOrdinal` recién en el
  tiebreak final.

Consecuencia: la misma transacción podía resolver a reglas distintas según el
motor. Downgrade elegía un ganador, Precedence otro, V2 otro. R-1 era la
divergencia canónica del eje B del harness BRE-009.

## What was done

| Área | Acción |
|---|---|
| **Un solo comparador** | Nuevo `src/lib/rule-engine/canonical-ranking.ts`: `compareOrdinal`, `evaluateCanonicalCondition`, `computeSpecificity`, `computeMatchQuality`, `rankCanonical`, `classifyCanonical`, `AMBIGUITY_DELTA_THRESHOLD=0.10` |
| **Key canónico** | `tier|priority|condition type|specificity|matchQuality` (muy después del tipo de condición, nunca la dirección) |
| **Dirección = pre-filtro** | Excluida de las claves de ranking: `directionSpecificity` removido; dirección solo filtra si hay camino positivo de ${company}-a-banco |
| **Precedence** | Portado a `rankCanonical`/`classifyCanonical`; bug de orden de `candidates` corregido (retornan en orden canónico); borrados `CONDITION_SPECIFICITY`, `directionSpecificity`, sort inline |
| **Legacy** | `evaluateWinningRule` ahora decide con el comparador canónico compartido; retorna `MatchingRule \| undefined` (`AMBIGUOUS` → `undefined`); eliminado el sort `rolePriority → dbPriority → input order` (parámetros `_rolePriorities`/`_contexts` quedan sin uso por compat. de API) |
| **Tie** | Empate completo (top-2 iguales en las claves canónicas): `AMBIGUOUS` unificado en los tres motores (antes Legacy = first-wins, V2 divergía) |
| **Consumidores** | `rule-precedence-apply-all-resolver` y `auto/route` manejan winner `undefined` (AMBIGUOUS → sin resolución); harnesses usan `?.id ?? null` |
| **Harness BRE-009** | R-1 cerrado `DIFFERENT_WINNER` → `SAME_WINNER` en eje A y `SAME` en eje B; métricas 11/12 |
| **ADT** | Nuevo `docs/adr/ADR-012-ranking-semantics.md` + paragraph normativo "Direction is a pre-filter, NOT a ranking key" en `specs/rule-ranking-contract/spec.md` |

## Outcome
- Paridad cross-engine: `measure-rule-parity` 19/19, R1 → SAME_WINNER en ambos
  ejes, rate Legacy 12/12, rate V2 11/12 (la divergencia diseñada R1- cerrada).
- `tsc --noEmit` limpio; suite completa verde (excepto
  `measure-real-rule-parity` que aborta sin `BRE010_FIXTURE_PATH`, preexistente).
- El harness antes exigía 10 agreements y el test "input order is load-bearing"
  afirmaba la vieja ese sujeto a la entrada; ambos actualizados con evidencia
  `BRE-012`.

## What remains for the future

- Decidir si `rolePriority` debe seguir participando del tiebreak canónico o
  quedar obsoleto (parámetros hoy no-oped en Legacy).
- Documentar migración frontend/DB si alguna columna de ranking legacy se deprecia.