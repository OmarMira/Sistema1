# BRE-006: Amount Semantics Contract

- **ID:** BRE-006
- **Status:** Implemented — pending final approval
- **Base:** BRE-001, BRE-007, BRE-008, BRE-009
- **TDR relacionados:** TDR-001 (Amount Semantics — BRE-006)

---

## Objetivo

Formalizar y adoptar en V2 el **contrato de monto** que los motores productivos (Legacy y
Precedence) ya cumplen: comparación por **magnitud** y dirección derivada del signo como **eje
independiente**, filtrado **antes** de evaluar el monto. Cerrar así el gate de BRE-009 (M-1/M-3
pasan a `SAME`) con una superficie mínima de diff: un único archivo fuente productivo
(`src/lib/rule-engine/conditions/amount.ts`).

La decisión arquitectónica aprobada por el usuario es **B — Magnitud + dirección explícita en
los tres motores**. La **Opción C NO es un contrato independiente**: es la implementación
concreta de este contrato en V2 vía normalización de magnitud dentro del evaluador
`conditions/amount.ts`. Este work item **no** debe describirse como "agregar `Math.abs()`"; es
la adopción del contrato formalizado en las secciones siguientes.

---

## Contrato formal

**El contrato, no un parche:**

1. **El signo del monto determina `transactionDirection`** (`debit` / `credit` / `any`). La
   dirección es una **propiedad de la regla** con **pre-filtro en el pipeline**, no una condición
   puntuable (paridad exacta con `rule-matching-engine.ts:159-160`,
   `rule-precedence-engine.ts:138-139` y `pipeline.ts:5-9`).

   | `direction` | Transacción elegible |
   |---|---|
   | `debit` | `amount < 0` (excluye `amount >= 0`) |
   | `credit` | `amount >= 0` (excluye `amount < 0`) |
   | `any` | sin filtro |

   `amount = 0` se trata como `credit` (decisión de paridad heredada de BRE-007, no se revisa acá).

2. **Las condiciones `amount_*` comparan MAGNITUDES.** Tanto el monto de la transacción como el
   valor de la condición (y los bounds en `amount_range`) se comparan por valor absoluto.

3. **La dirección se filtra ANTES de la evaluación de monto.** Un `amount_*` se evalúa solo sobre
   transacciones que ya pasaron el pre-filtro de signo. La dirección contraria demuestra que el
   descarte ocurre antes del monto (ver Tests obligatorios).

4. **Una regla con dirección `any` compara magnitud sin restringir signo.** Por contrato,
   `equals 150` matchea `-150` y `+150`: el monto es magnitud, la dirección es un eje aparte.

5. **Falsos matches fuera del contrato: ninguno.** No hay matches nuevos más allá de la semántica
   de magnitud; los motores productivos ya la tenían.

### Decisiones aprobadas (1–7)

| # | Decisión |
|---|---|
| 1 | V2 adopta comparación de magnitud en TODOS los operadores `amount_*` de `conditions/amount.ts`. |
| 2 | La normalización vive en el **EVALUADOR** (`conditions/amount.ts`), NO en el adapter (`conditions-normalizer.ts`). El evaluador es el **SSOT compartido** (usado por V2 y por Precedence vía `evaluateSingleCondition`). |
| 3 | `normalizeInputsForCompatibility` queda **intacta**: el doble `abs` es idempotente; simplificarla es limpieza fuera de alcance. |
| 4 | `amount_range` normaliza AMBOS bounds por magnitud **y los ordena** (espejo de `rule-precedence-compat.ts:61-68`), además de `tx.amount` por magnitud. Sin esto quedaría divergencia residual V2-vs-Precedence para rangos negativos. |
| 5 | Rango degenerado `[x, x]` ≡ **igualdad por magnitud** (preservar la semántica de `amount.ts:48-51` sobre magnitud). |
| 6 | **Fix de drift spec-fixture:** BRE-009 spec línea 100 dice `amount_equals 150`, pero el operador legacy real es `equals` sobre field `'amount'` (confirmado en `src/lib/types/shared.ts:10`; el tipo V2 es `amount_eq`, mapeado en `conditions-normalizer.ts:25`). `amount_equals` NO existe. Este spec (BRE-006) documenta el fix; el edit real a BRE-009 se hace **después** de la implementación (ver decisión 7 y Separación de commits). |
| 7 | El fixture de BRE-009 se actualiza **DESPUÉS** del cambio (M-1/M-3 → `SAME`, `fixtureVersion` recalculado, más los nuevos casos de operadores) — **NO antes**. |

### Restricción de ordenamiento (obligatoria)

La actualización del fixture de BRE-009 **debe estar en el mismo change** que el cambio de fuente
(o en el mismo PR/entrega): bajo la **regla de lectura crítica** de BRE-009
(`docs/specs/BRE-009-reproducible-shadow-measurement.md:359-362`), un vector diverge-expected que
produce `SAME` se lee como `FIXTURE_FAILURE`. Si el cambio de `amount.ts` aterriza sin actualizar
el fixture, el protocolo **falla**. Por eso el commit de fuente y el de fixture viajan juntos en
esta entrega.

---

## Semántica por operador

Los tres motores filtran por dirección **antes** del monto. La columna "dirección" del contrato
es el pre-filtro de `pipeline.ts:5-9` (V2), idéntico a Legacy/Precedence.

### Contrato V2 post-cambio (SSOT: `conditions/amount.ts`)

| op | entrada | Math.abs? | dirección | comparación | resultado (fórmula exacta) |
|---|---|---|---|---|---|
| `amount_gt` | `tx.amount` y `value` | SI, ambos lados | pre-filtro (antes del monto) | MAGNITUD | `abs(transaction.amount) > abs(condition.value)` |
| `amount_gte` | idem | SI, ambos lados | idem | MAGNITUD | `abs(transaction.amount) >= abs(condition.value)` |
| `amount_lt` | idem | SI, ambos lados | idem | MAGNITUD | `abs(transaction.amount) < abs(condition.value)` |
| `amount_lte` | idem | SI, ambos lados | idem | MAGNITUD | `abs(transaction.amount) <= abs(condition.value)` |
| `amount_eq` | idem | SI, ambos lados | idem | MAGNITUD | `abs(transaction.amount) === abs(condition.value)` |
| `amount_range` | bounds `abs+sort` + `tx.amount` abs | SI, bounds y tx | idem | MAGNITUD | normalizar ambos bounds con `abs`, ordenarlos como `min/max` y comparar inclusivamente: `min(abs(b1), abs(b2)) <= abs(transaction.amount) <= max(abs(b1), abs(b2))`; degenerado `[x,x]` → `abs(transaction.amount) === abs(x)` |

Notas de implementación:

- El score fuzzy de `amount_range` (`amount.ts:54`) se calcula sobre los valores **normalizados**
  (bounds abs+sort y `|tx.amount|`), de modo que Precedence —que ya normalizaba vía
  `normalizeInputsForCompatibility` antes de llamar al evaluador— produce el mismo `matchQuality`
  que V2 directo. Sin normalizar dentro del evaluador, el score divergiría entre las dos rutas.
- Precedence ya aplicaba `abs+sort` a los bounds (`rule-precedence-compat.ts:61-68`) antes de
  evaluar; con el evaluador normalizando por sí mismo, el doble paso es idempotente (decisión 3).
- `value` se normaliza por magnitud **después** de la coerción `toNumber` (`amount.ts:4-9`), que
  ya lanza `InvalidNumericValue` para valores no numéricos — ese guard no cambia.

### Por qué `amount_range` exige `abs+sort` (crítico)

Un rango `[-500, -100]` en V2 signed evalúa `tx.amount` contra los bounds tal cual
(`amount.ts:45-53`); Precedence lo convierte en `[100, 500]` (`rule-precedence-compat.ts:61-68`).
Sin normalizar los bounds en el evaluador, V2 seguiría divergiendo de Precedence para rangos
negativos — la misma clase de divergencia que BRE-006 elimina para `gt/lt/eq`. Por eso el contrato
define `abs+sort` de ambos bounds como parte del operador, no solo `|tx.amount|`.

---

## Casos de borde (Tests de contrato obligatorios de BRE-006)

Casos obligatorios para los **seis** operadores. No todos integran el gate estadístico original de
BRE-009 (ver Tests obligatorios): forman un bloque de contrato dedicado.

### `amount_gt` — valor 100

| ID | caso | tx | dirección regla | esperado | justificación |
|---|---|---|---|---|---|
| GT-1 | negativo que matchea por magnitud | `-200` | debit | **match** | `|-200| > |100|` |
| GT-2 | borde (estricto, no inclusivo) | `-100` | debit | **NO match** | `|-100| > |100|` = false |
| GT-3 | no debe matchear (monto fuera) | `+50` | credit | **NO match** | `50 > 100` = false |
| GT-4 | dirección compatible | `-150` | debit | **match** | `|-150| > |100|` |
| GT-5 | dirección contraria descartada ANTES del monto | `-200` | credit | **NO match** | pre-filtro credit exige `amount >= 0`; `-200` se descarta aunque `|-200| > 100` matchearía |

### `amount_gte` — valor 100

| ID | caso | tx | dirección regla | esperado | justificación |
|---|---|---|---|---|---|
| GTE-1 | negativo que matchea por magnitud | `-200` | debit | **match** | `|-200| >= |100|` |
| GTE-2 | borde (igualdad de frontera) | `-100` | debit | **match** | `|-100| >= |100|` |
| GTE-3 | no debe matchear (monto fuera) | `+50` | credit | **NO match** | `50 >= 100` = false |
| GTE-4 | dirección compatible | `-100` | debit | **match** | `|-100| >= |100|` |
| GTE-5 | dirección contraria descartada ANTES del monto | `-100` | credit | **NO match** | pre-filtro credit descarta `-100` aunque `|-100| >= 100` matchearía |

### `amount_lt` — valor 200

| ID | caso | tx | dirección regla | esperado | justificación |
|---|---|---|---|---|---|
| LT-1 | negativo que matchea por magnitud | `-150` | debit | **match** | `|-150| < |200|` |
| LT-2 | borde (estricto, no inclusivo) | `-200` | debit | **NO match** | `|-200| < |200|` = false |
| LT-3 | no debe matchear (monto fuera) | `+250` | credit | **NO match** | `250 < 200` = false |
| LT-4 | dirección compatible | `-150` | debit | **match** | `|-150| < |200|` |
| LT-5 | dirección contraria descartada ANTES del monto | `-150` | credit | **NO match** | pre-filtro credit descarta `-150` aunque `|-150| < 200` matchearía |

### `amount_lte` — valor 200

| ID | caso | tx | dirección regla | esperado | justificación |
|---|---|---|---|---|---|
| LTE-1 | negativo que matchea por magnitud | `-150` | debit | **match** | `|-150| <= |200|` |
| LTE-2 | borde (igualdad de frontera) | `-200` | debit | **match** | `|-200| <= |200|` |
| LTE-3 | no debe matchear (monto fuera) | `+250` | credit | **NO match** | `250 <= 200` = false |
| LTE-4 | dirección compatible | `-200` | debit | **match** | `|-200| <= |200|` |
| LTE-5 | dirección contraria descartada ANTES del monto | `-200` | credit | **NO match** | pre-filtro credit descarta `-200` aunque `|-200| <= 200` matchearía |

### `amount_eq` — valor 150

| ID | caso | tx | dirección regla | esperado | justificación |
|---|---|---|---|---|---|
| EQ-1 | negativo que matchea por magnitud | `-150` | debit | **match** | `|-150| === |150|` |
| EQ-2 | borde (simetría del contrato) | `+150` | credit | **match** | `|+150| === |150|` — "equals 150" matchea `-150` y `+150` |
| EQ-3 | no debe matchear (monto distinto) | `-149` | any | **NO match** | `|-149| === |150|` = false |
| EQ-4 | dirección compatible | `-150` | any | **match** | magnitud sin restricción de signo |
| EQ-5 | dirección contraria descartada ANTES del monto | `-150` | credit | **NO match** | pre-filtro credit descarta `-150` aunque `|-150| === 150` matchearía |

### `amount_range` — bounds `[100, 500]` (salvo casos que redefinen bounds)

| ID | caso | bounds | tx | dirección regla | esperado | justificación |
|---|---|---|---|---|---|---|
| RNG-1 | bounds positivos | `[100, 500]` | `+200` | any | **match** | `200` ∈ `[100, 500]` |
| RNG-2 | bounds negativos | `[-500, -100]` | `-200` | any | **match** | `abs+sort` → `[100, 500]`; `|-200|` = 200 ∈ `[100, 500]` (**caso crítico**) |
| RNG-3 | bounds invertidos (min > max) | `[500, 100]` | `+200` | any | **match** | `abs+sort` → `[100, 500]`; `200` ∈ `[100, 500]` |
| RNG-4 | rango degenerado (matchea) | `[150, 150]` | `-150` | any | **match** | `|a| === |x|` → `150 === 150` |
| RNG-5 | rango degenerado (no matchea) | `[150, 150]` | `-149` | any | **NO match** | `149 === 150` = false |
| RNG-6 | valor dentro | `[100, 500]` | `+300` | any | **match** | `300` ∈ `[100, 500]` |
| RNG-7 | valor fuera por arriba | `[100, 500]` | `+600` | any | **NO match** | `600 > 500` |
| RNG-8 | valor fuera por abajo | `[100, 500]` | `+50` | any | **NO match** | `50 < 100` |
| RNG-9 | dirección compatible | `[100, 500]` | `-200` | debit | **match** | `|-200|` ∈ `[100, 500]` |
| RNG-10 | dirección contraria descartada ANTES del monto | `[100, 500]` | `-200` | credit | **NO match** | pre-filtro credit descarta `-200` aunque su magnitud matchearía el rango |

Total de casos de contrato: **35** — 5 operadores de comparación × 5 casos cada uno = **25** + **10**
de `amount_range` (bounds positivos, bounds negativos, bounds invertidos, rango degenerado que
matchea, rango degenerado que no matchea, valor dentro, valor fuera por arriba, valor fuera por
abajo, dirección compatible, dirección contraria). `25 + 10 = 35`.

---

## Línea base BRE-009 (pre cambio)

Estado verificado en la exploración (commit `5f0364d3f9ce4b56fd28e65fb5dab76e44318f83`):

| Métrica | Valor |
|---|---|
| `fixtureVersion` | `fnv1a-4c99a7c8380b` |
| commit | `5f0364d` |
| Gate BRE-006 | **ABIERTO** (M-1/M-3 → `V2_NO_MATCH_PRECEDENCE_MATCH`, atribuible sin confound a signed-vs-magnitud) |
| Eje A — `legacyPrecedenceAgreementRate` | **11/12** (91.7%); divergencia W-1 (`PRODUCTIVE_MATCH_CANONICAL_NO_MATCH`) |
| Eje B — `v2PrecedenceAgreementRate` | **8/12** (66.7%) |
| Eje B — `v2DivergenceCount` | **3** (M-1, M-3 → `V2_NO_MATCH_PRECEDENCE_MATCH`; R-1 → `DIFFERENT_WINNER`) |
| Eje B — `v2ErrorCount` | **1** (X-1 → `V2_ERROR`, `engine_execution_error`) |
| Eje B — `v2ErrorRate` | 1/12 |
| `precedenceErrorRate` | 0 (hecho medido) |
| Controles | todos PASS; `runValid: true`; 12/12 tests |

Causa de la divergencia M-1/M-3 (sin confound):

- **M-1** (R-AMT1 debit + `amount_greater 100`, tx `-200`): pasa el pre-filtro debit en los tres
  motores antes del monto. Legacy/Precedence: `|-200| > |100|` → WINNER. V2 signed: `-200 > 100`
  → false → `V2_NO_MATCH_PRECEDENCE_MATCH`.
- **M-3** (R-AMT2 `any` + `equals 150`, tx `-150`): Legacy/Precedence: `|-150| === |150|` →
  WINNER. V2 signed: `-150 === 150` → false → `V2_NO_MATCH_PRECEDENCE_MATCH`.

---

## Resultado postesperado

Confirmado por el run post-implementación (`tests/measure-rule-parity.test.ts`, fixture
`fnv1a-2c2a9680ae63`): los valores de esta sección coinciden con la medición real. Con V2
comparando magnitud (contrato adoptado):

| Vector | Eje A (post) | Eje B (post) |
|---|---|---|
| M-1 | `SAME_WINNER` | **`SAME`** (antes `V2_NO_MATCH_PRECEDENCE_MATCH`) |
| M-3 | `SAME_WINNER` | **`SAME`** (antes `V2_NO_MATCH_PRECEDENCE_MATCH`) |
| Resto de vectores | sin cambio | sin cambio |

Detalle M-1 post: `|-200| > |100|` → Legacy WINNER / Precedence WINNER / V2 **matched**. Detalle
M-3 post: `|-150| === |150|` → V2 **matched**.

| Métrica | Antes | Después |
|---|---|---|
| Eje A — `legacyPrecedenceAgreementRate` | 11/12 | **11/12 (sin cambio)** |
| Eje B — `v2PrecedenceAgreementRate` | 8/12 | **10/12 (83.3%)** |
| Eje B — `v2DivergenceCount` | 3 | **1** (solo R-1 → `DIFFERENT_WINNER`) |
| Eje B — `v2ErrorCount` | 1 | **1** (X-1, sin cambio) |
| Eje B — `v2ErrorRate` | 1/12 | 1/12 |
| `fixtureVersion` | `fnv1a-4c99a7c8380b` | **`fnv1a-2c2a9680ae63`** (recalculado; hash real del run post-implementación) |

Sanidad contable post: eje B `10 acuerdos + 1 divergencia + 1 error = 12`; eje A
`11 acuerdos + 1 divergencia = 12`. `recall_c = 1` y `falsePositive_c = 0` en las 6 categorías.

Métricas no señal de BRE-006 (permanecen como hechos, `docs/specs/BRE-009-...:374-379`): R-1
(ranking), W-1 (wildcard), X-1 (regex/error).

---

## Riesgos

`Riesgo productivo actual bajo porque V2 no es el motor predeterminado; riesgo de compatibilidad
medio para ejecuciones explícitas de V2 y para futuras reglas dependientes de semántica signed.`

Riesgos concretos asociados al cambio:

1. **V2 no es el motor predeterminado** (detrás del flag de BRE-001): ninguna decisión productiva
   depende de este cambio. Las ejecuciones explícitas de V2 (shadow) pasan de signed a magnitud;
   ahí el riesgo es medio: cualquier regla amount creada asumiendo signed dejaría de matchear como
   esperaba su autor. Es un riesgo de compatibilidad para reglas **futuras** que dependan de
   semántica signed — el contrato documenta que esa semántica no existe.
2. **Doble `abs` idempotente:** Precedence normaliza por magnitud y luego el evaluador vuelve a
   normalizar. Sin cambio de comportamiento (decisión 3); verificado por la suite existente.
3. **Flip de ranking por score fuzzy de `amount_range` (`amount.ts:54`):** teórico; el score se
   calcula sobre valores normalizados (idéntico en ambas rutas). `matchQuality` de Precedence no
   cambia porque `normalizeInputsForCompatibility` ya normalizaba antes del evaluador. Ningún
   vector del fixture depende de este score.
4. **Regresiones en tests V2 existentes:** los tests actuales de `conditions/amount` usan montos
   positivos, donde signed ≡ magnitud; no se rompen. La matriz de contrato los extiende a negativos.
5. **Gate ABIERTO si el fixture no se actualiza en el mismo change:** por la regla de lectura
   crítica, M-1/M-3 produciendo `SAME` con expectativa diverge → `FIXTURE_FAILURE` (ver
   Restricción de ordenamiento).

---

## Archivos autorizados

### Modificar (después de aprobación, no en esta fase)

- `src/lib/rule-engine/conditions/amount.ts` — **único archivo fuente productivo**: magnitud en
  `gt/gte/lt/lte/eq` (`|tx.amount|` y `|value|`) y `abs+sort` de bounds + `|tx.amount|` en
  `amount_range`, con degenerado `[x,x]` → igualdad por magnitud.
- `tests/measure-rule-parity.test.ts` — M-1/M-3 → `SAME` + `fixtureVersion` recalculado + bloque
  de tests de contrato (ver Tests obligatorios).
- `docs/specs/BRE-009-reproducible-shadow-measurement.md` — **después** de la implementación:
  fix de drift línea 100 (`amount_equals` → `equals`), actualización de la matriz esperada para
  M-1/M-3 y de las métricas del eje B, nota de recálculo de `fixtureVersion`.
- `docs/architecture/TDR-001-amount-semantics.md` — anexo documentando el contrato aprobado
  (opcional).

### Crear

- `docs/specs/BRE-006-amount-semantics-contract.md` (este documento).

## Archivos prohibidos

- `package.json` y cualquier cambio de dependencias/scripts.
- Cualquier otro archivo `src/`, en particular:
  - `src/lib/services/rule-matching-engine.ts` (Legacy),
  - `src/lib/services/rule-precedence-engine.ts`, `rule-precedence-compat.ts`,
    `rule-precedence-shadow.ts`, `rule-precedence-adapters.ts` (Precedence),
  - `src/lib/services/rule-engine-adapter/conditions-normalizer.ts` (adapter — la normalización
    vive en el evaluador, decisión 2),
  - `src/lib/rule-engine/pipeline.ts`, `specificity.ts`, `ranking.ts`, `decision.ts`, `scoring.ts`,
    `compat.ts`.
- Schema Prisma y migraciones.
- APIs (route handlers, endpoints).
- Observabilidad persistente.
- Feature flags; activación de V2 como default.
- Dirección (BRE-007), normalización de descripción (BRE-008), ranking/specificity, wildcard,
  regex — NO se tocan.
- Legacy/Precedence: sin `Math.abs` adicional ni remoción.

---

## Tests obligatorios

### Bloque 1 — Tests de contrato BRE-006 (obligatorios, nuevos)

Los **35 casos** de la sección "Casos de borde" cubren los **seis** operadores y las **diez**
situaciones de `amount_range` (bounds positivos, bounds negativos, bounds invertidos, rango
degenerado que matchea, rango degenerado que no matchea, valor dentro, valor fuera por arriba,
valor fuera por abajo, dirección compatible, dirección contraria), cada uno con: negativo que
matchea por magnitud, caso de borde, caso que NO debe matchear, dirección compatible, y dirección
contraria descartada **antes** de la evaluación de monto.

**Ubicación elegida:** nuevo bloque `describe` al final de `tests/measure-rule-parity.test.ts`,
dejando intacta la estructura del gate de 12 vectores de BRE-009. Rationale: (a) permanece dentro
del único archivo de test autorizado por el alcance; (b) el gate hermético de BRE-009 no se
reestructura — el bloque de contrato es un `describe` autocontenido, ejecutable de forma
independiente con `vitest -t`; (c) superficie mínima (filosofía de diff mínima de la propuesta:
1 archivo fuente + tests). Alternativa descartada: archivo de test nuevo — expandiría el alcance
sin ganancia estructural, ya que los tests de contrato son de paridad de motor y conviven con el
harness que construye las mismas reglas/transacciones.

Cada caso de dirección contraria debe demostrar, con aserciones explícitas, que el descarte ocurre
**por el pre-filtro de dirección y no por el monto** (p. ej. `amount_gt 100` con regla credit y tx
`-200`: NO match, aunque `|-200| > 100`). Criterios obligatorios para TODOS los casos de dirección
contraria (GT-5, GTE-5, LT-5, LTE-5, EQ-5, RNG-10):

- **cero candidatos después del pre-filtro:** el runner descarta la regla por dirección antes de
  puntuar ninguna condición (assert sobre el `reason`/`candidates` del resultado);
- **cero condiciones de monto evaluadas:** no se ejecutó ningún evaluador de `conditions/amount.ts`
  para esa regla (assert sobre el número de condiciones evaluadas, p. ej. `evaluatedConditions`
  vacío o contador de invocaciones);
- **descarte anterior a `conditions/amount.ts`:** el punto de corte es el pre-filtro de dirección
  (`pipeline.ts:5-19` en V2), no un comparador de monto. Si la implementación hiciera la comparación
  y solo luego descartara, el test falla.

**Estos tres criterios son invariantes del contrato**, no detalles de implementación: si en el futuro
cambia el pipeline interno (reordenamiento de pasos, refactor del runner, nuevas rutas de
evaluación), el comportamiento observable de dirección contraria debe seguir siendo exactamente este —
cero candidatos tras el pre-filtro, cero evaluaciones de monto, descarte previo a
`conditions/amount.ts`.

### Bloque 2 — Gate BRE-009 (actualización, obligatoria)

- M-1 y M-3: expectativa `V2_NO_MATCH_PRECEDENCE_MATCH` → **`SAME`** (eje B) y `SAME_WINNER`
  (eje A), recalculando `fixtureVersion`.
- Los 5 controles deben seguir PASS; los 12 vectores y las métricas derivadas se recalculan desde
  la matriz (las cifras no son constantes independientes).
- Este gate permanece como protocolo de medición; los casos de contrato del Bloque 1 **no**
  necesitan integrar el dataset de 12 vectores.

### Verificación estándar del repo

- `npx tsc --noEmit` exitoso.
- `npm run lint` sin errores nuevos.
- Suite completa (`npx vitest run`) sin regresiones.

---

## Gate BRE-006

Cerrar el gate de BRE-006 significa:

- **Contrato satisfecho:** V2 compara magnitud en los seis `amount_*` (contrato formal adoptado) y
  el bloque de 35 casos de contrato es verde.
- **Paridad restaurada en la medición:** M-1/M-3 pasan a `SAME`, `v2PrecedenceAgreementRate`
  8/12 → 10/12, `v2DivergenceCount` 3 → 1 (R-1) en el fixture actualizado.
- **BRE-009 sigue siendo el protocolo de medición** de conformance (gate M-1/M-3 es el flanco de
  "resuelto" del TDR-001). BRE-006 no reemplaza ni reestructura ese protocolo; lo satisface.

El gate **no** se considera cerrado por eliminar la señal de M-1/M-3 del fixture: se cierra porque
el contrato adoptado hace que los tres motores produzcan el mismo resultado, con controles
intactos y `recall_c = 1` / `falsePositive_c = 0`.

---

## Rollback

Cambio atómico y trivial:

- Sin DB, sin schema, sin flags productivos, sin migraciones.
- Superficie: 1 archivo fuente (`amount.ts`) + tests + docs.
- `git revert <commit> --no-edit` (por commit, en orden inverso) revierte la entrega completa.
- Re-ejecutar `npx vitest run tests/measure-rule-parity.test.ts` restaura la línea base
  (`fixtureVersion` `fnv1a-4c99a7c8380b`).
- No hay daño productivo posible previo al rollback: V2 no es default.

---

## Definition of Done

- [ ] `conditions/amount.ts`: magnitud en `gt/gte/lt/lte/eq` (`|a|` vs `|v|`)
- [ ] `amount_range`: bounds `abs+sort` + `|tx.amount|`; degenerado `[x,x]` ≡ igualdad por magnitud
- [ ] Normalización en el evaluador (SSOT), NO en el adapter; `normalizeInputsForCompatibility` intacta
- [ ] Bloque de tests de contrato (35 casos: seis operadores + diez situaciones de range) verde,
      con dirección contraria descartada por pre-filtro antes del monto (cero candidatos, cero
      condiciones de monto evaluadas, descarte anterior a `conditions/amount.ts`)
- [ ] Gate BRE-009: M-1/M-3 → `SAME`; `v2PrecedenceAgreementRate` 8/12 → 10/12;
      `v2DivergenceCount` 3 → 1; `v2ErrorCount` 1 (X-1); eje A sin cambio
- [ ] `fixtureVersion` recalculado en el mismo change que el cambio de fuente
- [ ] Fix de drift BRE-009: línea 100 `amount_equals` → `equals` + matriz esperada actualizada
- [ ] Controles de BRE-009 PASS (run válido); `recall_c = 1`, `falsePositive_c = 0`
- [ ] TDR-001 anexado con el contrato aprobado (opcional)
- [ ] `npx tsc --noEmit` exitoso · `npm run lint` sin errores nuevos · suite completa sin regresiones
- [ ] Zero cambios en archivos prohibidos (Legacy, Precedence, adapter, pipeline, ranking,
      schema, flags, APIs)
- [ ] `git status` limpio salvo por los archivos autorizados + este spec
- [ ] Este spec actualizado a `Approved` cuando el usuario lo autorice

---

## Separación de commits propuesta

Estrategia en 2 commits que **evita el estado rojo intermedio** y respeta "tests con código":

1. `feat(rule-engine): adopt magnitude amount contract in V2 (BRE-006)`
   — `src/lib/rule-engine/conditions/amount.ts` (magnitud en los 6 operadores) + bloque de
   tests de contrato + actualización del fixture de BRE-009 (M-1/M-3 → `SAME`, `fixtureVersion`
   recalculado) en `tests/measure-rule-parity.test.ts`. **Verde en su totalidad**: el fixture
   viaja con el cambio de fuente (Restricción de ordenamiento).
2. `docs(rule-engine): fix BRE-009 amount operator drift and document amount contract (BRE-006)`
   — `docs/specs/BRE-009-reproducible-shadow-measurement.md` (fix de drift `equals` en línea 100 +
   matriz y métricas del eje B + nota de recálculo) + anexo en
   `docs/architecture/TDR-001-amount-semantics.md` (contrato aprobado). Solo docs, verde.

La variante sugerida en el prompt (commit 1 solo fuente+tests de contrato; commit 2 fixture+docs)
se descarta porque dejaría `tests/measure-rule-parity.test.ts` rojo (`FIXTURE_FAILURE`) al cierre
del commit 1: el fixture y la fuente deben viajar juntos.

---

## Relación con la secuencia BRE

1. ✅ BRE-001 (shadow estable)
2. ✅ BRE-007 (dirección como concepto de primer orden en V2)
3. ✅ BRE-008 (paridad de normalización de texto de descripción)
4. ✅ BRE-009 (protocolo reproducible de medición de conformance)
5. 🔄 **BRE-006 (este work item):** adoptar el contrato de monto (magnitud + dirección explícita)
   que cierra M-1/M-3
6. 🔜 Shadow mode prolongado / deprecación del motor legacy (TDR-001: pasos 7–9)
