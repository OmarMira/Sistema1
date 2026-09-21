# ADR_INPUT_009 — Mandatory Operations

> **Origen de la evidencia**
>
> - Evidencia obtenida durante esta orden (reapertura de archivos específicos).

## PREGUNTA

¿Qué operaciones deben pertenecer obligatoriamente a la operación indivisible implementada identificada en ADR_INPUT_005?

## OBJETIVO

Determinar, exclusivamente mediante evidencia reproducible, qué operaciones son obligatorias para preservar la invariante de la operación indivisible.

## ALCANCE

Inspeccionar únicamente los componentes que participan en la creación de la operación identificada en ADR_INPUT_005. El análisis debe identificar qué operaciones son siempre ejecutadas, cuáles son condicionales y cuáles son opcionales.

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

Se utilizaron ADR_INPUT_005, ADR_INPUT_006, ADR_INPUT_007 y ADR_INPUT_008 como antecedentes.

Las conclusiones de esta orden son válidas únicamente para el baseline inspeccionado.

Los cambios posteriores al baseline inspeccionado no forman parte del universo de esta orden.

## UNIVERSO INSPECCIONADO

Se reabrieron únicamente los archivos necesarios para responder la pregunta de esta orden.

Archivos inspeccionados:

- `src/lib/services/journal-entry.service.ts` — método `createFromBankTransaction`
- `src/lib/services/reconciliation.service.ts` — creación inline de JournalEntry

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
| `journalEntry.create` se ejecuta siempre, sin condicional | `journal-entry.service.ts:45-58` | Observada |
| `lines.create` se ejecuta siempre, anidado en `journalEntry.create` | `journal-entry.service.ts:51-55` | Observada |
| `bankTransaction.update` se ejecuta SÓLO si `bankTxId` es truthy | `journal-entry.service.ts:61-66` | Observada |
| El comentario en línea 60 dice "skip for standalone entries like opening balance" | `journal-entry.service.ts:60` | Observada |
| `recalculateBalance` se ejecuta SÓLO si `skipRecalculate` no es `true` | `journal-entry.service.ts:69-72` | Observada |
| En Reconciliation, `journalEntry.create` se ejecuta siempre (con splits o sin splits) | `reconciliation.service.ts:219-253` | Observada |
| En Reconciliation, `bankTransaction.update` se ejecuta siempre | `reconciliation.service.ts:265-268` | Observada |
| En Reconciliation, `recalculateBalance` se ejecuta siempre (batch al final) | `reconciliation.service.ts:280-282` | Observada |
| La invariante de ADR_INPUT_005 requiere JournalEntry + JournalLines + vínculo | ADR_INPUT_005 (congelado) | Corroborada |
| Cuando `bankTxId` es falsy, no existe BankTransaction que vincular | `journal-entry.service.ts:60-66` | Observada |

---

## TABLA DE PARTICIPACIÓN POR COMPONENTE

### Clasificación de operaciones por obligatoriedad

| Operación | ¿Siempre se ejecuta? | Condición | Obligatoria para la invariante |
|-----------|:--------------------:|-----------|:------------------------------:|
| `journalEntry.create` | ✔ | Ninguna | ✔ |
| `lines.create` (JournalLines) | ✔ | Ninguna | ✔ |
| `bankTransaction.update` | ✗ | `bankTxId` truthy | ✔ (cuando existe BankTransaction) |
| `recalculateBalance` | ✗ | `skipRecalculate` no es `true` | ✗ |

### Desglose por ruta de entrada

| Ruta de entrada | `journalEntry.create` | `lines.create` | `bankTransaction.update` | `recalculateBalance` |
|-----------------|:---------------------:|:--------------:|:------------------------:|:--------------------:|
| Apply-All | ✔ | ✔ | ✔ (bankTxId truthy) | ✗ (skipRecalculate) |
| Import | ✔ | ✔ | ✔ (bankTxId truthy) | ✗ (skipRecalculate) |
| Reconciliation | ✔ | ✔ | ✔ (siempre) | ✔ (batch) |
| Transaction PATCH | ✔ | ✔ | ✔ (bankTxId truthy) | ✔ (sin skip) |
| Bank Create | ✔ | ✔ | ✗ (bankTxId: '') | ✔ (sin skip) |
| Bank Update | ✔ | ✔ | ✗ (bankTxId: '') | ✔ (sin skip) |

### Invariante por contexto

| Contexto | Invariante | Operaciones obligatorias |
|----------|-----------|-------------------------|
| Con BankTransaction (`bankTxId` truthy) | BankTransaction → JournalEntry + JournalLines + vínculo | `journalEntry.create` + `lines.create` + `bankTransaction.update` |
| Sin BankTransaction (`bankTxId` falsy) | JournalEntry + JournalLines | `journalEntry.create` + `lines.create` |

---

## RELACIONES

### Relación con ADR_INPUT_005 (Atomic Business Unit)

ADR_INPUT_005 definió la operación indivisible como: "BankTransaction → JournalEntry + 2 JournalLines + vínculo BankTransaction–JournalEntry." Este ADR determina qué operaciones son obligatorias para preservar esa invariante.

### Relación con ADR_INPUT_006 (Operation Start)

ADR_INPUT_006 determinó que la operación comienza con `journalEntry.create`. Este ADR confirma que `journalEntry.create` es obligatorio.

### Relación con ADR_INPUT_007 (Operation End)

ADR_INPUT_007 documentó que la pregunta "¿dónde termina?" no pudo resolverse. Este ADR muestra que `bankTransaction.update` es obligatorio cuando existe BankTransaction, pero no cuando es un standalone entry.

### Relación con ADR_INPUT_008 (RecalculateBalance)

ADR_INPUT_008 determinó que `recalculateBalance` es posterior y diferible. Este ADR confirma que `recalculateBalance` no es obligatorio para la invariante.

---

## RESPUESTA A LA PREGUNTA

### Cadena lógica

Paso 1: Se identificaron las operaciones dentro de `createFromBankTransaction`

(Evidencia: Tabla de Afirmaciones y Evidencia)

Las operaciones dentro de `createFromBankTransaction()` son:

1. `journalEntry.create` con `lines.create` anidados (líneas 45-58)
2. `bankTransaction.update` estableciendo `journalEntryId` (líneas 61-66) — condicional
3. `recalculateBalance` para ambos GL accounts (líneas 69-72) — condicional

Paso 2: Se determinó qué operaciones son siempre ejecutadas

(Evidencia: Tabla de Afirmaciones y Evidencia)

- `journalEntry.create` + `lines.create`: SIEMPRE se ejecutan, sin condicional
- `bankTransaction.update`: se ejecuta SÓLO si `bankTxId` es truthy
- `recalculateBalance`: se ejecuta SÓLO si `skipRecalculate` no es `true`

Paso 3: Se determinó qué operaciones son obligatorias para la invariante

(Evidencia: Tabla de Clasificación por Obligatoriedad)

La invariante de ADR_INPUT_005 es: "BankTransaction → JournalEntry + JournalLines + vínculo BankTransaction–JournalEntry"

Para preservar esa invariante:

- `journalEntry.create` + `lines.create`: OBLIGATORIAS (crean el JournalEntry con sus líneas)
- `bankTransaction.update`: OBLIGATORIA cuando existe BankTransaction (establece el vínculo)
- `recalculateBalance`: NO OBLIGATORIA (es posterior y diferible, como se demostró en ADR_INPUT_008)

Paso 4: Conclusión

Con el universo inspeccionado pudo demostrarse que:

1. `journalEntry.create` con `lines.create` se ejecuta siempre, sin condicional, en todas las implementaciones inspeccionadas.
2. `bankTransaction.update` se ejecuta cuando `bankTxId` es truthy en todas las implementaciones inspeccionadas.
3. `recalculateBalance` es posterior y diferible, como se demostró en ADR_INPUT_008.

Con la evidencia inspeccionada en esta orden no pudo demostrarse si `bankTransaction.update` es obligatoria para preservar la invariante (es decir, si eliminarla rompería la invariante definida en ADR_INPUT_005). Tampoco pudo demostrarse si `recalculateBalance` pertenece o no a la invariante.

---

## CONFIANZA

**Alta.** La evidencia es directa y proviene de la inspección del código fuente. Las operaciones obligatorias fueron identificadas en cada ruta de entrada. La condicionalidad de `bankTransaction.update` y `recalculateBalance` fue demostrada con evidencia observable.

---

## LÍMITES

- Las conclusiones son válidas únicamente para el universo inspeccionado.
- No se inspeccionaron módulos no relacionados con la creación de JournalEntries.
- La existencia de otras operaciones obligatorias fuera del universo inspeccionado no fue descartada.
- No se evaluó si `recalculateBalance` tiene efectos secundarios que puedan afectar la validez contable.

---

## LISTA DE VERIFICACIÓN

| Ítem | Verificado |
|------|:----------:|
| ¿Se identificaron todas las operaciones dentro de la operación indivisible? | ✔ |
| ¿Se determinó qué operaciones son siempre ejecutadas? | ✔ |
| ¿Se determinó qué operaciones son obligatorias para la invariante? | ✔ |
| ¿Se verificó que la conclusión no excede la evidencia? | ✔ |

---

## REUTILIZACIÓN

Este ADR puede reutilizarse en:

- **S10-C.5** (¿Qué mecanismos garantizan atomicidad): las operaciones obligatorias documentadas aquí muestran qué se persiste dentro de la operación.
- **ADR_INPUT_007** (Operation End): la respuesta aquí documentada resuelve parcialmente la ambigüedad pendiente. El último cambio de estado obligatorio es `bankTransaction.update` (cuando existe BankTransaction).

---

## Metadatos

| Campo | Valor |
|-------|-------|
| **Ordenes** | S10-C.4 |
| **Fecha** | 2026-09-04 |
| **Estado** | Validado |
| **Versión** | 1.0 |
| **Baseline** | audit-s1-s9-complete |
| **Archivos inspeccionados** | 2 |
| **Archivos inspeccionados (ruta)** | journal-entry.service.ts, reconciliation.service.ts |
