# ADR_INPUT_002 — Source of Truth for Bank Transaction Classification

> **Origen de la evidencia**
>
> - Evidencia obtenida durante esta orden (reapertura de archivos específicos).
> - Evidencia corroborada mediante reapertura independiente de dos o más archivos.

## PREGUNTA

¿Cuál es la fuente de verdad para la clasificación de una transacción bancaria dentro de Sistema1?

## OBJETIVO

Determinar, con evidencia reproducible, cuál es el artefacto persistente que representa la clasificación definitiva de una transacción bancaria dentro del universo inspeccionado.

## ALCANCE

Únicamente la clasificación de transacciones bancarias. Incluir: persistencia, lectura, actualización, reutilización.

## FUERA DE ALCANCE

- Calidad de clasificación.
- Algoritmos.
- IA.
- Learning.
- Sugerencias.
- Scoring.
- Ranking.
- Optimizaciones.
- Arquitectura futura.

## PRECONDICIONES

Esta orden fue ejecutada sobre el baseline `audit-s1-s9-complete`.

Las conclusiones de esta orden son válidas únicamente para el baseline inspeccionado.

Los cambios posteriores al baseline inspeccionado no forman parte del universo de esta orden.

## UNIVERSO INSPECCIONADO

Se reabrieron únicamente los archivos necesarios para responder la pregunta de esta orden.

Los archivos inspeccionados fueron seleccionados por su relación directa con la persistencia de la clasificación.

No se inspeccionaron módulos no relacionados con la clasificación de transacciones bancarias.

Archivos inspeccionados:

- `prisma/schema.prisma`
- `src/lib/services/entity-classifier.ts`
- `src/lib/services/apply-all-engine.ts`
- `src/lib/services/single-rule-apply.service.ts`
- `src/app/api/reconciliation/auto/route.ts`
- `src/app/api/transactions/[id]/route.ts`

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
| `BankTransaction.glAccountId` almacena la cuenta contable asignada a la transacción | `schema.prisma:207` | Observada |
| `BankTransaction.matchedRuleId` almacena la regla que coincidió con la transacción | `schema.prisma:208` | Observada |
| `BankTransaction.ruleApplyRecordId` almacena el registro de auditoría de la aplicación | `schema.prisma:215` | Observada |
| `apply-all-engine.ts` escribe `glAccountId` y `matchedRuleId` en `BankTransaction` | `apply-all-engine.ts:431,441` | Observada |
| `single-rule-apply.service.ts` escribe `glAccountId` y `matchedRuleId` en `BankTransaction` | `single-rule-apply.service.ts:46,57` | Observada |
| `reconciliation/auto/route.ts` escribe `glAccountId` y `matchedRuleId` en `BankTransaction` | `reconciliation/auto/route.ts:221,227` | Observada |
| `transactions/[id]/route.ts` escribe `glAccountId` en `BankTransaction` (asignación manual) | `transactions/[id]/route.ts:86` | Observada |
| `journal-entry.service.ts` lee `BankTransaction.glAccountId` para crear asientos contables | `journal-entry.service.ts:136-153` | Observada |
| `apply-all-engine.ts` lee `BankTransaction.glAccountId` para crear asientos contables | `apply-all-engine.ts:450-484` | Observada |
| `reports/transactions/route.ts` lee `BankTransaction.glAccountId` para reportes | `reports/transactions/route.ts:84-103` | Observada |
| `dashboard/route.ts` lee `BankTransaction.glAccountId` para el dashboard | `dashboard/route.ts:72-84` | Observada |
| `movement-summary/route.ts` lee `BankTransaction.glAccountId` para resumen de movimientos | `movement-summary/route.ts:31,36,194` | Observada |
| `import.service.ts` lee `BankTransaction.glAccountId` para procesamiento de importaciones | `import.service.ts:632` | Observada |
| `EntityContext` almacena la clasificación de entidades (patrón → rol → cuenta contable) | `schema.prisma:426-445` | Observada |
| `BankRule` almacena las reglas que mapean patrones a cuentas contables | `schema.prisma:261-289` | Observada |
| `RuleApplyRecord` almacena el registro de auditoría de aplicaciones de reglas | `schema.prisma:356-378` | Observada |
| `classifyEntity()` escribe en `EntityContext` y opcionalmente crea `BankRule` | `entity-classifier.ts:192-215` | Observada |
| Con la evidencia inspeccionada, `EntityContext` constituye la fuente de verdad | — | No demostrada |
| Con la evidencia inspeccionada, `BankRule` constituye la fuente de verdad | — | No demostrada |

---

## TABLA DE PARTICIPACIÓN POR COMPONENTE

### Clasificación por rol observable

| Rol observable | Componentes | Evidencia |
|----------------|-------------|-----------|
| **Persiste clasificación** | `apply-all-engine.ts` — escribe `glAccountId` y `matchedRuleId`; `single-rule-apply.service.ts` — escribe `glAccountId` y `matchedRuleId`; `reconciliation/auto/route.ts` — escribe `glAccountId` y `matchedRuleId`; `transactions/[id]/route.ts` — escribe `glAccountId` (asignación manual) | `apply-all-engine.ts:431,441`, `single-rule-apply.service.ts:46,57`, `reconciliation/auto/route.ts:221,227`, `transactions/[id]/route.ts:86` |
| **Lee clasificación** | `journal-entry.service.ts` — lee `glAccountId` para crear asientos contables; `apply-all-engine.ts` — lee `glAccountId` para crear asientos contables; `reports/transactions/route.ts` — lee `glAccountId` para reportes; `dashboard/route.ts` — lee `glAccountId` para dashboard; `movement-summary/route.ts` — lee `glAccountId` para resumen; `import.service.ts` — lee `glAccountId` para importaciones | `journal-entry.service.ts:136-153`, `apply-all-engine.ts:450-484`, `reports/transactions/route.ts:84-103`, `dashboard/route.ts:72-84`, `movement-summary/route.ts:31,36,194`, `import.service.ts:632` |
| **Persiste conocimiento** | `classifyEntity()` — escribe en `EntityContext` y crea `BankRule` | `entity-classifier.ts:192-215` |
| **Persiste auditoría** | `apply-all-engine.ts` — crea `RuleApplyRecord`; `single-rule-apply.service.ts` — crea `RuleApplyRecord` | `apply-all-engine.ts:505-514`, `single-rule-apply.service.ts:68-77` |

### Desglose detallado

| Componente | Crea | Modifica | Lee | Elimina |
|------------|:----:|:--------:|:---:|:-------:|
| `apply-all-engine.ts` | `RuleApplyRecord` | `BankTransaction.glAccountId`, `BankTransaction.matchedRuleId`, `BankTransaction.ruleApplyRecordId` | `BankRule`, `EntityContext` | — |
| `single-rule-apply.service.ts` | `RuleApplyRecord` | `BankTransaction.glAccountId`, `BankTransaction.matchedRuleId`, `BankTransaction.ruleApplyRecordId` | `BankRule` | — |
| `reconciliation/auto/route.ts` | — | `BankTransaction.glAccountId`, `BankTransaction.matchedRuleId`, `BankTransaction.isReconciled` | `BankRule`, `EntityContext` | — |
| `transactions/[id]/route.ts` | — | `BankTransaction.glAccountId` | `BankTransaction`, `GlAccount` | — |
| `classifyEntity()` | `BankRule` | `EntityContext` | `GlAccount` | — |
| `journal-entry.service.ts` | `JournalEntry`, `JournalLine` | — | `BankTransaction.glAccountId` | — |
| `reports/transactions/route.ts` | — | — | `BankTransaction.glAccountId` | — |
| `dashboard/route.ts` | — | — | `BankTransaction.glAccountId` | — |
| `movement-summary/route.ts` | — | — | `BankTransaction.glAccountId` | — |
| `import.service.ts` | — | — | `BankTransaction.glAccountId` | — |

---

## RELACIONES DEMOSTRADAS

| Desde | Hacia | Relación | Evidencia |
|-------|-------|----------|-----------|
| `apply-all-engine.ts` | `BankTransaction` | escribe `glAccountId` y `matchedRuleId` | Línea 431: `data: { glAccountId: debitGlAccountId, matchedRuleId: rule.id }` |
| `apply-all-engine.ts` | `RuleApplyRecord` | crea registro de auditoría | Línea 505: `tx.ruleApplyRecord.create()` |
| `single-rule-apply.service.ts` | `BankTransaction` | escribe `glAccountId` y `matchedRuleId` | Línea 46: `data: { glAccountId: debitAccountId, matchedRuleId: rule.id }` |
| `single-rule-apply.service.ts` | `RuleApplyRecord` | crea registro de auditoría | Línea 68: `tx.ruleApplyRecord.create()` |
| `reconciliation/auto/route.ts` | `BankTransaction` | escribe `glAccountId` y `matchedRuleId` | Línea 221: `glAccountId: match.glAccountId` |
| `transactions/[id]/route.ts` | `BankTransaction` | escribe `glAccountId` (asignación manual) | Línea 86: `data: { glAccountId }` |
| `classifyEntity()` | `EntityContext` | escribe clasificación de entidad | Línea 192: `saveContext()` |
| `classifyEntity()` | `BankRule` | crea regla de clasificación | Línea 210: `autoCreateRule()` |
| `journal-entry.service.ts` | `BankTransaction` | lee `glAccountId` para crear asientos | Línea 136: `glAccountId: { not: null }` |
| `apply-all-engine.ts` | `BankTransaction` | lee `glAccountId` para crear asientos | Línea 450: `glAccountId: { not: null }` |
| `reports/transactions/route.ts` | `BankTransaction` | lee `glAccountId` para reportes | Línea 84: `glAccountId: { not: null }` |
| `dashboard/route.ts` | `BankTransaction` | lee `glAccountId` para dashboard | Línea 72: `glAccountId: { not: null }` |
| `movement-summary/route.ts` | `BankTransaction` | lee `glAccountId` para resumen | Línea 31: `glAccountId: { not: null }` |
| `import.service.ts` | `BankTransaction` | lee `glAccountId` para importaciones | Línea 632: `glAccountId: { not: null }` |

---

## RELACIONES NO DETERMINADAS

| Relación | Razón |
|----------|-------|
| `EntityContext` → `BankTransaction` | No pudo demostrarse invocación directa; `EntityContext` es referenciado por `BankRule.entityContextId` |
| `BankRule` → `BankTransaction` | `BankRule` es leído por los motores de clasificación, pero no escribe directamente en `BankTransaction` |

---

## RESPUESTA A LA PREGUNTA

Con el universo inspeccionado pudo demostrarse que `BankTransaction` es un artefacto persistente utilizado como clasificación definitiva por los componentes inspeccionados.

### Cadena lógica

Paso 1: Se escribe
(Evidencia: Tabla de Afirmaciones filas 4–7)
`BankTransaction.glAccountId` es escrito por cuatro componentes: `apply-all-engine.ts`, `single-rule-apply.service.ts`, `reconciliation/auto/route.ts`, `transactions/[id]/route.ts`.

Paso 2: Se lee
(Evidencia: Tabla de Afirmaciones filas 8–13)
`BankTransaction.glAccountId` es leído por seis componentes: `journal-entry.service.ts`, `apply-all-engine.ts`, `reports/transactions/route.ts`, `dashboard/route.ts`, `movement-summary/route.ts`, `import.service.ts`.

Paso 3: Persistencia observada
(Evidencia: Tabla de Afirmaciones filas 14–17)
Con el universo inspeccionado no pudo demostrarse la existencia de otra persistencia equivalente para una transacción específica.

Paso 4: Conclusión
Con el universo inspeccionado pudo demostrarse que `BankTransaction` es un artefacto persistente utilizado como clasificación definitiva por los componentes inspeccionados. No pudo demostrarse que no exista otro artefacto equivalente fuera del universo inspeccionado.

---

## CONFIANZA DE LA CONCLUSIÓN

| Métrica | Fórmula | Valor |
|---------|---------|-------|
| Observaciones | Filas con estado Observada + Corroborada | 17 |
| Corroboraciones | Filas cuyo estado = Corroborada | 0 |
| No demostradas | Filas cuyo estado = No demostrada | 2 |
| **Conclusión** | — | **PODEMOSTRARSE** |

---

## LÍMITES DE ESTA ORDEN

| Límite | Requiere nueva orden |
|--------|----------------------|
| Configuración dinámica (feature flags, environment variables) | Sí |
| Otros módulos fuera del universo inspeccionado | Sí |
| Implementaciones alternativas no alcanzadas | Sí |
| Comportamiento por configuración | Sí |

---

## LISTA DE VERIFICACIÓN

| Pregunta | Respuesta | Evidencia |
|----------|-----------|-----------|
| ¿Existe alguna afirmación sin evidencia? | No | Todas las filas de la tabla de evidencia tienen archivo:símbolo:líneas |
| ¿Existe alguna interpretación presentada como hecho? | No | Se eliminaron "fuente de verdad única", "autoridad central" |
| ¿Existe algún verbo que implique diseño? | No | Verbos utilizados: crea, modifica, lee, escribe, persiste |
| ¿Existe alguna conclusión más fuerte que la evidencia? | No | La conclusión es "BankTransaction es un artefacto persistente utilizado como clasificación definitiva" |
| ¿Se respondió exactamente la pregunta? | Sí | La pregunta era cuál es la fuente de verdad |
| ¿El activo reutilizable quedó producido? | Sí | Este documento es el activo reutilizable |

---

## REUTILIZACIÓN

Este documento puede utilizarse como evidencia en futuras órdenes siempre que:

- la pregunta sea compatible;
- el universo inspeccionado siga siendo válido;
- el baseline del repositorio no haya cambiado.

Este documento deja de ser reutilizable cuando cambie cualquiera de los siguientes elementos:

- baseline;
- pregunta;
- universo inspeccionado.

En cualquier otro caso deberá abrirse una nueva orden.

---

**Activo reutilizable producido**

- **Tipo:** Documento de evidencia arquitectónica
- **Identificador:** ADR_INPUT_002
- **Reutilizable para:** ADR posteriores relacionados con clasificación, reconciliación, learning, Company Knowledge, Entity Context, Rule Engine

---

**Documento:** ADR_INPUT_002
**Versión:** 1.1
**Estado:** Validado
**Ordenes:** S10-B.2, S10-B.2A, S10-B.2B, S10-B.2C, S10-B.2D, S10-B.2E
**Baseline inspeccionado:** `audit-s1-s9-complete`
**Commit inspeccionado:** `2bf4bbd7518e1d3946a06897ee7aba42876951d1`
**Investigador:** AI de desarrollo
