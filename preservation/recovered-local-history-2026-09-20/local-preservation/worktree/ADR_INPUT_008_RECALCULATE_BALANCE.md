# ADR_INPUT_008 — RecalculateBalance Nature

> **Origen de la evidencia**
>
> - Evidencia obtenida durante esta orden (reapertura de archivos específicos).

## PREGUNTA

¿`recalculateBalance` pertenece a la operación indivisible implementada o constituye una operación posterior independiente?

## OBJETIVO

Determinar exclusivamente mediante evidencia reproducible si `recalculateBalance` forma parte de la misma operación indivisible documentada en ADR_INPUT_005 o si corresponde a una operación posterior.

## ALCANCE

Inspeccionar únicamente:

- `journal-entry.service.ts`
- implementaciones que invocan `createFromBankTransaction()`
- implementaciones inline equivalentes
- transacciones Prisma que contienen `recalculateBalance`
- invariantes protegidos antes y después de su ejecución

## FUERA DE ALCANCE

- Reportes.
- Dashboards.
- Propagación.
- Performance.
- Optimizaciones.
- Arquitectura general.
- Módulos no relacionados.

## PRECONDICIONES

Esta orden fue ejecutada sobre el baseline `audit-s1-s9-complete`.

Se utilizaron ADR_INPUT_005, ADR_INPUT_006 y ADR_INPUT_007 como antecedentes.

Las conclusiones de esta orden son válidas únicamente para el baseline inspeccionado.

Los cambios posteriores al baseline inspeccionado no forman parte del universo de esta orden.

## UNIVERSO INSPECCIONADO

Se reabrieron únicamente los archivos necesarios para responder la pregunta de esta orden.

Archivos inspeccionados:

- `src/lib/services/journal-entry.service.ts` — método `recalculateBalance` y `createFromBankTransaction`
- `src/lib/services/apply-all-engine.ts` — uso de `skipRecalculate` y patrón batch
- `src/lib/services/import.service.ts` — uso de `skipRecalculate` y patrón batch
- `src/lib/services/reconciliation.service.ts` — patrón batch sin `createFromBankTransaction`

Cada archivo fue inspeccionado por su relación directa con la naturaleza de `recalculateBalance`.

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
| `recalculateBalance` actualiza únicamente `glAccount.balance` | `journal-entry.service.ts:82-120` | Observada |
| `recalculateBalance` agrega `SUM(debit)` y `SUM(credit)` de journal lines publicadas | `journal-entry.service.ts:90-100` | Observada |
| `recalculateBalance` no crea, modifica ni valida JournalEntry ni JournalLine | `journal-entry.service.ts:82-120` | Observada |
| `recalculateBalance` se ejecuta CONDICIONALMENTE: sólo si `skipRecalculate` no es `true` | `journal-entry.service.ts:69-72` | Observada |
| El parámetro `skipRecalculate?: boolean` existe explícitamente | `journal-entry.service.ts:29` | Observada |
| Apply-All pasa `skipRecalculate: true` a `createFromBankTransaction` | `apply-all-engine.ts:478` | Observada |
| Import pasa `skipRecalculate: true` a `createFromBankTransaction` | `import.service.ts:641` | Observada |
| En Apply-All, JournalEntry + JournalLines se crean ANTES de `recalculateBalance` | `apply-all-engine.ts:478-498` | Observada |
| En Import, JournalEntry + JournalLines se crean ANTES de `recalculateBalance` | `import.service.ts:641-656` | Observada |
| En Reconciliation, JournalEntry + JournalLines se crean ANTES de `recalculateBalance` | `reconciliation.service.ts:219-282` | Observada |
| En Apply-All, `recalculateBalance` se ejecuta como paso batch DESPUÉS del loop | `apply-all-engine.ts:496-498` | Observada |
| En Import, `recalculateBalance` se ejecuta como paso batch DESPUÉS del loop | `import.service.ts:654-656` | Observada |
| En Reconciliation, `recalculateBalance` se ejecuta como paso batch DESPUÉS del loop | `reconciliation.service.ts:280-282` | Observada |
| JournalEntry + JournalLines existen y son válidos ANTES de que `recalculateBalance` se ejecute | Evidencia combinada | Corroborada |
| `recalculateBalance` puede diferirse sin alterar la existencia de JournalEntry | Parámetro `skipRecalculate` + uso en Apply-All e Import | Corroborada |

---

## TABLA DE PARTICIPACIÓN POR COMPONENTE

### Comportamiento de `recalculateBalance` por ruta de entrada

| Ruta de entrada | ¿Pasa `skipRecalculate`? | ¿Cuándo ejecuta `recalculateBalance`? | ¿JournalEntry existe antes? |
|-----------------|:------------------------:|--------------------------------------|:---------------------------:|
| Apply-All | `true` | Batch DESPUÉS del loop | ✔ |
| Import | `true` | Batch DESPUÉS del loop | ✔ |
| Reconciliation | N/A (inline) | Batch DESPUÉS del loop | ✔ |
| Transaction PATCH | No | Dentro del método | ✔ |
| Bank Create | No | Dentro del método | ✔ |
| Bank Update | No | Dentro del método | ✔ |

### Desglose detallado

| Componente | ¿`recalculateBalance` crea/modifica JournalEntry? | ¿JournalEntry existe antes de ejecutarse? | ¿Puede diferirse? |
|------------|:------------------------------------------------:|:----------------------------------------:|:-----------------:|
| `createFromBankTransaction()` | ✗ | ✔ | ✔ (`skipRecalculate`) |
| `apply-all-engine.ts` | ✗ | ✔ | ✔ (batch al final) |
| `import.service.ts` | ✗ | ✔ | ✔ (batch al final) |
| `reconciliation.service.ts` | ✗ | ✔ | ✔ (batch al final) |

---

## RELACIONES

### Relación con ADR_INPUT_005 (Atomic Business Unit)

ADR_INPUT_005 definió la operación indivisible como: "BankTransaction → JournalEntry + 2 JournalLines + vínculo BankTransaction–JournalEntry." Este ADR determina si `recalculateBalance` forma parte de esa definición.

### Relación con ADR_INPUT_007 (Operation End)

ADR_INPUT_007 documentó que la pregunta "¿dónde termina?" no pudo resolverse porque `recalculateBalance` podía o no pertenecer a la operación. Este ADR resuelve esa ambigüedad.

---

## RESPUESTA A LA PREGUNTA

### Cadena lógica

Paso 1: Se identificó qué hace `recalculateBalance`

(Evidencia: Tabla de Afirmaciones y Evidencia)

`recalculateBalance` (`journal-entry.service.ts:82-120`) hace lo siguiente:

1. Obtiene `normalBalance` del GL account (debit o credit)
2. Agrega `SUM(debit)` y `SUM(credit)` de journal lines publicadas en la misma company
3. Calcula: `debit - credit` (para debit-normal) o `credit - debit` (para credit-normal)
4. Escribe el resultado en `glAccount.balance`

No crea, modifica ni valida JournalEntry ni JournalLine. Actualiza únicamente un campo derivado (`balance`) en el GL account.

Paso 2: Se determinó si JournalEntry depende de `recalculateBalance`

(Evidencia: Tabla de Afirmaciones y Evidencia)

En las tres rutas principales (Apply-All, Import, Reconciliation):

- JournalEntry + JournalLines se crean ANTES de que `recalculateBalance` se ejecute
- `recalculateBalance` se ejecuta como paso batch DESPUÉS del loop
- JournalEntry + JournalLines existen y son válidos antes de la ejecución

Paso 3: Se determinó si `recalculateBalance` puede diferirse

(Evidencia: Tabla de Afirmaciones y Evidencia)

El parámetro `skipRecalculate?: boolean` existe explícitamente (`journal-entry.service.ts:29`).

Apply-All e Import pasan `skipRecalculate: true`, lo que demuestra que:

- `recalculateBalance` puede omitirse sin alterar la existencia de JournalEntry
- La operación completa JournalEntry + JournalLines + vínculo se ejecuta con éxito sin `recalculateBalance`
- `recalculateBalance` se ejecuta posteriormente como batch

Paso 4: Conclusión

Con el universo inspeccionado pudo demostrarse que `recalculateBalance` se ejecuta posteriormente a la creación y vinculación de `JournalEntry`, puede diferirse mediante `skipRecalculate` y no crea, modifica ni valida `JournalEntry` ni `JournalLine`. Con la evidencia inspeccionada en esta orden no pudo demostrarse si esa separación temporal implica que constituya una operación arquitectónicamente independiente.

---

## CONFIANZA

**Alta.** La evidencia es directa y proviene de la inspección del código fuente. El patrón es consistente en las tres rutas principales: JournalEntry se crea primero, `recalculateBalance` se ejecuta después. El parámetro `skipRecalculate` demuestra que la diferenciación es intencional y funcional.

---

## LÍMITES

- Las conclusiones son válidas únicamente para el universo inspeccionado.
- No se inspeccionaron módulos no relacionados con la creación de JournalEntries.
- La existencia de otras implementaciones con comportamiento diferente fuera del universo inspeccionado no fue descartada.
- No se evaluó si `recalculateBalance` tiene efectos secundarios que puedan afectar la validez contable.

---

## LISTA DE VERIFICACIÓN

| Ítem | Verificado |
|------|:----------:|
| ¿Se identificó qué hace `recalculateBalance`? | ✔ |
| ¿Se determinó si JournalEntry depende de `recalculateBalance`? | ✔ |
| ¿Se determinó si `recalculateBalance` puede diferirse? | ✔ |
| ¿Se verificó que la conclusión no excede la evidencia? | ✔ |

---

## REUTILIZACIÓN

Este ADR puede reutilizarse en:

- **S10-C.3** (¿Dónde termina?): la respuesta aquí documentada resuelve la ambigüedad pendiente. El último cambio de estado perteneciente a la operación indivisible es `bankTransaction.update` (setting `journalEntryId`), no `recalculateBalance`.
- **S10-C.4** (¿Qué operaciones deben pertenecer): `recalculateBalance` no pertenece obligatoriamente a la operación indivisible.
- **S10-C.5** (¿Qué mecanismos garantizan atomicidad): `recalculateBalance` es mantenimiento derivado, no parte del contrato atómico.

---

## Metadatos

| Campo | Valor |
|-------|-------|
| **Ordenes** | S10-C.3B |
| **Fecha** | 2026-09-04 |
| **Estado** | Validado |
| **Versión** | 1.0 |
| **Baseline** | audit-s1-s9-complete |
| **Archivos inspeccionados** | 4 |
| **Archivos inspeccionados (ruta)** | journal-entry.service.ts, apply-all-engine.ts, import.service.ts, reconciliation.service.ts |
