# ADR_INPUT_006 — Operation Start

> **Origen de la evidencia**
>
> - Evidencia obtenida durante esta orden (reapertura de archivos específicos).

## PREGUNTA

¿En qué punto observable comienza la operación indivisible implementada identificada en ADR_INPUT_005?

## OBJETIVO

Determinar, exclusivamente mediante evidencia reproducible del código inspeccionado, cuál es el primer evento observable que inicia la operación indivisible implementada.

## ALCANCE

Inspeccionar únicamente los componentes que participan en la creación de la operación identificada en ADR_INPUT_005. El análisis debe terminar cuando pueda demostrarse cuál es el primer cambio de estado perteneciente a esa operación.

## FUERA DE ALCANCE

- Dónde termina la operación.
- Quién la ejecuta.
- Quién decide la clasificación.
- Cómo se propaga.
- Atomicidad de lotes.
- Arquitectura general del sistema.
- Transacciones de PostgreSQL.
- Transacciones Prisma.
- Reglas de negocio no relacionadas con el inicio.

## PRECONDICIONES

Esta orden fue ejecutada sobre el baseline `audit-s1-s9-complete`.

Se utilizó ADR_INPUT_005 como antecedente.

Las conclusiones de esta orden son válidas únicamente para el baseline inspeccionado.

Los cambios posteriores al baseline inspeccionado no forman parte del universo de esta orden.

## UNIVERSO INSPECCIONADO

Se reabrieron únicamente los archivos necesarios para responder la pregunta de esta orden.

Archivos inspeccionados:

- `src/lib/services/journal-entry.service.ts` — método `createFromBankTransaction`
- `src/lib/services/apply-all-engine.ts` — invocación de `createFromBankTransaction`
- `src/lib/services/apply-all-use-case.ts` — transacción y punto de inicio
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
| `createFromBankTransaction()` recibe un `Prisma.TransactionClient` y no crea su propia transacción | `journal-entry.service.ts:20` | Observada |
| La primera escritura de estado dentro de `createFromBankTransaction()` es `journalEntry.create` con `lines.create` anidados | `journal-entry.service.ts:45-58` | Observada |
| La segunda escritura de estado es `bankTransaction.update` para vincular el JournalEntry | `journal-entry.service.ts:61-66` | Observada |
| La tercera escritura de estado es `recalculateBalance` para GL accounts | `journal-entry.service.ts:69-72` | Observada |
| En Apply-All, el primer cambio de estado ANTES de `createFromBankTransaction()` es `bankTransaction.updateManyAndReturn` (asigna `glAccountId` + `matchedRuleId`) | `apply-all-engine.ts:429-446` | Observada |
| En Import, el primer cambio de estado ANTES de `createFromBankTransaction()` es `bankStatement.create` | `import.service.ts:510` | Observada |
| En Reconciliation, `createFromBankTransaction()` NO es invocado — JournalEntry se crea inline | `reconciliation.service.ts:219-258` | Observada |
| En Transaction PATCH, el primer cambio de estado ANTES de `createFromBankTransaction()` es `journalEntry.update { status: 'void' }` o `bankTransaction.update { glAccountId }` | `transactions/[id]/route.ts:70-84` | Observada |
| En Bank Create, el primer cambio de estado ANTES de `createFromBankTransaction()` es `bankAccount.create` | `banks/route.ts:65` | Observada |
| En Bank Update, el primer cambio de estado es `journalEntry.create` vía `createFromBankTransaction()` (sin escritura previa) | `banks/[id]/route.ts:147-155` | Observada |
| `createMissingForBank()` es código muerto — definido pero nunca invocado | Grep en `src/` | Observada |

---

## TABLA DE PARTICIPACIÓN POR COMPONENTE

### Punto de inicio por ruta de entrada

| Ruta de entrada | Endpoint | Primer cambio de estado ANTES de la operación | Primer cambio de estado DE LA operación |
|-----------------|----------|---------------------------------------------|----------------------------------------|
| Apply-All | `POST /api/bank-rules/apply-all` | `bankTransaction.updateManyAndReturn` (clasificación) | `journalEntry.create` |
| Import | `POST /api/import` | `bankStatement.create` | `journalEntry.create` |
| Reconciliation | `POST /api/reconciliation` | — (solo lecturas + validación) | `journalEntry.create` (inline, no vía el método) |
| Transaction PATCH | `PATCH /api/transactions/[id]` | `journalEntry.update { status: 'void' }` o `bankTransaction.update` | `journalEntry.create` |
| Bank Create | `POST /api/banks` | `bankAccount.create` | `journalEntry.create` |
| Bank Update | `PUT /api/banks/[id]` | — (solo lecturas + validación) | `journalEntry.create` |

### Desglose detallado

| Componente | ¿Abre transacción? | ¿Tiene escritura previa a la operación? | Primera escritura de la operación |
|------------|:-------------------:|:---------------------------------------:|-----------------------------------|
| `apply-all-use-case.ts` | ✔ (`db.$transaction`) | ✔ (clasificación de BankTransaction) | `journalEntry.create` |
| `import.service.ts` | ✔ (`db.$transaction`) | ✔ (creación de BankStatement) | `journalEntry.create` |
| `reconciliation.service.ts` | ✔ (`db.$transaction`) | ✗ (solo lecturas + validación) | `journalEntry.create` (inline) |
| `transactions/[id]/route.ts` | ✔ (`db.$transaction`) | ✔ (voiding de JE existente o actualización de BT) | `journalEntry.create` |
| `banks/route.ts` | ✔ (`db.$transaction`) | ✔ (creación de BankAccount) | `journalEntry.create` |
| `banks/[id]/route.ts` | ✔ (`db.$transaction`) | ✗ (solo lecturas + validación) | `journalEntry.create` |

---

## RELACIONES

### Relación con ADR_INPUT_005 (Atomic Business Unit)

ADR_INPUT_005 identificó la operación indivisible como: BankTransaction → JournalEntry + 2 JournalLines + vínculo BankTransaction–JournalEntry. Este ADR determina dónde comienza esa operación.

### Relación con ADR_INPUT_003 (Write Authority)

Los puntos de escritura documentados en ADR_INPUT_003 son las invocaciones de `createFromBankTransaction()` desde distintos contextos. Este ADR muestra que el primer cambio de estado de la operación es siempre `journalEntry.create`, independientemente del contexto de invocación.

### Relación con ADR_INPUT_004 (Propagation)

Los recorridos de propagación documentados en ADR_INPUT_004 comienzan después de que la operación ya ha creado el JournalEntry. Este ADR documenta el punto anterior al inicio de la propagación.

---

## RESPUESTA A LA PREGUNTA

### Cadena lógica

Paso 1: Se identificaron las rutas de entrada que invocan la operación

(Evidencia: Tabla de Afirmaciones y Evidencia)

Las rutas de entrada que invocan `createFromBankTransaction()` son:

- Apply-All (`POST /api/bank-rules/apply-all`)
- Import (`POST /api/import`)
- Transaction PATCH (`PATCH /api/transactions/[id]`)
- Bank Create (`POST /api/banks`)
- Bank Update (`PUT /api/banks/[id]`)

Reconciliation NO invoca `createFromBankTransaction()` — crea JournalEntries inline.

Paso 2: Se identificó qué ocurre ANTES de la operación en cada ruta

(Evidencia: Tabla de Participación por Componente)

En cada ruta de entrada, existe una o más escrituras de estado ANTES de que `createFromBankTransaction()` sea invocado:

- Apply-All: clasificación de BankTransaction (`glAccountId` + `matchedRuleId`)
- Import: creación de BankStatement
- Transaction PATCH: voiding de JE existente o actualización de BT
- Bank Create: creación de BankAccount
- Bank Update y Reconciliation: solo lecturas + validación (sin escritura previa)

Paso 3: Se identificó el primer cambio de estado dentro de la operación

(Evidencia: Tabla de Afirmaciones y Evidencia)

En todas las rutas que invocan `createFromBankTransaction()`, el primer cambio de estado dentro de la operación es:

> **`journalEntry.create` con `lines.create` anidados** (`journal-entry.service.ts:45-58`)

Este es el primer evento observable que pertenece a la operación indivisible identificada en ADR_INPUT_005.

Paso 4: Conclusión

Con el universo inspeccionado pudo demostrarse que todas las implementaciones inspeccionadas realizan como primer cambio de estado la creación de un `JournalEntry`, ya sea mediante `createFromBankTransaction()` o mediante una implementación inline. Con la evidencia inspeccionada en esta orden no pudo demostrarse que no existan otras implementaciones con un punto de inicio diferente fuera del universo inspeccionado.

---

## CONFIANZA

**Alta.** La evidencia es directa y proviene de la inspección del código fuente. El primer cambio de estado dentro de `createFromBankTransaction()` fue identificado en cada ruta de entrada. La distinción entre escrituras preparatorias y escrituras de la operación es clara.

---

## LÍMITES

- Las conclusiones son válidas únicamente para el universo inspeccionado.
- No se inspeccionaron módulos no relacionados con la creación de JournalEntries.
- La existencia de otros puntos de inicio fuera del universo inspeccionado no fue descartada.
- Reconciliation crea JournalEntries inline sin invocar `createFromBankTransaction()` — este caso fue documentado pero no forma parte de la operación identificada en ADR_INPUT_005.

---

## LISTA DE VERIFICACIÓN

| Ítem | Verificado |
|------|:----------:|
| ¿Se identificaron todas las rutas de entrada que invocan la operación? | ✔ |
| ¿Se identificó qué ocurre ANTES de la operación en cada ruta? | ✔ |
| ¿Se identificó el primer cambio de estado dentro de la operación? | ✔ |
| ¿Se verificó que la conclusión no excede la evidencia? | ✔ |

---

## REUTILIZACIÓN

Este ADR puede reutilizarse en:

- **S10-C.3** (¿Dónde termina?): el punto de inicio documentado aquí define el extremo inicial de la operación.
- **S10-C.4** (¿Qué operaciones deben pertenecer?): las escrituras preparatorias documentadas aquí muestran qué opera fuera de la operación indivisible.
- **S10-C.5** (¿Qué mecanismos garantizan atomicidad?): las transacciones DB documentadas aquí muestran el contexto transaccional.

---

## Metadatos

| Campo | Valor |
|-------|-------|
| **Ordenes** | S10-C.2, S10-C.2A |
| **Fecha** | 2026-09-04 |
| **Estado** | Validado |
| **Versión** | 1.0 |
| **Baseline** | audit-s1-s9-complete |
| **Archivos inspeccionados** | 8 |
| **Archivos inspeccionados (ruta)** | journal-entry.service.ts, apply-all-engine.ts, apply-all-use-case.ts, import.service.ts, reconciliation.service.ts, transactions/[id]/route.ts, banks/route.ts, banks/[id]/route.ts |
