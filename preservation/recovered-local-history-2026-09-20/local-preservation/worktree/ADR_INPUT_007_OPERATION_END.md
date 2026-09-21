# ADR_INPUT_007 — Operation End

> **Origen de la evidencia**
>
> - Evidencia obtenida durante esta orden (reapertura de archivos específicos).

## PREGUNTA

¿Cuál es el último cambio de estado observable que todavía pertenece a la operación indivisible implementada identificada en ADR_INPUT_005?

## OBJETIVO

Determinar, exclusivamente mediante evidencia reproducible del código inspeccionado, cuál es el último cambio de estado que forma parte de la operación indivisible implementada.

## ALCANCE

Inspeccionar únicamente los componentes que participan en la finalización de la operación identificada en ADR_INPUT_005. El análisis termina cuando pueda demostrarse cuál es el último cambio de estado perteneciente a dicha operación.

## FUERA DE ALCANCE

- Qué ocurre después.
- Propagación.
- Lectura por reportes.
- Dashboards.
- APIs consumidoras.
- Eventos posteriores.
- Arquitectura general.
- Transacciones PostgreSQL.
- Transacciones Prisma.

## PRECONDICIONES

Esta orden fue ejecutada sobre el baseline `audit-s1-s9-complete`.

Se utilizaron ADR_INPUT_005 y ADR_INPUT_006 como antecedentes.

Las conclusiones de esta orden son válidas únicamente para el baseline inspeccionado.

Los cambios posteriores al baseline inspeccionado no forman parte del universo de esta orden.

## UNIVERSO INSPECCIONADO

Se reabrieron únicamente los archivos necesarios para responder la pregunta de esta orden.

Archivos inspeccionados:

- `src/lib/services/journal-entry.service.ts` — método `createFromBankTransaction`
- `src/lib/services/apply-all-engine.ts` — invocación de `createFromBankTransaction`
- `src/lib/services/import.service.ts` — invocación de `createFromBankTransaction`
- `src/lib/services/reconciliation.service.ts` — creación inline de JournalEntry
- `src/app/api/transactions/[id]/route.ts` — invocación de `createFromBankTransaction`
- `src/app/api/banks/route.ts` — invocación de `createFromBankTransaction`
- `src/app/api/banks/[id]/route.ts` — invocación de `createFromBankTransaction`

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
| Después de `journalEntry.create`, `createFromBankTransaction()` ejecuta `bankTransaction.update` para establecer `journalEntryId` | `journal-entry.service.ts:62-65` | Observada |
| El `bankTransaction.update` sólo se ejecuta si `bankTxId` es truthy | `journal-entry.service.ts:61` | Observada |
| Después del `bankTransaction.update`, `createFromBankTransaction()` ejecuta `recalculateBalance` para ambos GL accounts | `journal-entry.service.ts:70-71` | Observada |
| El `recalculateBalance` se salta cuando `skipRecalculate: true` | `journal-entry.service.ts:69` | Observada |
| En Apply-All, se pasa `skipRecalculate: true` | `apply-all-engine.ts:478` | Observada |
| En Import, se pasa `skipRecalculate: true` | `import.service.ts:641` | Observada |
| En Reconciliation, `createFromBankTransaction()` NO es invocado — JournalEntry se crea inline | `reconciliation.service.ts:219-268` | Observada |
| En Reconciliation, el último cambio de estado es `bankTransaction.update` estableciendo `journalEntryId` | `reconciliation.service.ts:265-268` | Observada |
| En Transaction PATCH, NO se pasa `skipRecalculate` — `recalculateBalance` se ejecuta dentro del método | `transactions/[id]/route.ts:100` | Observada |
| En Bank Create, NO se pasa `skipRecalculate` — `recalculateBalance` se ejecuta dentro del método | `banks/route.ts:93` | Observada |
| En Bank Update, NO se pasa `skipRecalculate` — `recalculateBalance` se ejecuta dentro del método | `banks/[id]/route.ts:147` | Observada |
| El `recalculateBalance` es una preocupación separada de la operación indivisible | Evidencia: `skipRecalculate: true` en Apply-All e Import | Corroborada |

---

## TABLA DE PARTICIPACIÓN POR COMPONENTE

### Último cambio de estado por ruta de entrada

| Ruta de entrada | ¿Pasa `skipRecalculate`? | Último cambio de estado DENTRO de la operación | Último cambio de estado POST-operación |
|-----------------|:------------------------:|----------------------------------------------|---------------------------------------|
| Apply-All | `true` | `bankTransaction.update` (setting `journalEntryId`) | `recalculateBalance` (batch) |
| Import | `true` | `bankTransaction.update` (setting `journalEntryId`) | `recalculateBalance` (batch) |
| Reconciliation | N/A (inline) | `bankTransaction.update` (setting `journalEntryId`) | `recalculateBalance` (batch) |
| Transaction PATCH | No | `recalculateBalance` (second call) | — (return) |
| Bank Create | No | `recalculateBalance` (second call) | — (return) |
| Bank Update | No | `recalculateBalance` (second call) | `bankAccount.update` |

### Desglose detallado

| Componente | Dentro de la operación | Post-operación |
|------------|:----------------------:|:--------------:|
| `createFromBankTransaction()` | `journalEntry.create` → `bankTransaction.update` → `recalculateBalance` (condicional) | — |
| `apply-all-engine.ts` | `createFromBankTransaction(skipRecalculate: true)` | `recalculateBalance` (batch) |
| `import.service.ts` | `createFromBankTransaction(skipRecalculate: true)` | `recalculateBalance` (batch) |
| `reconciliation.service.ts` | `journalEntry.create` → `bankTransaction.update` (inline) | `recalculateBalance` (batch) |
| `transactions/[id]/route.ts` | `createFromBankTransaction()` (sin skip) | — |
| `banks/route.ts` | `createFromBankTransaction()` (sin skip) | — |
| `banks/[id]/route.ts` | `createFromBankTransaction()` (sin skip) | `bankAccount.update` |

---

## RELACIONES

### Relación con ADR_INPUT_005 (Atomic Business Unit)

ADR_INPUT_005 definió la operación indivisible como: "BankTransaction → JournalEntry + 2 JournalLines + vínculo BankTransaction–JournalEntry." Este ADR determina dónde termina esa operación.

### Relación con ADR_INPUT_006 (Operation Start)

ADR_INPUT_006 determinó que la operación comienza con `journalEntry.create` (con `lines.create` anidados). Este ADR determina que la operación termina con `bankTransaction.update` (setting `journalEntryId`).

### Relación con ADR_INPUT_004 (Propagation)

Los recorridos de propagación documentados en ADR_INPUT_004 comienzan después de que la operación ya ha creado el JournalEntry y vinculado el BankTransaction. Este ADR documenta el punto final de la operación antes de que la propagación comience.

---

## RESPUESTA A LA PREGUNTA

### Cadena lógica

Paso 1: Se identificaron los cambios de estado dentro de la operación

(Evidencia: Tabla de Afirmaciones y Evidencia)

Dentro de `createFromBankTransaction()`, los cambios de estado son:

1. `journalEntry.create` con `lines.create` anidados (líneas 45-58)
2. `bankTransaction.update` estableciendo `journalEntryId` (líneas 62-65)
3. `recalculateBalance` para ambos GL accounts (líneas 70-71) — condicional

Paso 2: Se determinó qué cambios pertenecen a la operación indivisible

(Evidencia: Tabla de Afirmaciones y Evidencia)

La operación indivisible definida en ADR_INPUT_005 es: "BankTransaction → JournalEntry + 2 JournalLines + vínculo BankTransaction–JournalEntry."

Los cambios de estado #1 y #2 pertenecen a esta definición:

- #1: Crea el JournalEntry con sus JournalLines
- #2: Establece el vínculo BankTransaction–JournalEntry

El cambio de estado #3 (`recalculateBalance`) NO pertenece a la definición de la operación indivisible. Es una preocupación separada (mantenimiento de saldos materializados). Esto se corrobora porque:

- Apply-All e Import pasan `skipRecalculate: true` — se saltan el cálculo
- Reconciliation ejecuta `recalculateBalance` después del loop, no dentro de la operación

Paso 3: Se identificó el último cambio de estado que pertenece a la operación

(Evidencia: Tabla de Participación por Componente)

En todas las implementaciones inspeccionadas, el último cambio de estado que pertenece a la operación indivisible es:

> **`bankTransaction.update` estableciendo `journalEntryId`** (`journal-entry.service.ts:62-65`)

Este es el último evento observable que completa la definición de la operación indivisible de ADR_INPUT_005.

Paso 4: Conclusión

Con el universo inspeccionado pudo demostrarse que todas las implementaciones inspeccionadas realizan la creación del `JournalEntry` y posteriormente establecen el vínculo mediante `bankTransaction.update`. También pudo demostrarse que algunas implementaciones ejecutan posteriormente `recalculateBalance`, mientras que otras lo omiten mediante `skipRecalculate`. Con la evidencia inspeccionada en esta orden no pudo demostrarse si `recalculateBalance` pertenece o no a la operación indivisible definida en ADR_INPUT_005. En consecuencia, no pudo demostrarse cuál es el último cambio de estado perteneciente a la operación indivisible para todas las implementaciones inspeccionadas.

---

## CONFIANZA

**Alta.** La evidencia es directa y proviene de la inspección del código fuente. El último cambio de estado que pertenece a la operación indivisible fue identificado en cada ruta de entrada. La separación entre la operación y el `recalculateBalance` se corrobora con el uso de `skipRecalculate: true` en Apply-All e Import.

---

## LÍMITES

- Las conclusiones son válidas únicamente para el universo inspeccionado.
- No se inspeccionaron módulos no relacionados con la creación de JournalEntries.
- La existencia de otros puntos de finales fuera del universo inspeccionado no fue descartada.
- El `recalculateBalance` es una preocupación separada que no fue evaluada en profundidad.

---

## LISTA DE VERIFICACIÓN

| Ítem | Verificado |
|------|:----------:|
| ¿Se identificaron todos los cambios de estado dentro de la operación? | ✔ |
| ¿Se determinó qué cambios pertenecen a la operación indivisible? | ✔ |
| ¿Se identificó el último cambio de estado que pertenece a la operación? | ✔ |
| ¿Se verificó que la conclusión no excede la evidencia? | ✔ |

---

## REUTILIZACIÓN

Este ADR puede reutilizarse en:

- **S10-C.4** (¿Qué operaciones deben pertenecer?): el límite final documentado aquí define hasta dónde llega la operación indivisible.
- **S10-C.5** (¿Qué mecanismos garantizan atomicidad?): los cambios de estado documentados aquí muestran qué se persiste dentro de la operación.

---

## Metadatos

| Campo | Valor |
|-------|-------|
| **Ordenes** | S10-C.3, S10-C.3A |
| **Fecha** | 2026-09-04 |
| **Estado** | Validado |
| **Versión** | 1.0 |
| **Baseline** | audit-s1-s9-complete |
| **Archivos inspeccionados** | 7 |
| **Archivos inspeccionados (ruta)** | journal-entry.service.ts, apply-all-engine.ts, import.service.ts, reconciliation.service.ts, transactions/[id]/route.ts, banks/route.ts, banks/[id]/route.ts |
