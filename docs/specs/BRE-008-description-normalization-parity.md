# BRE-008: Description Normalization Parity

- **ID:** BRE-008
- **Status:** Approved — implemented and verified
- **Base:** BRE-001, BRE-007
- **TDR relacionados:** TDR-001 (Amount Semantics — diferido a BRE-006)

---

## Objetivo

Unificar la normalización de texto de las condiciones de **descripción** entre Legacy, Precedence y
V2 directo, sin mezclar cambios de dirección (BRE-007) ni de monto (BRE-006).

La divergencia se detectó durante la auditoría read-only de BRE-007: el V2 evalúa
`description_contains` de forma case-sensitive, mientras Legacy y Precedence normalizan a
minúsculas + trim + colapso de espacios antes de comparar.

---

## Evidencia del hallazgo (auditoría read-only, 2026-07-31)

Regla real en `accountexpress` (`BankRule` con `transactionDirection='debit'`,
`conditions=[{"field":"description","operator":"contains","value":"omar mira"}]`), probada con la
misma transacción cambiando únicamente el case (`amount=-150` para que la dirección pase en los 3):

| desc | V2 adapter | V2 evaluador SSOT | Legacy | Precedence |
|---|---|---|---|---|
| `OMAR MIRA` | `pending` | `match:false` | ELEGIBLE | WINNER |
| `omar mira` | `matched` | `match:true` | ELEGIBLE | WINNER |

- **V2 (case-sensitive):** `src/lib/rule-engine/conditions/description.ts:11-21`,
  `evaluateDescriptionContains`, comparación cruda `desc.includes(value)` (línea 18). Sin
  `toLowerCase`, sin trim, sin colapso de espacios. Aplica igual a `description_eq` (línea 7),
  `starts_with` (línea 26) y `ends_with` (línea 34).
- **Legacy (case-insensitive):** `src/lib/services/rule-matching-engine.ts:29-42`, función local
  `evaluateCondition`; líneas 41-42 normalizan ambos lados
  (`String(...).toLowerCase().trim().replace(/\s+/g,' ')`) antes del `includes` (líneas 56-57).
- **Precedence (case-insensitive):** `src/lib/services/rule-precedence-engine.ts:50-61`
  (`evaluateSingleCondition`) → `normalizeInputsForCompatibility`
  (`rule-precedence-compat.ts:45-83`, rama `description_*` líneas 52-60) → `normalizeText`
  (`rule-precedence-compat.ts:14-16`) y recién ahí el evaluador V2 SSOT.
- **Anterioridad:** `conditions/description.ts` no cambió desde `ca61ff6` (2026-07-12). Ni BRE-001
  ni BRE-007 lo tocaron (`git show --stat` vacío). La divergencia es de contrato de normalización,
  no de dirección.

---

## Alcance

### Operadores cubiertos

- `description_contains`
- `description_eq`
- `description_starts_with`
- `description_ends_with`

### Operadores fuera de alcance (justificado)

- `description_matches` (regex): Legacy no tiene operador regex (`rule-matching-engine.ts:50-72` no
  contempla `matches`); Precedence excluye `description_matches` de la normalización
  (`rule-precedence-compat.ts:52`) y V2 lo evalúa crudo (`conditions/description.ts:37-47`). La
  paridad Precedence = V2 **ya se cumple** en regex. Normalizar el patrón rompería su semántica
  (p. ej. `[A-Z]` dejaría de funcionar). Se deja crudo en ambos y se documenta.
- Condiciones de `amount_*`: reservadas a BRE-006 (semántica signed vs magnitud).
- `entity_*`: fuera de alcance (no son texto de descripción).
- Dirección (`transactionDirection`): BRE-007, ya cerrado.

### Dimensiones de normalización analizadas

| Dimensión | Legacy | Precedence | V2 directo | Propuesta BRE-008 |
|---|---|---|---|---|
| Mayúsculas/minúsculas | `toLowerCase()` | `toLowerCase()` | none | `toLowerCase()` en los 4 operadores |
| Trim | sí | sí | no | sí |
| Espacios múltiples | colapsa a 1 | colapsa a 1 | no | colapsa a 1 |
| Valor vacío tras normalizar | `return false` (línea 45) | idem (vía V2 tras normalizar) | `match = value.length === 0` (guard, `description.ts:15`) | **alinear: valor vacío → no matchea** |
| Wildcard `*` | matchea cualquier no vacío (líneas 47-48) | no (literal) | no (literal) | **detectado; decisión diferida (ver Riesgos)** |
| No-string (`value` numérico) | `String(...)` | `String(...)` (`normalizeText`) | `String(condition.value)` | `String(...)` en `normalizeText` |
| Unicode (case folding) | `toLowerCase()` (aware) | ídem | none | `toLowerCase()` (misma semántica) |
| Acentos/diacríticos (é vs e) | sin plegado | sin plegado | sin plegado | **no agregar plegado** (ningún motor lo hace) |

Nota Unicode compuesto/descompuesto: no existe `.normalize()` (NFC/NFD) en todo `src` (verificado con grep).
`toLowerCase()` hace case folding Unicode pero NO unifica secuencias: `É` (compuesto U+00C9) y `E\u0301`
(descompuesto) NO coinciden en ninguno de los tres motores. La paridad es "no match en los 3"; no se
agrega normalización de composición en este work item.

---

## Diseño propuesto: función única reutilizable

**Se propone centralizar.** Hoy la lógica ya existe duplicada: `normalizeText` en
`rule-precedence-compat.ts:14-16` y una copia inline en `rule-matching-engine.ts:41-42`; el V2 no la
aplica. Tres copias de una regla que debe ser idéntica es la causa raíz de la deriva.

**Función propuesta** (ubicación sugerida: `src/lib/rule-engine/conditions/normalize.ts`):

```ts
export function normalizeText(val: string | number): string {
  return String(val).toLowerCase().trim().replace(/\s+/g, ' ');
}
```

**Aplicación por motor:**

1. **V2** (`conditions/description.ts`): normalizar `transaction.description` y `condition.value`
   dentro de `description_eq`, `description_contains`, `description_starts_with`,
   `description_ends_with`. NO aplicar a `description_matches`. Es el único cambio de
   **comportamiento** del work item.
2. **Legacy** (`rule-matching-engine.ts:41-42`): reemplazar la normalización inline por la función
   compartida. **Comportamiento idéntico** (refactor neutro).
3. **Precedence** (`rule-precedence-compat.ts:14-16` y `:52-60`): reemplazar `normalizeText` local
   por la compartida. **Comportamiento idéntico** (refactor neutro).

**Alineación de borde obligatoria:** el guard de valor vacío tras normalizar debe quedar igual en
los 3 motores (`valor vacío → no matchea`, como Legacy). Sin esto, un `value` de solo espacios
matchearía en V2 y no en Legacy/Precedence.

Justificación de NO mantener copias: el V2 ya demostró la deriva en producción de la regla real;
una única fuente evita que la próxima corrección vuelva a asimetrizarse.

---

## Archivos afectados

### Modificar

- `src/lib/rule-engine/conditions/description.ts` — aplicar normalización a los 4 operadores.
- `src/lib/services/rule-matching-engine.ts` — usar función compartida (refactor neutro, solo
  líneas 40-42).
- `src/lib/services/rule-precedence-compat.ts` — usar función compartida (refactor neutro, solo
  `normalizeText` y su uso en `:52-60`).

### Crear

- `src/lib/rule-engine/conditions/normalize.ts` — función compartida (o ubicación equivalente que
  ambos lados puedan importar sin ciclos).
- `docs/specs/BRE-008-description-normalization-parity.md` (este documento).
- Tests de paridad y de shadow (ver Tests obligatorios).

### NO modificar

- `src/lib/rule-engine/conditions/amount.ts` (BRE-006).
- `src/lib/rule-engine/specificity.ts`, `ranking.ts`, `decision.ts`, `scoring.ts`, `compat.ts`.
- `src/lib/services/rule-precedence-engine.ts` (su lógica no cambia; solo cambia la util que importa).
- `prisma/schema.prisma` y migraciones; `src/lib/rule-engine/flag.ts`.
- `conditions-normalizer.ts` (mapeo de formato V1→V2; no es normalización en runtime).

---

## Riesgo de compatibilidad

1. **Cambio de comportamiento de V2 (esperado):** el shadow V2 dejará de reportar divergencias por
   case/espacios. Es el objetivo. V2 no es default, así que no impacta decisiones productivas.
2. **Refactor de Legacy/Precedence:** toca código productivo. Debe ser estrictamente neutro
   (misma función, mismas líneas de invocación) y quedar cubierto por la suite existente
   (2091 tests al momento de escribir esto).
3. **Regex (`description_matches`):** se excluye de la normalización a propósito; cualquier regla
   que dependa de case en regex sigue cruda en Precedence y V2 (paridad preservada).
4. **Wildcard `*` (Legacy-only):** Legacy trata `value='*'` como "cualquier no vacío"
   (`rule-matching-engine.ts:47-48`); V2 y Precedence lo tratan literalmente. Es una divergencia de
   **semántica**, no de normalización. Se detecta, se documenta y su resolución **se difiere** a una
   decisión explícita (podría ser un work item propio), porque definirlo como paridad requeriría
   cambiar Legacy o V2/Precedence con consecuencias de negocio.
5. **Acentos/diacríticos:** no se agrega plegado (é≠e en los 3). Agregarlo solo a V2 crearía una
   divergencia nueva.
6. **Valor vacío/espacios:** sin la alineación del guard, V2 matchearía donde Legacy/Precedence no.

---

## Impacto en reglas existentes

- La base local de desarrollo (`accountexpress`) tiene 1 regla (`contains`, value `omar mira`);
  sin cambios de datos ni de schema, el impacto es de evaluación en runtime.
- Reglas existentes creadas con Legacy (mayúsculas/espacios no normalizados al guardarse) **ya se
  evaluaban case-insensitive** en producción; V2 pasar a hacer lo mismo restaura paridad, no la rompe.
- Ninguna migración ni reescritura de datos: solo cambia el comparador en runtime.

---

## Tests de paridad obligatorios

Matriz: misma regla + misma transacción → mismo resultado en Legacy, Precedence y V2.

1. `contains` case: `UPPER` vs `lower` vs `Mixed` → match en los 3.
2. `eq` case + trim: `  OMA R MIRA  ` vs valor con espacios → match en los 3.
3. `starts_with` / `ends_with` con case y espacios → match en los 3.
4. `contains` con espacios múltiples internos (`oma   mira`) → match en los 3.
5. Valor de solo espacios / vacío → **no match en los 3**.
5b. **Test de contrato del guard (semántica, no normalización):** se escribe PRIMERO en el commit 2,
   documentando el contrato esperado — valor vacío o de solo espacios tras normalizar NO matchea en
   Legacy, Precedence ni V2 — antes de tocar `description.ts`. Define el comportamiento, no lo
   copia implícitamente de Legacy.
6. `value` numérico (no-string) → coerción `String()` consistente en los 3.
7. Unicode case: `É` vs `é` → match en los 3; `é` vs `e` (acento) → no match en los 3.
8. `description_matches` (regex): crudo e igual en Precedence y V2 (Legacy n/a).
9. Shadow V2: transacción que antes divergía solo por case → ahora `SAME_WINNER` / sin evento de
   divergencia.
10. Regresión: suite completa sin cambios en condiciones de monto ni dirección.

---

## Rollback

Sin cambios de schema ni de datos, el rollback es trivial (igual que BRE-007):

```bash
git revert HEAD --no-edit   # por commit, en orden inverso
```

---

## Definition of Done

- [x] `normalizeText` compartida utilizada por V2, Legacy y Precedence
- [x] V2 `description_eq/contains/starts_with/ends_with` case-insensitive + trim + colapso de espacios
- [x] Guard de valor vacío alineado (vacío → no match) en los 3
- [x] `description_matches` intacto (crudo, sin normalizar)
- [x] Matriz de 10 tests de paridad verde
- [x] Test de integración shadow: sin divergencia por case
- [x] `npx tsc --noEmit` exitoso · `npm run lint` sin errores nuevos
- [x] Suite completa (`npx vitest run`) sin regresiones
- [x] `npm run build` exitoso
- [ ] `git status` limpio
- [x] Zero cambios en monto/schema/flags/ranking/dirección
- [x] Este spec actualizado a `Approved` cuando el usuario lo autorice

---

## Separación de commits

Estrategia en 2 fases para separar refactor puro de cambio funcional (facilita `git bisect` y
`git revert`):

1. `refactor(rule-engine): extract shared normalizeText without behavior change`
   — `normalize.ts` (SSOT nueva) + `rule-matching-engine.ts` y `rule-precedence-compat.ts`
   (reemplazo **neutro** por la función compartida) + tests de regresión que prueban que el
   comportamiento es idéntico al previo.
2. `feat(rule-engine): normalize description conditions in V2 (BRE-008)`
   — `conditions/description.ts` (aplica la SSOT a `eq/contains/starts_with/ends_with`), guard de
   valor vacío alineado, tests de paridad V2 + **test de contrato del guard** (ver Tests 5/5b) +
   test de shadow sin divergencia por case + spec a `Implemented — pending final approval`.

---

## Relación con el shadow y con BRE-006

Secuencia acordada:

1. ✅ BRE-001 (shadow estable)
2. ✅ BRE-007 (dirección como concepto de primer orden en V2)
3. 🔄 **BRE-008 (este work item):** paridad de normalización de texto de descripción
4. Ejecutar el shadow con V2 comparable en dirección **y** texto (case/espacios)
5. Medir divergencias restantes (ahora dominadas por la semántica del monto)
6. 🔜 **BRE-006:** decidir el contrato de monto con esa evidencia

BRE-008 es condición para que las métricas del shadow no se contaminen por case/espacios antes de
usarlas en la decisión de BRE-006. No anticipa esa decisión: no toca evaluadores de monto ni
`Math.abs()`.

### Divergencias del shadow que desaparecerían con BRE-008

- `V2_NO_MATCH_PRECEDENCE_MATCH` y `V2_PENDING_PRECEDENCE_MATCH` causadas únicamente por case/trim/
  espacios (p. ej. el probe de la regla real: `OMAR MIRA` → V2 pending vs Precedence WINNER).
- Casos `DIFFERENT_WINNER` donde la única diferencia entre dos reglas candidatas era el case de la
  descripción.

### Divergencias que seguirían existiendo (fuera de BRE-008)

- **Monto:** V2 signed vs Legacy/Precedence magnitud (`Math.abs`) — objetivo de BRE-006.
- **Ranking/specificity:** Precedence suma +20 por dirección definida (`rule-precedence-engine.ts:79-88`)
  y usa un mapa de puntos plano (`CONDITION_SPECIFICITY`, `:65-75`); V2 usa tier/weight
  (`specificity.ts:7`). Los empates dirección-vs-`any` y las diferencias de peso pueden producir
  `DIFFERENT_WINNER` — corresponden a un work item de paridad de ranking, no a normalización.
- **Wildcard `*` Legacy-only:** si una regla usa `value='*'`, Legacy matchea (cualquier no vacío) y
  V2/Precedence lo tratan literal — divergencia semántica documentada, decisión diferida.
- **Regex:** `description_matches` queda crudo (Precedence = V2); si el patrón lanza `InvalidRegex`,
  V2 devuelve `V2_ERROR` (`events.ts:37-39`).

---

## Aclaración signed/magnitude

Este work item **no modifica** la semántica del monto. Toda condición de `amount_*` queda reservada
a BRE-006, incluyendo el uso de `Math.abs()` en Legacy y Precedence y la comparación signed del V2.
