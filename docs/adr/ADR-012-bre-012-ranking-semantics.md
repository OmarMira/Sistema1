# ADR-012: Canonical Ranking Semantics (BRE-012)

**Status:** Accepted

---

## Problem and Context

Los tres motores (Legacy, Precedence y V2) ordenaban su conjunto de candidatos
coincidentes con comparadores distintos:

- **V2** ordenaba por tier-first → sum-second → quality → priority → `ruleId`.
- **Precedence** sumaba pesos de condiciones con su propio map
  (`CONDITION_SPECIFICITY`) más un bonus de dirección (`directionSpecificity`, +20)
  y desempataba por `localeCompare(ruleId)`.
- **Legacy** ordenaba por `rolePriority` → `dbPriority` → orden estable de entrada.

Esto producía divergencias de ranking (`DIFFERENT_WINNER`) medidas en el eje A
del harness BRE-009 (caso R-1) y dejaba el orden de llegada / orden físico de DB
como señal de ranking en Legacy. Tres contratos distintos = tres respuestas
posibles para el mismo par de reglas.

---

## Decisiones

### Decisión 1 — Un único comparador canónico compartido por los tres motores

Legacy, Precedence y V2 MUST rankear su conjunto de candidatos coincidentes con
el MISMO comparador canónico determinista, en este orden:

1. **Especificidad tier-first** (`highestTier`, DESC).
2. **Suma dentro del tier** (`weightWithinTier`, DESC).
3. **Match quality** (DESC) — `min + 0.25*(avg−min)`.
4. **Prioridad manual** (ASC).
5. **`ruleId` ASC** — llave total determinista final.

El comparador vive en un módulo compartido (`canonical-ranking.ts`) importado por
los tres motores. No hay código de ordenamiento duplicado por motor.

### Decisión 2 — Sin señal de orden de entrada ni de fila DB

Ningún motor lee el orden físico de DB, el default de `findMany` ni el orden de
build/entrada del array como llave de ranking. El único discriminador final es
`ruleId ASC`. El stable-sort-on-input-order de Legacy es eliminado y reemplazado
por `ruleId ASC`.

### Decisión 3 — Criterio AMBIGUOUS unificado

Los tres motores deciden `AMBIGUOUS` con la misma computación canónica: si los
top-2 difieren en tier, suma o prioridad → hay ganador; si no, el delta de match
quality define: `delta < AMBIGUITY_DELTA_THRESHOLD` → `AMBIGUOUS`, si no → gana
el top. Umbral compartido centralizado con default `0.10` (valor convergente que
ya usaban ambos motores canónicos, validado por BRE-009/010). Cambiar el umbral
es un cambio de contrato versionado, no un tweak de implementación.

### Decisión 4 — Top-2 empate semántico completo → AMBIGUOUS, no ganador por ruleId

Cuando los top-2 empatan en todas las llaves semánticas (tier, suma, quality,
prioridad) y solo se distinguen por `ruleId`, son indistinguibles: se emite
`AMBIGUOUS`. `ruleId` es la llave total determinista para reproducibilidad y el
mecanismo de WINNER solo en los casos que caen a él determinísticamente; nunca
fabrica un ganador de negocio en un empate semántico completo.

### Decisión 5 — La dirección es pre-filtro, NO llave de ranking

`transactionDirection` se evalúa como filtro binario al construir el conjunto de
candidatos: una regla cuya dirección declarada no coincide con la dirección de la
transacción queda excluida del conjunto. Una vez dentro, la dirección NO aporta a
ninguna llave canónica (ni especificidad, ni quality, ni prioridad, ni `ruleId`).
Dos reglas que coinciden en la misma transacción y difieren SOLO por su dirección
declarada son un empate semántico completo → `AMBIGUOUS`.

Esto elimina el bonus `directionSpecificity` (+20) que Precedence sumaba
antes. Ese comportamiento se borra intencionalmente, no se migra. La decisión se
refleja en el contrato (`specs/rule-ranking-contract/spec.md`) para que un cambio
futuro no lo reintroduzca por accidente.

### Decisión 6 — Legacy adopta el comparador compartido

`evaluateWinningRule` y la ruta auto de Legacy seleccionan su ganador con el
comparador canónico en lugar de `rolePriority → dbPriority → orden estable de
entrada`. `role/frequency`, `entityRoles` y la prioridad de respuesta legacy son
documentados como legacy-only, no-canónicos, y NO se consumen como llave de
ranking canónica. El cambio aterriza detrás de los flags/gates existentes del
rule engine.

---

## Implementación

- `src/lib/rule-engine/canonical-ranking.ts` — módulo compartido: `CanonicalCandidate`,
  `AMBIGUITY_DELTA_THRESHOLD = 0.10`, `canonicalComparator`, `rankCanonical`,
  `classifyCanonical` (razones: `no_candidates`, `single_candidate`,
  `higher_specificity_tier`, `higher_specificity_weight`, `higher_priority`,
  `delta_above_threshold`, `delta_below_threshold`).
- `ranking.ts` (V2) delega en `rankCanonical`; `decision.ts` (V2) delega en
  `classifyCanonical` y re-exporta `AMBIGUITY_DELTA_THRESHOLD`.
- `rule-precedence-engine.ts` reescrito sobre `rankCanonical`/`classifyCanonical`;
  borrados `CONDITION_SPECIFICITY`, `directionSpecificity` y el sort inline; el
  AMBIGUOUS local es reemplazado por `classifyCanonical`. Los candidatos de salida
  se devuelven en orden canónico.
- `rule-matching-engine.ts` (Legacy) — Phase 4: selección de ganador vía el
  comparador compartido.
- `tests/measure-rule-parity.test.ts` — criterio fuerte de aceptación: tras el
  cambio completo, R-1 vuelve a `SAME_WINNER` con el comparador compartido en los
  tres motores.

---

## Alternativas consideradas

- **Priority-first** → rechazado: la especificidad estructural (tier/condiciones)
  debe mandar sobre la prioridad manual declarada.
- **Score ponderado único** → rechazado: mezcla tier y suma en un número opaco;
  el tier-first es más legible y es el modelo ya convergente en V2.
- **Preservar el orden estable de entrada de Legacy** → rechazado: deja el orden
  de build/DB como señal de ranking.
- **Comparador con `localeCompare`** → rechazado para `ruleId`: comparación
  ordinal binaria (`<`/`>`) evita dependencia del locale y es consistente entre
  motores.
- **Mantener `directionSpecificity` como llave** → rechazado: viola el contrato de
  un único comparador; la dirección es filtro de inclusión, no señal de orden.

---

## Consecuencias

- Paridad cross-engine: R-1 (tier conflict) deja de emitir `DIFFERENT_WINNER`; el
  harness BRE-009 vuelve a verde en los tres motores.
- Dos reglas que difieren solo por dirección declarada ahora emiten `AMBIGUOUS`
  (antes Precedence ganaba por el bonus +20). Es un cambio de contrato observable,
  documentado en spec + ADR.
- Sin migración de datos: el cambio es de ordenamiento, no de esquema.
- Rollback: revertir `canonical-ranking.ts` y los delegadores de cada motor;
  restaurar `CONDITION_SPECIFICITY`/`directionSpecificity` en Precedence y el sort
  legacy de entrada.
