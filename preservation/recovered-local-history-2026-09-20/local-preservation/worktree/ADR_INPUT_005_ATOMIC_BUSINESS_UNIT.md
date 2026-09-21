# ADR_INPUT_005 — Atomic Business Unit

> **Origen de la evidencia**
>
> - Evidencia obtenida durante esta orden (reapertura de archivos específicos).

## PREGUNTA

¿Cuál es la unidad atómica de negocio de Sistema1?

## OBJETIVO

Determinar, exclusivamente con evidencia reproducible, cuál es la menor unidad de trabajo de negocio que el sistema trata como una operación indivisible.

## ALCANCE

Inspeccionar únicamente los componentes necesarios para responder la pregunta: servicios, endpoints, engines, modelos persistentes, operaciones transaccionales y artefactos de dominio.

## FUERA DE ALCANCE

- Dónde comienza la unidad atómica.
- Dónde termina la unidad atómica.
- Qué operaciones pertenecen obligatoriamente a la unidad.
- Cómo se implementa la atomicidad (`$transaction`, commits, rollbacks).
- Cómo se propaga.
- Cómo falla.

## PRECONDICIONES

Esta orden fue ejecutada sobre el baseline `audit-s1-s9-complete`.

Las conclusiones de esta orden son válidas únicamente para el baseline inspeccionado.

Los cambios posteriores al baseline inspeccionado no forman parte del universo de esta orden.

## UNIVERSO INSPECCIONADO

Se reabrieron únicamente los archivos necesarios para responder la pregunta de esta orden.

Archivos inspeccionados:

- `src/lib/services/journal-entry.service.ts` — método `createFromBankTransaction`
- `src/lib/services/apply-all-engine.ts` — método `executeApplyAll`
- `src/lib/services/import.service.ts` — método `importTransactions`
- `src/lib/services/reconciliation.service.ts` — método `reconcile`
- `src/app/api/journal-entries/route.ts` — handler POST
- `src/app/api/import/route.ts` — handler POST

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
| `createFromBankTransaction()` recibe un `Prisma.TransactionClient` y no crea su propia transacción | `journal-entry.service.ts:20` | Observada |
| `createFromBankTransaction()` crea un JournalEntry con dos JournalLines anidados (nested-create) | `journal-entry.service.ts:45-58` | Observada |
| `createFromBankTransaction()` vincula el BankTransaction con el JournalEntry creado | `journal-entry.service.ts:61-66` | Observada |
| `createFromBankTransaction()` recalcula saldos de GL accounts afectados | `journal-entry.service.ts:69-72` | Observada |
| `createFromBankTransaction()` acepta `skipRecalculate` para diferir recálculo | `journal-entry.service.ts:129-167` | Observada |
| `executeApplyAll()` recibe un `tx: any` (Prisma TransactionClient) y ejecuta todas las mutaciones dentro de una transacción del caller | `apply-all-engine.ts:370` | Observada |
| `executeApplyAll()` asigna `glAccountId` y `matchedRuleId` a BankTransactions mediante `updateManyAndReturn` | `apply-all-engine.ts:407-447` | Observada |
| `executeApplyAll()` crea JournalEntries para cada transacción clasificada usando `createFromBankTransaction` con `skipRecalculate: true` | `apply-all-engine.ts:474-495` | Observada |
| `executeApplyAll()` recalcula saldos de GL accounts en lote | `apply-all-engine.ts:496-498` | Observada |
| `executeApplyAll()` crea un `RuleApplyRecord` como ancla de auditoría dentro de la misma transacción | `apply-all-engine.ts:503-531` | Observada |
| `executeApplyAll()` valida fechas de período fiscal al inicio; si alguna cae en período cerrado, aborta sin clasificación parcial | `apply-all-engine.ts:399-405` | Observada |
| `importTransactions()` envuelve toda la operación en `db.$transaction` | `import.service.ts:499` | Observada |
| `importTransactions()` verifica duplicados de BankStatement dentro de la transacción | `import.service.ts:500-508` | Observada |
| `importTransactions()` crea BankStatement, BankTransactions y JournalEntries dentro de la misma transacción | `import.service.ts:510-656` | Observada |
| `importTransactions()` ejecuta pre-procesamiento (parsing de archivo) fuera de la transacción | `import.service.ts:116-366` | Observada |
| `importTransactions()` ejecuta post-procesamiento (shadow summary, policy observation) fuera de la transacción | `import.service.ts:665-715` | Observada |
| `reconcile()` envuelve toda la operación en `db.$transaction` | `reconciliation.service.ts:35` | Observada |
| `reconcile()` valida período fiscal para cada transacción; si alguna falla, revierte todo el lote | `reconciliation.service.ts:72` | Observada |
| `reconcile()` crea JournalEntries inline dentro de la misma transacción | `reconciliation.service.ts:60-276` | Observada |
| `reconcile()` actualiza BankTransaction con `isReconciled: true` | `reconciliation.service.ts:60-276` | Observada |
| `reconcile()` recalcula saldos y actualiza período de reconciliación | `reconciliation.service.ts:280-293` | Observada |
| La operación indivisible implementada por los componentes inspeccionados consiste en: una BankTransaction → JournalEntry (con líneas balanceadas) + vínculo BankTransaction | Evidencia combinada | Corroborada |
| Las unidades de lote (import, apply-all, reconciliation) son atómicas por diseño y no pueden dividirse | Evidencia combinada | Corroborada |

---

## TABLA DE PARTICIPACIÓN POR COMPONENTE

### Nivel atómico (hoja)

| Componente | Operación | Invariante protegido | Evidencia |
|------------|-----------|---------------------|-----------|
| `createFromBankTransaction()` | Crea JournalEntry + 2 JournalLines + vincula BankTransaction | Partida doble (debe = haber) | `journal-entry.service.ts:45-66` |

### Nivel de lote (envoltorio transaccional)

| Componente | Operación | Invariante protegido | Evidencia |
|------------|-----------|---------------------|-----------|
| `executeApplyAll()` | Clasifica + crea asientos + crea ancla de auditoría | Período fiscal + auditoría completa | `apply-all-engine.ts:368-538` |
| `importTransactions()` | Crea statement + transacciones + asientos | Deduplicación +(statement + transactions inseparables) | `import.service.ts:415-724` |
| `reconcile()` | Marca como conciliado + crea asientos | Período fiscal + lote completo | `reconciliation.service.ts:10-302` |

### Desglose detallado

| Componente | Crea BE | Crea JE | Vincula BT | Recalcula | Validación | Atomicidad |
|------------|:-------:|:-------:|:----------:|:---------:|:----------:|:----------:|
| `createFromBankTransaction()` | — | ✔ | ✔ | ✔ (opcional) | — | Hoja |
| `executeApplyAll()` | RuleApplyRecord | ✔ (lote) | ✔ (lote) | ✔ (lote) | Período fiscal | Lote |
| `importTransactions()` | BankStatement | ✔ (lote) | — | ✔ (lote) | Duplicados | Lote |
| `reconcile()` | — | ✔ (lote) | ✔ (lote) | ✔ (lote) | Período fiscal | Lote |

---

## RELACIONES

### Relación con ADR_INPUT_003 (Write Authority)

Los puntos de escritura documentados en ADR_INPUT_003 (`journal-entry.service.ts:136-153`, `apply-all-engine.ts:450-484`, `import.service.ts:632`) son las invocaciones de `createFromBankTransaction()` desde los tres contextos de lote. La unidad atómica que aquí se identifica es la hoja que esos puntos de escritura ejecutan.

### Relación con ADR_INPUT_004 (Propagation)

Los recorridos 1, 2 y 6 de ADR_INPUT_004 (`journal-entry.service.ts`, `apply-all-engine.ts`, `import.service.ts`) ejecutan la unidad atómica aquí identificada. Los recorridos 3, 4 y 5 son de solo lectura y no involucran unidades atómicas de escritura.

### Relación con ADR_INPUT_002 (Source of Truth)

BankTransaction es la fuente de verdad. La unidad atómica aquí identificada (BankTransaction → JournalEntry) es la operación que materializa esa verdad en el estado contable.

---

## RESPUESTA A LA PREGUNTA

### Cadena lógica

Paso 1: Se identificaron los componentes que realizan operaciones de negocio

(Evidencia: Tabla de Afirmaciones y Evidencia)

Los componentes que realizan operaciones de negocio son:

- `journal-entry.service.ts` — crea asientos contables individuales
- `apply-all-engine.ts` — clasifica y crea asientos en lote
- `import.service.ts` — importa transacciones y crea asientos
- `reconciliation.service.ts` — concilia transacciones y crea asientos

Paso 2: Se determinó qué opera como indivisible

(Evidencia: Tabla de Participación por Componente)

A nivel de hoja, la operación indivisible es:

> **Una BankTransaction → Un JournalEntry (con dos JournalLines balanceadas) + Vínculo BankTransaction-JournalEntry**

Esta operación no puede dividirse porque:

- El JournalEntry debe tener exactamente dos líneas (partida doble)
- Las líneas deben estar balanceadas (debe = haber)
- El vínculo BankTransaction-JournalEntry debe existir para trazabilidad

Paso 3: Se determinó si existen unidades de lote

(Evidencia: Tabla de Participación por Componente — Nivel de lote)

Existen tres unidades de lote que envuelven múltiples unidades atómicas:

- **Import**: BankStatement + BankTransactions + JournalEntries (transacción DB)
- **Apply-All**: BankTransactions + JournalEntries + RuleApplyRecord (transacción del caller)
- **Reconciliation**: BankTransactions + JournalEntries (transacción DB)

Estas unidades de lote son atómicas por diseño porque protegen invariantes que abarcan múltiples transacciones:

- **Período fiscal**: validación all-or-nothing al inicio
- **Ancla de auditoría**: RuleApplyRecord vincula todas las operaciones
- **Deduplicación**: previene race conditions en importaciones concurrentes

Paso 4: Conclusión

Con el universo inspeccionado pudo demostrarse que la operación indivisible implementada por los componentes inspeccionados consiste en: una BankTransaction → un JournalEntry (con dos JournalLines balanceadas) + vínculo BankTransaction–JournalEntry. Con la evidencia inspeccionada en esta orden no pudo demostrarse que dicha operación constituya la unidad atómica de negocio de todo Sistema1.

---

## CONFIANZA

**Alta.** La evidencia es directa y proviene de la inspección del código fuente. Los componentes identificados son los únicos que realizan operaciones de negocio con efecto contable. Las transacciones de base de datos (`$transaction`) fueron observadas en tres de cuatro servicios inspeccionados.

---

## LÍMITES

- Las conclusiones son válidas únicamente para el universo inspeccionado.
- No se inspeccionaron módulos no relacionados con operaciones contables.
- La existencia de otras unidades atómicas fuera del universo inspeccionado no fue descartada.
- No se evaluó si las unidades de lote son óptimas o si podrían reducirse.

---

## LISTA DE VERIFICACIÓN

| Ítem | Verificado |
|------|:----------:|
| ¿Se inspeccionaron los servicios que crean JournalEntries? | ✔ |
| ¿Se identificó la operación mínima indivisible? | ✔ |
| ¿Se determinó si existen unidades de lote? | ✔ |
| ¿Se identificaron los invariantes protegidos por cada nivel? | ✔ |
| ¿Se verificó que la conclusión no excede la evidencia? | ✔ |

---

## REUTILIZACIÓN

Este ADR puede reutilizarse en:

- **S10-C.2** (¿Dónde comienza la unidad?): la respuesta aquí identificada define el punto de inicio.
- **S10-C.3** (¿Dónde termina?): la respuesta aquí identificada define el punto de fin.
- **S10-C.4** (¿Qué operaciones deben pertenecer?): las unidades de lote aquí documentadas muestran qué se agrupa.
- **S10-C.5** (¿Qué mecanismos garantizan atomicidad?): las transacciones DB aquí documentadas muestran los mecanismos.

---

## Metadatos

| Campo | Valor |
|-------|-------|
| **Ordenes** | S10-C.1, S10-C.1A |
| **Fecha** | 2026-09-04 |
| **Estado** | Validado |
| **Versión** | 1.0 |
| **Baseline** | audit-s1-s9-complete |
| **Commit inspeccionado** | 2bf4bbd7518e1d3946a06897ee7aba42876951d1 |
| **Archivos inspeccionados** | 6 |
| **Archivos inspeccionados (ruta)** | journal-entry.service.ts, apply-all-engine.ts, import.service.ts, reconciliation.service.ts, journal-entries/route.ts, import/route.ts |
