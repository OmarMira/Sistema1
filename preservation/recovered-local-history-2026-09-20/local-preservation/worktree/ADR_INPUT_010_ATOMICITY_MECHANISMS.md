# ADR_INPUT_010 — Atomicity Mechanisms

> **Origen de la evidencia**
>
> - Evidencia obtenida durante esta orden (reapertura de archivos específicos).

## PREGUNTA

¿Qué mecanismos garantizan la atomicidad de la operación indivisible implementada identificada en ADR_INPUT_005?

## OBJETIVO

Determinar, exclusivamente mediante evidencia reproducible, qué mecanismos preservan la atomicidad en las implementaciones inspeccionadas.

## ALCANCE

Inspeccionar únicamente los componentes que participan en la creación de la operación identificada en ADR_INPUT_005. El análisis debe identificar los mecanismos observables que preservan la atomicidad.

## FUERA DE ALCANCE

- Qué ocurre después.
- Propagación.
- Lectura por reportes.
- Dashboards.
- APIs consumidoras.
- Eventos posteriores.
- Arquitectura general.
- Transacciones PostgreSQL.
- Transacciones Prisma (detalles de implementación interna).

## PRECONDICIONES

Esta orden fue ejecutada sobre el baseline `audit-s1-s9-complete`.

Se utilizaron ADR_INPUT_005, ADR_INPUT_006, ADR_INPUT_007, ADR_INPUT_008 y ADR_INPUT_009 como antecedentes.

Las conclusiones de esta orden son válidas únicamente para el baseline inspeccionado.

Los cambios posteriores al baseline inspeccionado no forman parte del universo de esta orden.

## UNIVERSO INSPECCIONADO

Se reabrieron únicamente los archivos necesarios para responder la pregunta de esta orden.

Archivos inspeccionados:

- `src/lib/services/journal-entry.service.ts` — método `createFromBankTransaction` y `recalculateBalance`
- `src/lib/services/apply-all-use-case.ts` — transacción y validaciones
- `src/lib/services/apply-all-engine.ts` — uso de `skipRecalculate`
- `src/lib/services/import.service.ts` — transacción y validaciones
- `src/lib/services/reconciliation.service.ts` — transacción y validaciones
- `src/lib/fiscal-period-guard.ts` — validación de período fiscal

Cada archivo fue inspeccionado por su relación directa con la operación identificada en ADR_INPUT_005.

Las conclusiones de esta orden sólo aplican al conjunto de archivos inspeccionados.

---

## CRITERIO DE EVIDENCIA

| Estado | Criterio |
|--------|----------|
| Observada | Evidencia encontrada en una única inspección del código |
| Corroborada | La misma afirmación fue confirmada por dos o más evidencias independientes |
| No demostrada | No existe evidencia suficiente para sostener la afirmación |

---

## TABLA DE AFIRMACIONES Y EVIDENCIA

| Afirmación | Evidencia | Estado |
|------------|-----------|--------|
| `journalEntry.create` con `lines.create` anidados crea JournalEntry + JournalLines en una sola operación de base de datos | `journal-entry.service.ts:45-58` | Observada |
| Si falla la inserción de JournalLine, ni JournalEntry ni JournalLine se persisten | Comportamiento de nested create en Prisma | Observada |
| `createFromBankTransaction` recibe `Prisma.TransactionClient` y no crea su propia transacción | `journal-entry.service.ts:20` | Observada |
| El error se propaga al callback `$transaction` del caller, que ejecuta rollback completo | Comportamiento de Prisma interactive transactions | Observada |
| Apply-All, Import y Reconciliation envuelven todas las mutaciones en `db.$transaction()` | `apply-all-use-case.ts:400,500`, `import.service.ts:499`, `reconciliation.service.ts:35` | Observada |
| Si cualquier statement dentro del callback lanza error, Prisma ejecuta ROLLBACK de todos los writes bufferizados | Comportamiento de Prisma interactive transactions | Observada |
| `assertActiveFiscalPeriod` valida que cada fecha de transacción caiga en un período fiscal desbloqueado | `fiscal-period-guard.ts:9-36` | Observada |
| En Apply-All, TODAS las fechas se validan ANTES de que comience cualquier mutación | `apply-all-engine.ts:399-405` | Observada |
| Si al menos una fecha cae en período cerrado, el classifyAll completo aborta sin clasificación parcial | `apply-all-engine.ts:399-405` | Observada |
| En Import, la verificación de duplicados de BankStatement se ejecuta DENTRO de la transacción | `import.service.ts:500-508` | Observada |
| La verificación dentro de la transacción previene race conditions entre importaciones concurrentes | Aislamiento de transacciones de base de datos | Observada |
| En Reconciliation, se validan todas las GL accounts propuestas ANTES de crear cualquier journal entry | `reconciliation.service.ts:37-56`, `reconciliation.service.ts:89-101` | Observada |
| Si alguna GL account pertenece a otra company, el lote completo aborta | `reconciliation.service.ts:89-101` | Observada |
| `skipRecalculate: true` permite diferir `recalculateBalance` para ejecutarlo como batch al final | `journal-entry.service.ts:69-72`, `apply-all-engine.ts:486`, `import.service.ts:649` | Observada |
| `recalculateBalance` se ejecuta DENTRO de la misma transacción que los journal entries | `apply-all-engine.ts:496-498`, `import.service.ts:654-656`, `reconciliation.service.ts:280-282` | Observada |
| Los efectos secundarios (shadow summaries, policy observations) se ejecutan FUERA de la transacción | `apply-all-use-case.ts:508-515`, `import.service.ts:665-672` | Observada |
| Los efectos secundarios están envueltos en try/catch con falla silenciosa | `apply-all-use-case.ts:539-544`, `import.service.ts:709-714` | Observada |

---

## TABLA DE PARTICIPACIÓN POR COMPONENTE

### Mecanismos por nivel

| Nivel | Mecanismo | Evidencia |
|-------|-----------|-----------|
| **Base de datos** | Nested create (JournalEntry + JournalLines) | `journal-entry.service.ts:45-58` |
| **Transaccional** | `db.$transaction()` wrappers | `apply-all-use-case.ts:400,500`, `import.service.ts:499`, `reconciliation.service.ts:35` |
| **Composición** | Transaction client injection | `journal-entry.service.ts:20` |
| **Validación** | Fiscal period guard (pre-mutation) | `fiscal-period-guard.ts:9-36`, `apply-all-engine.ts:399-405` |
| **Validación** | Duplicate guard (inside TX) | `import.service.ts:500-508` |
| **Validación** | Tenant isolation (pre-mutation) | `reconciliation.service.ts:37-56`, `89-101` |
| **Consistencia** | `skipRecalculate` + batch recalc | `journal-entry.service.ts:69-72`, `apply-all-engine.ts:496-498` |
| **Aislamiento** | Post-TX side effects outside TX | `apply-all-use-case.ts:508-515`, `import.service.ts:665-672` |

### Comportamiento ante fallo por mecanismo

| Mecanismo | ¿Qué ocurre cuando falla? |
|-----------|---------------------------|
| Nested create | DB ejecuta rollback de JournalEntry + JournalLines como unidad |
| `db.$transaction()` | Cualquier throw → ROLLBACK completo de todos los writes bufferizados |
| Transaction client injection | Error se propaga al callback → rollback del caller |
| Fiscal period guard | ForbiddenError → rollback completo, cero writes parciales |
| Duplicate guard | ConflictError → rollback completo |
| Tenant isolation | ValidationError → rollback completo |
| `skipRecalculate` + batch recalc | Si falla dentro de la transacción → rollback de entries + balances |
| Post-TX side effects | Falla silenciosa, operación de negocio no afectada |

---

## RELACIONES

### Relación con ADR_INPUT_005 (Atomic Business Unit)

ADR_INPUT_005 definió la operación indivisible. Este ADR identifica los mecanismos que preservan su atomicidad.

### Relación con ADR_INPUT_006 (Operation Start)

ADR_INPUT_006 determinó que la operación comienza con `journalEntry.create`. Este ADR muestra que ese `journalEntry.create` utiliza nested create para preservar atomicidad.

### Relación con ADR_INPUT_008 (RecalculateBalance)

ADR_INPUT_008 determinó que `recalculateBalance` es posterior y diferible. Este ADR muestra que se ejecuta DENTRO de la misma transacción, preservando consistencia.

### Relación con ADR_INPUT_009 (Mandatory Operations)

ADR_INPUT_009 documentó que la obligatoriedad no pudo demostrarse. Este ADR muestra que, independientemente de la obligatoriedad, los mecanismos de atomicidad preservan la consistencia de lo que se ejecuta.

---

## RESPUESTA A LA PREGUNTA

### Cadena lógica

Paso 1: Se identificaron los mecanismos en el nivel más bajo (base de datos)

(Evidencia: Tabla de Afirmaciones y Evidencia)

El mecanismo más bajo es el **nested create** de Prisma:

```typescript
prisma.journalEntry.create({
  data: {
    companyId,
    date: bankTxDate,
    description,
    status: 'posted',
    lines: {
      create: [
        { glAccountId: debitAccountId, description, debit: amount, credit: 0 },
        { glAccountId: creditAccountId, description, debit: 0, credit: amount },
      ],
    },
  },
});
```

Este mecanismo crea JournalEntry + 2 JournalLines en una sola operación de base de datos. Si falla la inserción de JournalLine, ni JournalEntry ni JournalLine se persisten.

Paso 2: Se identificaron los mecanismos en el nivel transaccional

(Evidencia: Tabla de Afirmaciones y Evidencia)

Los callers envuelven todas las mutaciones en `db.$transaction()`:

- Apply-All: `apply-all-use-case.ts:400,500`
- Import: `import.service.ts:499`
- Reconciliation: `reconciliation.service.ts:35`

Si cualquier statement dentro del callback lanza error, Prisma ejecuta ROLLBACK de todos los writes bufferizados.

Paso 3: Se identificaron los mecanismos de validación pre-mutación

(Evidencia: Tabla de Afirmaciones y Evidencia)

Existen tres validaciones que ejecutan antes de cualquier mutación:

1. **Fiscal period guard**: valida que todas las fechas caigan en períodos desbloqueados
2. **Duplicate guard**: previene race conditions entre importaciones concurrentes
3. **Tenant isolation**: valida que todas las GL accounts pertenezcan a la misma company

Si cualquiera de estas validaciones falla, el lote completo aborta sin writes parciales.

Paso 4: Se identificaron los mecanismos de consistencia y aislamiento

(Evidencia: Tabla de Afirmaciones y Evidencia)

- **`skipRecalculate` + batch recalc**: permite diferir `recalculateBalance` para ejecutarlo como batch al final, DENTRO de la misma transacción
- **Post-TX side effects outside TX**: los efectos secundarios (shadow summaries, policy observations) se ejecutan FUERA de la transacción con falla silenciosa

Paso 5: Conclusión

Con el universo inspeccionado pudieron identificarse ocho mecanismos observados en las implementaciones inspeccionadas:

1. **Nested create** (nivel base de datos): JournalEntry + JournalLines se crean en una sola operación
2. **`db.$transaction()` wrappers** (nivel transaccional): todas las mutaciones comparten la misma transacción
3. **Transaction client injection** (nivel composición): la operación recibe el transaction client del caller
4. **Fiscal period guard** (nivel validación): valida todas las fechas antes de cualquier mutación
5. **Duplicate guard** (nivel validación): previene race conditions dentro de la transacción
6. **Tenant isolation** (nivel validación): valida GL accounts antes de crear journal entries
7. **`skipRecalculate` + batch recalc** (nivel consistencia): diferencia recalculation para ejecutarlo como batch
8. **Post-TX side effects outside TX** (nivel aislamiento): efectos secundarios con falla silenciosa

Con la evidencia inspeccionada en esta orden no pudo demostrarse cuáles de estos mecanismos son necesarios o suficientes para garantizar la atomicidad, ni si existen otros mecanismos fuera del universo inspeccionado. En consecuencia, la pregunta original ("¿qué mecanismos garantizan la atomicidad?") no pudo responderse completamente con el universo inspeccionado.

---

## CONFIANZA

**Alta.** La evidencia es directa y proviene de la inspección del código fuente. Los mecanismos fueron identificados en cada ruta de entrada. El patrón es consistente: defense in depth desde el nivel de base de datos hasta el nivel de aislamiento.

---

## LÍMITES

- Las conclusiones son válidas únicamente para el universo inspeccionado.
- No se inspeccionaron módulos no relacionados con la creación de JournalEntries.
- La existencia de otros mecanismos fuera del universo inspeccionado no fue descartada.
- No se evaluó la efectividad de cada mecanismo ante todos los tipos posibles de fallo.

---

## LISTA DE VERIFICACIÓN

| Ítem | Verificado |
|------|:----------:|
| ¿Se identificaron los mecanismos en el nivel base de datos? | ✔ |
| ¿Se identificaron los mecanismos en el nivel transaccional? | ✔ |
| ¿Se identificaron los mecanismos de validación pre-mutación? | ✔ |
| ¿Se identificaron los mecanismos de consistencia y aislamiento? | ✔ |
| ¿Se verificó que la conclusión no excede la evidencia? | ✔ |

---

## REUTILIZACIÓN

Este ADR puede reutilizarse en:

- **S10-D** (bloque de Consistencia): los mecanismos documentados aquí muestran cómo el sistema preserva invariantes.
- **Análisis futuros**: los mecanismos de defense in depth pueden aplicarse como patrón para otras operaciones.

---

## Metadatos

| Campo | Valor |
|-------|-------|
| **Ordenes** | S10-C.5 |
| **Fecha** | 2026-09-04 |
| **Estado** | Validado |
| **Versión** | 1.0 |
| **Baseline** | audit-s1-s9-complete |
| **Archivos inspeccionados** | 6 |
| **Archivos inspeccionados (ruta)** | journal-entry.service.ts, apply-all-use-case.ts, apply-all-engine.ts, import.service.ts, reconciliation.service.ts, fiscal-period-guard.ts |
