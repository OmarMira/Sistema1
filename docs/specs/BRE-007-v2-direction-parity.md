# BRE-007: V2 Direction Parity — `transactionDirection` como concepto de primer orden en V2

- **ID:** BRE-007
- **Status:** Approved — implementado y verificado
- **Base:** ADR-009, BRE-001
- **TDR relacionados:** TDR-001 (Amount Semantics — diferido a BRE-006)

---

## Objetivo

Eliminar la divergencia estructural causada porque Legacy y Precedence filtran por dirección
(`transactionDirection`) mientras V2 la ignora por completo. Corregir **paridad de elegibilidad**
del V2 respecto de los motores productivos, para que las métricas del shadow mode reflejen
principalmente la semántica del monto y no una limitación estructural del motor.

Este trabajo **no cambia** la semántica signed/magnitude del monto, los evaluadores de monto,
`Math.abs()` ni el contrato de monto (reservado a BRE-006).

---

## Evidencia agregada obtenida de la base local de desarrollo (`accountexpress`)

Consulta read-only ejecutada el 2026-07-31 sobre la base local a la que apunta la app en este
entorno de desarrollo (`.env` → `accountexpress`), ejecutada con `BEGIN TRANSACTION READ ONLY;
... ROLLBACK;`, únicamente `SELECT` agregados, sin datos individuales:

| Métrica | Valor |
|---|---|
| A1 — Total de reglas (`BankRule`) | **0** |
| A2 — Distribución por `transactionDirection` | sin filas (tabla vacía) |
| B1 — Reglas con dirección específica (`<> 'any'`) | 0 |
| C1 — Condiciones de monto (JSON) | 0 |
| C2 — Condiciones de monto (legacy `conditionType`) | 0 |
| C3 — Condiciones de monto (total único, JSON OR legacy) | 0 |
| D1/D2/D3 — Monto + dirección específica (JSON / legacy / único) | 0 / 0 / 0 |
| E1/E2/E3 — Valores de monto negativos (JSON value / legacy / range) | 0 / 0 / 0 |
| E4 — Negativos (total único) | 0 |

**Alcance de esta evidencia:** la consulta demuestra únicamente el estado de **esta base local de
desarrollo**. No demuestra que el sistema en general no tenga reglas, ni cómo se usan las reglas en
un entorno real. No debe interpretarse como evidencia global ni representativa del comportamiento
productivo.

**Interpretación:** la base local utilizada para desarrollo no contiene reglas (`BankRule = 0`),
por lo que no es posible obtener evidencia empírica de distribución. Los conteos derivados son 0
por vacuidad, no por invariante:

- No existe dato real local para medir la distribución de reglas por monto/dirección.
- La ausencia de valores negativos **no queda demostrada**: la tabla vacía no la confirma, y
  el análisis de fronteras (ver Riesgos) muestra que API, dos UIs, el clasificador de IA y el
  restore de backup pueden introducir valores negativos.
- La tasa de divergencia real del shadow no es medible sobre datos históricos locales; deberá
  obtenerse de uso real (imports + reglas creadas) en la etapa de shadow posterior.

**BRE-007 se justifica por una inconsistencia funcional entre motores:** Legacy y Precedence
consideran `transactionDirection` durante la elegibilidad de reglas, mientras que V2 no lo hace.
La implementación busca restaurar esa paridad funcional. No depende de estadísticas de producción
ni de la distribución actual de reglas.

---

## Alcance

### 1. Contrato V2 mínimo

- Nuevo campo en `BankRule` (dominio V2): `direction?: 'any' | 'debit' | 'credit'`.
- Opcional con default `'any'` para no romper la construcción de `BankRule` en tests existentes.
- Derivación de dirección desde el signo (paridad exacta con Legacy `rule-matching-engine.ts:158-159`
  y Precedence `rule-precedence-engine.ts:138-139`):

| `direction` | Transacción elegible |
|---|---|
| `debit` | `amount < 0` (excluye `amount >= 0`) |
| `credit` | `amount >= 0` (excluye `amount < 0`) |
| `any` | sin filtro |

### 2. Definición explícita de `amount = 0`

`0` se trata como **credit**: pasa el filtro `credit` (`0 >= 0`) y falla el filtro `debit`
(`0 >= 0` → excluido). Reproduce exactamente el comportamiento productivo actual; no es un
rediseño. Documentado como decisión de paridad.

### 3. Propiedad de regla y pre-filtro (no condición puntuable)

La dirección se modela como **propiedad de la regla con pre-filtro en el pipeline**, igual que en
Legacy/Precedence. NO es una condición evaluable: hacerla condición cambiaría specificity/ranking
y rompería la paridad con Legacy, que la trata como propiedad.

### 4. Puntos de pérdida a corregir

| Pérdida | Ubicación |
|---|---|
| Tipo | `src/lib/services/rule-engine-adapter/types.ts` — `PrismaBankRule` no declara el campo |
| Mapeo | `src/lib/services/rule-engine-adapter/index.ts` — `buildEngineRule` no lo copia |
| Dominio | `src/lib/rule-engine/types.ts` — `BankRule` no tiene el campo |
| Pipeline | `src/lib/rule-engine/pipeline.ts` — `collectCandidates` no filtra por dirección |

---

## Archivos afectados (lista autorizada)

### Modificar

- `src/lib/rule-engine/types.ts`
- `src/lib/rule-engine/pipeline.ts`
- `src/lib/services/rule-engine-adapter/types.ts`
- `src/lib/services/rule-engine-adapter/index.ts`

### Crear

- `docs/specs/BRE-007-v2-direction-parity.md` (este documento)
- Tests de pipeline, adapter y de integración shadow (ver Tests obligatorios)

### NO modificar

- `src/lib/rule-engine/conditions/*.ts` (evaluadores de amount)
- `src/lib/rule-engine/specificity.ts`, `ranking.ts`, `decision.ts`, `scoring.ts`
- `src/lib/rule-engine/compat.ts` (código muerto, sin uso)
- `src/lib/services/rule-matching-engine.ts` (Legacy)
- `src/lib/services/rule-precedence-engine.ts`, `rule-precedence-compat.ts`, `rule-precedence-shadow.ts`,
  `rule-precedence-adapters.ts` (Precedence — no tocar `Math.abs()`)
- `prisma/schema.prisma` y migraciones
- `src/lib/rule-engine/flag.ts` y feature flags
- Activación de V2 como default
- ADR-009

### Cambios no permitidos

- ❌ Cambiar semántica signed/magnitude del monto
- ❌ Tocar `Math.abs()` en ningún motor
- ❌ Migrar o modificar reglas almacenadas
- ❌ Cambiar el schema Prisma
- ❌ Modificar ranking/specificity del V2
- ❌ Activar V2 como default

---

## Riesgos

1. **Cambio en métricas del shadow (esperado):** al añadir el pre-filtro, las divergencias causadas
   por dirección desaparecen y los baselines del shadow cambian. Es el objetivo, no una regresión.
2. **Paridad de elegibilidad ≠ paridad de ganador:** Precedence otorga +20 de especificidad a una
   dirección concreta (`rule-precedence-engine.ts:79-88`); V2 no pondera dirección en su specificity
   (`specificity.ts`). En empates dirección-vs-`any`, el ganador puede diferir. Este posible empate de
   ranking queda **fuera de BRE-007** y se registra como riesgo conocido para resolver en otro work item.
3. **`amount = 0` tratado como credit:** decisión de paridad documentada; si se prefiriera otra
   semántica, debe discutirse en BRE-006, no acá.
4. **Valores de condición negativos no están bloqueados en fronteras:** la API (`bank-rules/route.ts:180-188`,
   `[id]/route.ts:157-160`, `learning/rules/route.ts:206-210`) solo valida `isNaN`, no el signo; dos UIs
   (`BankRulesPage` usa `min={0}` — solo hint de cliente — y `ConversationalRuleBuilder:1493-1506` sin
   restricción) y el restore de backup (`backup.ts:707`) pueden introducirlos. No es bloqueante para
   BRE-007 pero queda registrado como deuda para el contrato de monto (BRE-006).

---

## Rollback

Sin cambios de schema ni de datos, el rollback es trivial:

```bash
git revert HEAD --no-edit   # por commit, en orden inverso
# o, si no se pusheó:
git reset --soft HEAD~N && git restore . && git clean -fd
```

---

## Tests obligatorios

1. `debit` + monto negativo → matchea
2. `credit` + monto positivo → matchea
3. `any` → matchea ambos signos
4. dirección contraria → no matchea (`debit` con positivo; `credit` con negativo)
5. monto `0` → `debit` NO matchea; `credit` SÍ matchea
6. Paridad de dirección: misma regla + misma transacción → mismo resultado en Legacy, Precedence y V2
7. Shadow sin divergencia cuando la única diferencia previa era dirección: la regla que antes divergía
   ahora produce `SAME_WINNER` / sin evento de divergencia

---

## Definition of Done

- [ ] `BankRule.direction` presente en el dominio V2 y en `PrismaBankRule`
- [ ] `buildEngineRule` mapea `transactionDirection` → `direction` (`'any'` → `undefined`)
- [ ] `collectCandidates` filtra por dirección con paridad exacta a Legacy/Precedence
- [ ] `amount = 0` tratado como `credit` (documentado y testeado)
- [ ] Matriz de 7 tests obligatorios verde
- [ ] Test de integración shadow sin divergencia por dirección
- [ ] `npx tsc --noEmit` exitoso
- [ ] `npm run lint` sin errores nuevos
- [ ] Suite completa (`npx vitest run`) sin regresiones
- [ ] `npm run build` exitoso
- [ ] `git status` limpio
- [ ] Zero cambios en monto/schema/flags/Legacy/Precedence
- [ ] Este spec actualizado a `Approved` cuando el usuario lo autorice

---

## Separación de commits propuesta

1. `feat(rule-engine): add direction as first-class concept to V2`
   — `types.ts`, adapter (`types.ts` + `index.ts`), `pipeline.ts` + tests unitarios de mapeo/filtro.
2. `test(rule-engine): cover direction parity across engines`
   — matriz de paridad + test de integración shadow (sin divergencia por dirección).

---

## Relación con BRE-006 (Amount Semantics)

Secuencia definida por TDR-001 y el usuario:

1. ✅ BRE-001 (completado)
2. 🔄 **BRE-007 (este work item):** dirección como concepto de primer orden en V2
3. Ejecutar shadow con motores comparables (paridad de elegibilidad)
4. Medir divergencias restantes (ahora dominadas por la semántica del monto)
5. 🔜 **BRE-006:** decidir el contrato de monto (signed vs magnitud) con esa evidencia

BRE-007 **no anticipa** la decisión de BRE-006: no cambia evaluadores de amount, `Math.abs()` ni el
contrato signed/magnitude. Corrige únicamente la paridad de elegibilidad por dirección.

---

## Aclaración signed/magnitude

Este work item **no modifica** la semántica del monto: los evaluadores de `conditions/amount.ts`
siguen comparando signed, Legacy/Precedence siguen usando magnitud (`Math.abs()` en ambos lados),
y el simulador sigue usando magnitud solo en la transacción. Todo lo referido al contrato de monto
queda reservado a BRE-006.
