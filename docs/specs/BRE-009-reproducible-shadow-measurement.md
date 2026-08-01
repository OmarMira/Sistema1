# BRE-009: Reproducible Shadow Measurement

- **ID:** BRE-009
- **Status:** Approved — implemented and verified
- **Base:** BRE-001, BRE-007, BRE-008
- **TDR relacionados:** TDR-001 (Amount Semantics — BRE-006)

---

## Objetivo

Establecer un **protocolo de conformance** puro y reproducible que responda una única pregunta: ¿los
tres motores (Legacy, Precedence y V2) producen el mismo resultado sobre un dataset sintético fijo?

No es un sistema de observabilidad: no persiste nada, no consume datos reales, no mide la base local
`accountexpress` ni la producción. Es una **red de medición hermética** que valida tres acuerdos
estructurales ya documentados — dirección (BRE-007), normalización de texto (BRE-008) — y produce la
evidencia para decidir la semántica del monto (BRE-006).

La evidencia previa (BRE-001, BRE-007, BRE-008) provino de auditorías read-only y de la regla real
`cms9aa0g20005c758adkkcbah` de la base local. BRE-009 **reemplaza esa dependencia de datos locales** por
un contrato verificado: mismos motores, mismas entradas, mismo resultado, en cualquier checkout.

---

## Fuera de alcance

1. **Sin persistencia de auditoría:** el reporte es efímero (consola + JSON temporal no commiteado +
   reporte de vitest). Decisión del usuario en la revisión de la propuesta v2.
2. **Sin cambios en `package.json`:** no se agrega script ni dependencia; se ejecuta con
   `npx vitest run tests/measure-rule-parity.test.ts`.
3. **No es observabilidad:** no se instrumenta runtime, no hay export a infraestructura, no hay
   telemetría.
4. **No es un sistema de decisión:** no modifica ranking, specificity, ni evaluadores de ningún motor.
5. **Fuera de las mediciones:** ranking, wildcard, regex inválida, normalización y fixture defectuoso
   **nunca** gatillan BRE-006 (ver Gatillo formal de BRE-006).
6. **No toca fuente productiva, schema, migraciones, APIs ni flags.**

---

## Contexto validado (fuentes citadas)

| Motor | Entrada | Salida | Referencia |
|---|---|---|---|
| Legacy | `transactionMatchesRule` / `evaluateWinningRule` | ELEGIBLE / WINNER / sin match | `rule-matching-engine.ts` (puro, con `contexts=[]`, `entityFirstMode=false`, `rolePriorities={}`) |
| Precedence | `evaluateTransactionAgainstRules` | `NO_MATCH` / `WINNER` / `AMBIGUOUS` | `rule-precedence-engine.ts:117-201` |
| V2 | `runRuleEngineV2Shadow` (puro, `evaluateRulesPure`) | `matched` / `pending` + `errorCode` | `rule-engine-adapter/index.ts:107-122` |

Comparadores ya existentes (se reutilizan, NO se reimplementan):

- **L-vs-P (Legacy vs Precedence):** `compareRuleDecisions` — `rule-precedence-shadow.ts:141-172`.
  Códigos: `SAME_WINNER`, `BOTH_NO_MATCH`, `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`,
  `PRODUCTIVE_NO_MATCH_CANONICAL_MATCH`, `DIFFERENT_WINNER`, `CANONICAL_AMBIGUOUS`
  (`rule-precedence-shadow.ts:8-14`).
- **V-vs-P (V2 vs Precedence):** `classifyDivergence` / `buildDivergenceEvent` —
  `rule-engine/events.ts:30-53` y `:55-72`. Tipos: `V2_MATCH_PRECEDENCE_NO_MATCH`,
  `V2_NO_MATCH_PRECEDENCE_MATCH`, `V2_PENDING_PRECEDENCE_MATCH`, `V2_ERROR`, `DIFFERENT_WINNER`,
  `SAME`.

**Ojo con `V2_PENDING_PRECEDENCE_MATCH`:** es una etiqueta declarada (`events.ts:17`) que
**ningún branch de `classifyDivergence` produce** (`events.ts:34-52`). Es un label muerto. El protocolo
NO debe depender de él; la señal de divergencia V-vs-P se verifica solo contra los tipos realmente
producibles (`events.ts:34-52`).

Hechos de comportamiento (frontera del fixture):

- `MatchResult.errorCode` de V2: `'conditions_normalization_failed'` | `'engine_execution_error'`
  (`rule-engine-adapter/index.ts:117-121`). Este protocolo acepta **`engine_execution_error` genérico**
  (no se distinguen causas).
- **Precedence falla SILENCIOSO:** regex inválida o tipo de condición desconocido → condición con
  `match:false`, sin excepción (`rule-precedence-engine.ts:56-61`).
- **Semántica de monto:** Legacy y Precedence comparan magnitud (`Math.abs` en ambos lados:
  `rule-matching-engine.ts:53-70`, `rule-precedence-compat.ts:60-79`); V2 comparaba signed
  (`conditions/amount.ts:11-56`) — **contrato unificado por magnitud en BRE-006**, post-implementación los
  tres motores comparan `Math.abs`.
- **Wildcard `*`: solo Legacy** lo trata como "cualquier descripción no vacía"
  (`rule-matching-engine.ts:49`); Precedence y V2 lo tratan literalmente.
- **Ranking:** Legacy ordena `rolePriority → dbPriority` (`rule-matching-engine.ts:309-314`);
  Precedence ordena `specificityScore → matchQuality → priority` (`rule-precedence-engine.ts:170-175`);
  V2 ordena `tier → weight → quality → priority` (`specificity.ts:3-18`) con delta de ambigüedad 0.10.

### Regla real: control only

La regla real `cms9aa0g20005c758adkkcbah` (debit + `description_contains` + priority 10, valor
`omar mira`) es **solo control estructural** de forma (mismo shape que R-CTRL), **no una muestra
estadística**. **Nunca** se usa su id ni su valor `omar mira` en los fixtures. El dataset del protocolo
es 100 % sintético.

---

## Dataset sintético mínimo

### Reglas (9)

| ID | Dirección | Condiciones | Prioridad | Nota |
|---|---|---|---|---|
| R-CTRL | debit | `description_contains` (valor sintético) | 10 | Control positivo; espejo estructural de la regla real (sin usar id ni valor reales) |
| R-DIR | credit | `description_contains` (valor sintético) | 10 | Control de dirección (BRE-007) |
| R-AMT1 | debit | `amount_greater_than` 100 | 10 | Monto, cruce de signo |
| R-AMT1C | credit | `amount_greater_than` 100 | 10 | Equivalente credit de R-AMT1, SOLO para el control M-control |
| R-AMT2 | (sin dirección) | `equals` 150 | 10 | Monto, igualdad con cruce de signo |
| R-WLD | (sin dirección) | `description_contains` con `conditionValue '*'` | 10 | Wildcard legacy-only |
| R-A | (sin dirección) | `description_contains` "mercado" + `description_contains` "pago" | 10 | Ranking: dos condiciones contiene |
| R-B | (sin dirección) | `description_starts_with` "mercado" | 10 | Ranking: una condición starts_with |
| R-REG | (sin dirección) | `description_matches '['` | 10 | Regex inválida |

**Total: 9 reglas.** `R-AMT1C` es imprescindible: el control positivo M-control necesita una regla que no sea
descartada por el pre-filtro de dirección cuando la transacción es `+200`. Reutilizar la regla `debit`
R-AMT1 con un monto positivo haría que los tres motores la descartaran por dirección **antes** de evaluar
monto, invalidando el control por la razón equivocada.

### Vectores (12) y escenarios herméticos

Cada escenario entrega **solo el subconjunto de reglas en alcance de su categoría**. Esto es obligatorio
por el wildcard legacy: como R-WLD matchea **cualquier** descripción no vacía en Legacy
(`rule-matching-engine.ts:49`), incluirlo en un escenario de otra categoría contaminaría el resultado.
Por eso cada categoría es hermética: nadie comparte reglas fuera de su escenario.

El **orden de entrada de las reglas es parte del fixture** en los escenarios de ranking: se pasan
siempre como `[R-A, R-B]`. Legacy usa `Array.sort` estable (`evaluateWinningRule`,
`rule-matching-engine.ts:309-314`): con prioridades iguales y sin role priorities, el desempate
depende del orden de entrada. Este orden es **load-bearing** y debe quedar testeado (el resultado del
escenario R-1 cambia si se invierte).

Los valores de `conditionValue` de R-CTRL, R-DIR, R-A y R-B son **sintéticos** (no se usan valores de la
regla real). Los `conditionValue` literales `"mercado"`, `"pago"` y los montos del vector de casos se
usan solo dentro de `tests/measure-rule-parity.test.ts`; el reporte JSON y la consola exponen solo
`caseId` + categoría + **tipos** de condición, nunca valores.

---

## Matriz exacta de casos (12)

| # | id | categoría | reglas | transacción (descripción, monto) | Legacy | Precedence | V2 | señal de divergencia | criterio de éxito |
|---|---|---|---|---|---|---|---|---|---|
| 1 | C-pos | control | R-CTRL | "control unitario", -100 | WINNER | WINNER | matched | ninguna | L-vs-P `SAME_WINNER` + V-vs-P `SAME` |
| 2 | C-neg | control | R-CTRL | "sin coincidencia", -100 | sin match | NO_MATCH | pending | ninguna | L-vs-P `BOTH_NO_MATCH` + V-vs-P `SAME` |
| 3 | D-pos | dirección | R-DIR | "pago de servicio", +200 | WINNER | WINNER | matched | ninguna | L-vs-P `SAME_WINNER` + V-vs-P `SAME` |
| 4 | D-neg | dirección | R-DIR | "pago de servicio", -200 | sin match | NO_MATCH | pending | ninguna | L-vs-P `BOTH_NO_MATCH` + V-vs-P `SAME` |
| 5 | M-1 | monto | R-AMT1 | "compra", -200 | WINNER | WINNER | matched | ninguna | L-vs-P `SAME_WINNER` + V-vs-P `SAME` |
| 6 | M-2 | monto | R-AMT1 | "compra", -50 | sin match | NO_MATCH | pending | ninguna | L-vs-P `BOTH_NO_MATCH` + V-vs-P `SAME` |
| 7 | M-3 | monto | R-AMT2 | "compra", -150 | WINNER | WINNER | matched | ninguna | L-vs-P `SAME_WINNER` + V-vs-P `SAME` |
| 8 | M-control | monto | R-AMT1C (credit) | "compra", +200 | WINNER | WINNER | matched | ninguna | L-vs-P `SAME_WINNER` + V-vs-P `SAME` |
| 9 | W-1 | wildcard | R-WLD | "cualquier cosa", -100 | WINNER | NO_MATCH | pending | `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` (solo L-vs-P) | L-vs-P señal de wildcard; V-vs-P `SAME` |
| 10 | R-1 | ranking | R-A + R-B (orden fijo `[R-A, R-B]`) | "mercado pago sa", -100 | WINNER (R-A por orden estable) | WINNER (R-A por specificity) | matched (R-B por tier) | `DIFFERENT_WINNER` (V-vs-P) | divergencia observada en V-vs-P; L-vs-P `SAME_WINNER` |
| 11 | R-2 | ranking control | R-A + R-B | "mercado libre solo start", -100 | WINNER (R-B) | WINNER (R-B) | matched (R-B) | ninguna | L-vs-P `SAME_WINNER` + V-vs-P `SAME` |
| 12 | X-1 | regex inválida | R-REG | "x", -100 | sin match | NO_MATCH | pending (`engine_execution_error`) | `V2_ERROR` | V-vs-P `V2_ERROR`; además registrar que el `NO_MATCH` silencioso de Precedence es un hecho medido |

### Detalle de expectativas por motor

**Caso 5 (M-1), monto con cruce de signo:** R-AMT1 es debit + `amount_greater_than 100`.
- Legacy: `Math.abs(-200) > Math.abs(100)` → true → WINNER.
- Precedence: `Math.abs(-200) > Math.abs(100)` → true → WINNER.
- V2 (post-BRE-006): `Math.abs(-200) > Math.abs(100)` → true (magnitud) → matched.
- Señal V-vs-P: `SAME` (`events.ts:50-52`). L-vs-P: `SAME_WINNER`.

**Caso 7 (M-3), igualdad con cruce de signo:** R-AMT2 sin dirección + `equals 150`.
- Legacy: `Math.abs(-150) === Math.abs(150)` → true → WINNER.
- Precedence: idem → WINNER.
- V2 (post-BRE-006): `Math.abs(-150) === Math.abs(150)` → true (magnitud) → matched.
- Señal V-vs-P: `SAME`.

**Caso 8 (M-control), control de monto positivo:** R-AMT1C es **credit** + `amount_greater_than 100`.
- ¿Por qué credit y no debit? El control exige que los tres motores *matcheen* en rango positivo (`+200`).
  Una regla `debit` sería descartada por el pre-filtro de dirección en los tres motores antes de evaluar
  monto — el control fallaría por la razón equivocada. Con R-AMT1C credit, `+200` supera el pre-filtro y
  llega a la evaluación de monto.
- Legacy: `Math.abs(200) > Math.abs(100)` → true → WINNER.
- Precedence: `Math.abs(200) > Math.abs(100)` → true → WINNER.
- V2 (post-BRE-006): `Math.abs(200) > Math.abs(100)` → true (magnitud) → matched.
- Este caso demuestra que el harness no está sesgado a divergir: tres motores en acuerdo sobre un monto
  en rango con signo positivo.

**Caso 9 (W-1), wildcard:** R-WLD con `conditionValue '*'`.
- Legacy: `'*'` matchea cualquier descripción no vacía → WINNER.
- Precedence: `'*'` literal, `'cualquier cosa'` no contiene `'*'` → NO_MATCH.
- V2: `'*'` literal → pending.
- L-vs-P: `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` (`rule-precedence-shadow.ts:153-154`). V-vs-P: `SAME`
  (ambos tratan `'*'` literalmente).
- Esta divergencia es **semántica documentada y diferida**, nunca señal de BRE-006.

**Caso 10 (R-1), ranking:** con R-A (dos `description_contains`) y R-B (`description_starts_with`),
orden de entrada fijo `[R-A, R-B]`, transacción `"mercado pago sa"` (matchea ambas).
- Legacy → **R-A**: sin role priorities y con prioridad igual (10), el sort estable de
  `evaluateWinningRule` (`rule-matching-engine.ts:309-314`) conserva el orden de entrada. El ganador NO
  es "R-B por prioridad" (ambas tienen la misma); es R-A por ser el primero de la lista.
- Precedence → **R-A**: specificity suma `CONDITION_SPECIFICITY` (`rule-precedence-engine.ts:65-77`):
  R-A = 40+40 = 80; R-B = 60 → gana R-A.
- V2 → **R-B**: tier/weight (`specificity.ts:4-18`): R-A matchea dos `description_contains` (tier 1);
  R-B matchea `description_starts_with` (tier 2) → gana por tier.
- Señal V-vs-P: **`DIFFERENT_WINNER`** (V2 elige R-B, Precedence R-A). L-vs-P: `SAME_WINNER` (ambos
  eligen R-A).
- **El orden `[R-A, R-B]` es load-bearing**: invertirlo cambiaría el ganador Legacy a R-B y rompería
  la expectativa L-vs-P `SAME_WINNER`. El test debe fijar y verificar ese orden.

**Caso 11 (R-2), control de ranking:** solo R-B matchea ("mercado libre solo start" no contiene
"pago") → los tres eligen R-B → `SAME_WINNER` / `SAME`.

**Caso 12 (X-1), regex inválida:** R-REG con `description_matches '['`.
- Legacy: no representa `description_matches` (no hay operador regex en su conjunto de operadores) →
  no matchea (`rule-matching-engine.ts:51-73`).
- Precedence: `evaluateSingleCondition` lanza (patrón inválido) → catch → `match:false` silencioso
  (`rule-precedence-engine.ts:56-61`) → NO_MATCH. Este fallo silencioso es un hecho a registrar en el
  reporte, no una señal.
- V2: el builder del fixture DEBE crear la condición directamente como
  `{ type: 'description_matches', value: '[' }` (formato V2). **No** debe pasar por un operador V1
  `matches` (`{field, operator:'matches', value}`): ese operador no está mapeado en
  `conditions-normalizer.ts` y produciría un error de normalización distinto
  (`conditions_normalization_failed`), no la señal que el protocolo quiere medir.
- Señal V-vs-P: **`V2_ERROR`** con `errorCode === 'engine_execution_error'`
  (`rule-engine-adapter/index.ts:116-121`).

---

## Métricas de conformance (exactas, sin muestreo)

**Regla contable central:** todo vector se clasifica **por eje** (A: Legacy vs Precedence; B: V2 vs
Precedence). Los dos ejes son **matrices independientes** y sus tasas **nunca** se mezclan en un solo
número: un vector puede divergir en el eje A y acordar en el eje B (caso W-1). Ningún conteo cruza ejes.

**Conformance exacto:** tasa objetivo 1.0, tolerancia 0.

### Eje A — Legacy vs Precedence

Códigos de señal posibles, por vector:

| Código | Significado | Acuerdo |
|---|---|---|
| `SAME_WINNER` | ambos eligen la misma regla | ✔ acuerdo |
| `BOTH_NO_MATCH` | ambos no matchean | ✔ acuerdo |
| `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` | Legacy matchea, Precedence no | ✘ divergencia |
| `PRODUCTIVE_NO_MATCH_CANONICAL_MATCH` | Legacy no matchea, Precedence sí | ✘ divergencia |
| `DIFFERENT_WINNER` | ambos matchean, distinta regla | ✘ divergencia |
| `CANONICAL_AMBIGUOUS` | Precedence ambiguo | ✘ divergencia (señal) |

### Eje B — V2 vs Precedence

Códigos de señal posibles, por vector:

| Código | Significado | Acuerdo |
|---|---|---|
| `SAME` | mismo desenlace (misma regla o ambos NO_MATCH) | ✔ acuerdo |
| `DIFFERENT_WINNER` | ambos matchean, distinta regla | ✘ divergencia |
| `V2_MATCH_PRECEDENCE_NO_MATCH` | V2 matchea, Precedence no | ✘ divergencia |
| `V2_NO_MATCH_PRECEDENCE_MATCH` | V2 no matchea, Precedence sí | ✘ divergencia |
| `V2_ERROR` | V2 falla (no produce decisión comparable) | ✘ **error** (no divergencia) |

**Clasificación de `V2_ERROR`:** se cuenta **exclusivamente como error**, nunca como divergencia y nunca
como acuerdo. `SAME + divergencias + errores = total` del eje B, sin doble conteo. La divergencia de
V2 solo existe cuando ambas decisiones son comparables (regla vs regla, o match vs no-match sin
excepción).

### Métricas por eje

| Métrica | Definición |
|---|---|
| `legacyPrecedenceTotal` | nº de vectores evaluados en el eje A (12) |
| `legacyPrecedenceAgree` | eje A: `SAME_WINNER` + `BOTH_NO_MATCH` |
| `legacyPrecedenceDivergence` | eje A: códigos de divergencia de la tabla (p. ej. `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`) |
| `legacyPrecedenceAgreementRate` | `legacyPrecedenceAgree / legacyPrecedenceTotal` |
| `v2PrecedenceTotal` | nº de vectores evaluados en el eje B (12) |
| `v2PrecedenceAgree` | eje B: `SAME` |
| `v2DivergenceCount` | eje B: `DIFFERENT_WINNER` + `V2_MATCH_PRECEDENCE_NO_MATCH` + `V2_NO_MATCH_PRECEDENCE_MATCH` |
| `v2ErrorCount` | eje B: `V2_ERROR` |
| `v2PrecedenceAgreementRate` | `v2PrecedenceAgree / v2PrecedenceTotal` |
| `v2ErrorRate` | `v2ErrorCount / v2PrecedenceTotal` |
| `precedenceErrorRate` | 0 por diseño (Precedence falla silencioso); se reporta como hecho |
| `recall_c` | señales predichas detectadas / señales predichas diseñadas (por eje y categoría) |
| `falsePositive_c` | nº de vectores con señal distinta a la predicha o señal no diseñada (por eje y categoría) |

No existe un campo genérico `overallAgreement`: toda tasa de acuerdo se reporta con su eje en el nombre.
Los falsos negativos (divergencia esperada que no apareció) y los falsos positivos (señal no diseñada)
se reportan en `recall_c` y `falsePositive_c` con su eje.

**Metadata del reporte:** `fixtureVersion` (hash del dataset), `git commit` (HEAD al momento del run),
`runId`, y las dos matrices de 12 filas (una por eje) con estado L/P/V por vector + código + `errorCode`.

---

## Valores esperados del fixture (cálculo caso por caso, 12 vectores, 9 reglas)

### Cálculo del eje A — Legacy vs Precedence

| # | id | Legacy | Precedence | Código A | Acuerdo |
|---|---|---|---|---|---|
| 1 | C-pos | WINNER | WINNER | `SAME_WINNER` | ✔ |
| 2 | C-neg | sin match | NO_MATCH | `BOTH_NO_MATCH` | ✔ |
| 3 | D-pos | WINNER | WINNER | `SAME_WINNER` | ✔ |
| 4 | D-neg | sin match | NO_MATCH | `BOTH_NO_MATCH` | ✔ |
| 5 | M-1 | WINNER | WINNER | `SAME_WINNER` | ✔ |
| 6 | M-2 | sin match | NO_MATCH | `BOTH_NO_MATCH` | ✔ |
| 7 | M-3 | WINNER | WINNER | `SAME_WINNER` | ✔ |
| 8 | M-control | WINNER | WINNER | `SAME_WINNER` | ✔ |
| 9 | W-1 | WINNER | NO_MATCH | `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH` | ✘ |
| 10 | R-1 | WINNER (R-A) | WINNER (R-A) | `SAME_WINNER` | ✔ |
| 11 | R-2 | WINNER (R-B) | WINNER (R-B) | `SAME_WINNER` | ✔ |
| 12 | X-1 | sin match | NO_MATCH | `BOTH_NO_MATCH` | ✔ |

- `legacyPrecedenceAgree` = **11** (todos menos W-1)
- `legacyPrecedenceDivergence` = **1** (W-1, `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`)
- `legacyPrecedenceAgreementRate` = **11/12**

### Cálculo del eje B — V2 vs Precedence

| # | id | V2 | Precedence | Código B | Clase |
|---|---|---|---|---|---|
| 1 | C-pos | matched | WINNER | `SAME` | ✔ acuerdo |
| 2 | C-neg | pending | NO_MATCH | `SAME` | ✔ acuerdo |
| 3 | D-pos | matched | WINNER | `SAME` | ✔ acuerdo |
| 4 | D-neg | pending | NO_MATCH | `SAME` | ✔ acuerdo |
| 5 | M-1 | matched | WINNER | `SAME` | ✔ acuerdo |
| 6 | M-2 | pending | NO_MATCH | `SAME` | ✔ acuerdo |
| 7 | M-3 | matched | WINNER | `SAME` | ✔ acuerdo |
| 8 | M-control | matched | WINNER | `SAME` | ✔ acuerdo |
| 9 | W-1 | pending | NO_MATCH | `SAME` | ✔ acuerdo |
| 10 | R-1 | matched (R-B) | WINNER (R-A) | `DIFFERENT_WINNER` | ✘ divergencia |
| 11 | R-2 | matched (R-B) | WINNER (R-B) | `SAME` | ✔ acuerdo |
| 12 | X-1 | pending (`engine_execution_error`) | NO_MATCH | `V2_ERROR` | ✘ error |

- `v2PrecedenceAgree` = **10** (C-pos, C-neg, D-pos, D-neg, M-1, M-2, M-3, M-control, W-1, R-2)
- `v2DivergenceCount` = **1** (R-1 → `DIFFERENT_WINNER`)
- `v2ErrorCount` = **1** (X-1 → `V2_ERROR`; no se suma a la divergencia)
- `v2PrecedenceAgreementRate` = **10/12**
- `v2ErrorRate` = **1/12**
- `precedenceErrorRate` = **0** (hecho medido, no señal)

### Relación entre ejes (por qué no hay contradicción)

| Vector | Eje A | Eje B |
|---|---|---|
| W-1 | **divergente** (`PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`) | **acuerdo** (`SAME`) |

W-1 es divergente en el eje A (Legacy wildcard `*` vs Precedence literal) pero acuerda en el eje B
(V2 y Precedence tratan `'*'` literalmente). Por eso `legacyPrecedenceAgreementRate = 11/12` y
`v2PrecedenceAgreementRate = 10/12` miden **ejes distintos**: la suma 11 + 10 no tiene significado.

Sanidad contable: en el eje B, `10 acuerdos + 1 divergencia + 1 error = 12`. En el eje A,
`11 acuerdos + 1 divergencia = 12`. Ambos totalizan 12 sin solapamiento ni doble conteo.

`recall_c = 1` y `falsePositive_c = 0` en las 6 categorías y en ambos ejes (recall para
control/direccion es 0/0 → 1, ya que no tienen divergencia diseñada).

**Nota de cálculo:** todas las cifras derivan de las dos matrices de 12 filas de esta sección. Si el
fixture cambia, estas métricas deben recalcularse desde cero; no son constantes independientes de la
matriz. Tras BRE-006 (contrato de monto por magnitud, M-1/M-3 → `SAME`), el `fixtureVersion` se
recalcula de `fnv1a-4c99a7c8380b` a **`fnv1a-2c2a9680ae63`** (hash real del run post-implementación).

**Historial de estado (pre-BRE-006):** antes del contrato de monto por magnitud, el eje B medía
`v2PrecedenceAgree = 8`, `v2DivergenceCount = 3` (M-1, M-3 → `V2_NO_MATCH_PRECEDENCE_MATCH`; R-1 →
`DIFFERENT_WINNER`) y `v2PrecedenceAgreementRate = 8/12`, con `fixtureVersion fnv1a-4c99a7c8380b`. Ese
estado disparó el gatillo formal de BRE-006 (sección homónima) y sus señales esperadas quedaron
registradas en el DoD de esta especificación. Tras BRE-006, el eje B pasó a `10/12` con divergencia
solo en R-1; las matrices y métricas de esta sección reflejan el estado **posterior**. El estado previo
completo (filas M-1/M-3 con `pending` + señal) es recuperable en el historial git del spec.

---

## Criterios de paridad

**Paridad de categoría** ⇔ se cumplen TODAS:
- todos los vectores agree-expected de la categoría producen `SAME` (+ `SAME_WINNER` / `BOTH_NO_MATCH`
  según el caso), y
- todos los vectores diverge-expected de la categoría producen **la señal predicha**, y
- `recall_c = 1` (falsos negativos = 0), y
- `falsePositive_c = 0`.

**Divergencia confirmada** ⇔ ≥1 señal predicha observada.

**Regla de lectura crítica:** un vector diverge-expected que produce `SAME` **no se lee nunca como
"la paridad ganó"**. Se lee como **`FIXTURE FAILURE`** (fixture mal diseñado) o como **fix ya
aterrizado** (el motor cambió desde que se diseñó el fixture). El run debe fallar en ese caso, no
pasar.

---

## Gatillo formal de BRE-006

**BRE-006 se abre SOLO si** el protocolo demuestra una divergencia **reproducible** atribuible
**exclusivamente** a la semántica de monto (signed vs magnitud). Concretamente:

- V-vs-P ∈ {`V2_NO_MATCH_PRECEDENCE_MATCH`, `V2_MATCH_PRECEDENCE_NO_MATCH`} observado en los escenarios
  **M-1** y/o **M-3**, con `fixtureVersion` y commit verificados en el reporte.

**NUNCA** se abre BRE-006 por:
- ranking (`DIFFERENT_WINNER`),
- wildcard (`PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`),
- regex inválida (`V2_ERROR`),
- normalización de texto,
- ni fixture defectuoso.

**Aceptación post-BRE-006:** los mismos escenarios M-1/M-3 pasan a `SAME` (y los otros escenarios
siguen iguales) con los controles intactos. Ese flanco es la definición de "resuelto" del TDR-001.

---

## Controles obligatorios

| Control | Caso | Fallo |
|---|---|---|
| Control positivo | C-pos (`SAME_WINNER` + `SAME`) | **Todo el run es INVALID** |
| Control negativo | C-neg (`BOTH_NO_MATCH` + `SAME`) | **Todo el run es INVALID** |
| Control de dirección | D-pos / D-neg | run inválido si fallan |
| Control de monto | M-2 / M-control | run inválido si fallan |
| Control de ranking | R-2 | run inválido si falla |

Si falla **cualquier** control, el run no se interpreta: se marca `INVALID` y no se emite veredicto de
paridad ni se considera la evidencia para BRE-006. Los controles son la prueba de que el harness mide
lo que dice medir.

---

## Reporte

1. **Consola:** tabla por categoría con veredicto `PARITY` / `DIVERGENCE_CONFIRMED` / `FIXTURE_ERROR` +
   tasas agregadas (`legacyPrecedenceAgreementRate`, `v2PrecedenceAgreementRate`, `v2ErrorRate`,
   `precedenceErrorRate`).
2. **JSON temporal:** matriz completa de casos + métricas + metadata. Se construye y **valida en
   memoria** primero; se escribe a `os.tmpdir()` (p. ej. `fs.mkdtempSync(path.join(os.tmpdir(),
   'rule-parity-'))`) **solo durante el run**, se muestra su ruta en consola y se elimina al finalizar
   (best-effort, idempotente en `afterAll`). **Nunca** se escribe dentro del repositorio (`docs/`,
   repo tree, ni cualquier carpeta versionable). El resultado durable es el output de Vitest/consola,
   no el JSON — el JSON es solo la evidencia inspeccionable del run.
3. **Reporte de vitest:** resultado del test como salida estándar de la suite.

Sin persistencia, sin datos reales, sin identificadores productivos: el reporte lleva solo `caseId` +
categoría + **tipos** de condición (p. ej. `description_contains`, `amount_greater_than`), **nunca**
valores, descripciones, montos, ids de regla ni ids de transacción reales.

---

## Comando de ejecución previsto

```bash
npx vitest run tests/measure-rule-parity.test.ts
```

Sin cambios en `package.json`: el test se ejecuta directamente con vitest.

---

## Archivos autorizados para implementación futura

- `tests/measure-rule-parity.test.ts`
- `docs/specs/BRE-009-reproducible-shadow-measurement.md` (este documento)

## Archivos prohibidos

- `package.json` (y cualquier otro cambio de dependencias/scripts)
- Cualquier fuente productiva (`src/`) — incluidos evaluadores, comparadores, adapters, shadow runner
- Schema Prisma y migraciones
- APIs (route handlers, endpoints)
- Observabilidad persistente (audit logs, tablas, export)
- Feature flags

---

## Rollback

Trivial:

- Sin DB, sin archivos commiteados, sin flags productivos.
- `git revert HEAD --no-edit` revierte el único commit.
- El JSON temporal se borra; es idempotente (re-ejecutar el protocolo produce el mismo resultado).

---

## Definition of Done

- [ ] `tests/measure-rule-parity.test.ts` creado con las 12 cases y los 9 fixtures del dataset mínimo
- [ ] Protocolo verde vía `npx vitest run tests/measure-rule-parity.test.ts`
- [ ] Los 5 controles pasan (C-pos, C-neg, D, M-control/R-2); un fallo de control invalida el run
- [ ] Los 12 casos producen las señales esperadas (incluidas M-1/M-3 → `V2_NO_MATCH_PRECEDENCE_MATCH`,
      R-1 → `DIFFERENT_WINNER`, W-1 → `PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`, X-1 → `V2_ERROR`)
- [ ] `recall_c = 1` y `falsePositive_c = 0` en todas las categorías
- [ ] Reporte efímero: consola + JSON temporal no commiteado + reporte de vitest; sin persistencia
- [ ] Reporte sin datos reales ni identificadores productivos (solo `caseId` + categoría + tipos)
- [ ] Metadata del reporte: `fixtureVersion` + git commit + `runId`
- [ ] `V2_PENDING_PRECEDENCE_MATCH` NO se usa como señal (label muerto, `events.ts:17` no producible)
- [ ] Precedence falla silencioso documentado como hecho en X-1, no como señal de monto
- [ ] Un vector diverge-expected con `SAME` falla el test como `FIXTURE_FAILURE` (nunca "paridad ganó")
- [ ] Zero cambios en archivos prohibidos (`package.json`, `src/`, schema, migraciones, APIs)
- [ ] `npx tsc --noEmit` exitoso · `npm run lint` sin errores nuevos · suite completa sin regresiones
- [ ] `git status` limpio salvo por `tests/measure-rule-parity.test.ts` + este spec
- [ ] Este spec actualizado a `Approved` cuando el usuario lo autorice

---

## Separación de commits propuesta

Commit único:

```
test(rule-engine): add reproducible parity measurement protocol (BRE-009)
```

Contenido (solo estos dos archivos):

- `tests/measure-rule-parity.test.ts`
- `docs/specs/BRE-009-reproducible-shadow-measurement.md`

Sin commits de fuente productiva: el protocolo es de medición pura y su único artefacto de código es el
test.

---

## Relación con la secuencia BRE

1. ✅ BRE-001 (shadow estable)
2. ✅ BRE-007 (dirección como concepto de primer orden en V2)
3. ✅ BRE-008 (paridad de normalización de texto de descripción)
4. 🔄 **BRE-009 (este work item):** protocolo reproducible de medición de conformance
5. ✅ **BRE-006 (resuelto):** contrato de monto por magnitud, decidido con la evidencia de M-1/M-3 de este
   protocolo e implementado en `conditions/amount.ts`; esta especificación refleja el estado post-BRE-006.

BRE-009 no modifica ningún motor: construye la red de medición reproducible que reemplaza las auditorías
read-only de datos locales como fuente de evidencia.
