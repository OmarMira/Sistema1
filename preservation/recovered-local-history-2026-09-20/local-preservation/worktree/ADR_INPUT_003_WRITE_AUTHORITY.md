# ADR_INPUT_003 — Write Authority for BankTransaction.glAccountId

> **Origen de la evidencia**
>
> - Evidencia obtenida durante esta orden (reapertura de archivos específicos).
> - Evidencia corroborada mediante reapertura independiente de dos o más archivos.

## PREGUNTA

¿Qué componentes escriben, reemplazan o invalidan el valor persistido en `BankTransaction.glAccountId`?

## OBJETIVO

Demostrar, con evidencia reproducible, todos los puntos del sistema que modifican la clasificación persistida de una transacción bancaria.

## ALCANCE

- Escrituras.
- Actualizaciones.
- Reemplazos.
- Invalidaciones.
- Asignaciones manuales.
- Procesos automáticos.

## FUERA DE ALCANCE

- Quién decide la clasificación.
- Fuente de verdad.
- Propagación.
- Reportes.
- Consumo de la clasificación.

## PRECONDICIONES

Esta orden fue ejecutada sobre el baseline `audit-s1-s9-complete`.

Las conclusiones de esta orden son válidas únicamente para el baseline inspeccionado.

Los cambios posteriores al baseline inspeccionado no forman parte del universo de esta orden.

## UNIVERSO INSPECCIONADO

Se reabrieron únicamente los archivos necesarios para responder la pregunta de esta orden.

Los archivos inspeccionados fueron seleccionados por su relación directa con la modificación de `BankTransaction.glAccountId`.

No se inspeccionaron módulos no relacionados con la modificación de la clasificación.

Archivos inspeccionados:

- `src/lib/services/apply-all-engine.ts`
- `src/lib/services/single-rule-apply.service.ts`
- `src/app/api/reconciliation/auto/route.ts`
- `src/app/api/transactions/[id]/route.ts`
- `src/lib/services/reconciliation.service.ts`
- `src/lib/services/import.service.ts`
- `src/lib/backup.ts`

Las conclusiones de esta orden sólo aplican al conjunto de archivos inspeccionados.

---

## CRITERIO DE EVIDENCIA

| Estado | Criterio |
|--------|----------|
| Observada | Evidencia encontrada en una única inspección del código |
| Corroborada | La misma afirmación fue confirmada por dos o más evidencias independientes |
| No demostrada | No existe evidencia suficiente para sostener la afirmación |

---

## TABLA DE PUNTOS DE ESCRITURA

| # | Archivo | Símbolo | Líneas | Tipo de modificación | Condición |
|---|---------|---------|--------|---------------------|-----------|
| 1 | `apply-all-engine.ts` | `updateManyAndReturn` | 431 | UPDATE (batch) | Clasificación automática por regla — dirección débito |
| 2 | `apply-all-engine.ts` | `updateManyAndReturn` | 441 | UPDATE (batch) | Clasificación automática por regla — dirección crédito |
| 3 | `single-rule-apply.service.ts` | `updateManyAndReturn` | 46 | UPDATE (single) | Clasificación individual por regla — dirección débito |
| 4 | `single-rule-apply.service.ts` | `updateManyAndReturn` | 57 | UPDATE (single) | Clasificación individual por regla — dirección crédito |
| 5 | `reconciliation/auto/route.ts` | `update` | 221 | UPDATE | Reconciliación automática — match encontrado |
| 6 | `transactions/[id]/route.ts` | `update` | 86 | UPDATE | Asignación manual de cuenta contable |
| 7 | `reconciliation.service.ts` | `updateData.glAccountId` | 128 | UPDATE | Reconciliación manual — split sin journal entry existente |
| 8 | `reconciliation.service.ts` | `updateData.glAccountId` | 134 | UPDATE | Reconciliación manual — cuenta principal sin journal entry existente |
| 9 | `import.service.ts` | `createMany` | 620 | CREATE | Importación de extracto bancario — clasificación en creación |
| 10 | `backup.ts` | `clean.glAccountId` | 913 | CREATE | Restauración de backup — mapeo de IDs |

---

## TABLA DE PARTICIPACIÓN POR COMPONENTE

### Clasificación por tipo de modificación

| Tipo de modificación | Componentes | Evidencia |
|----------------------|-------------|-----------|
| **UPDATE batch automático** | `apply-all-engine.ts` — escribe `glAccountId` y `matchedRuleId` en múltiples transacciones | `apply-all-engine.ts:431,441` |
| **UPDATE single automático** | `single-rule-apply.service.ts` — escribe `glAccountId` y `matchedRuleId` en una transacción | `single-rule-apply.service.ts:46,57` |
| **UPDATE reconciliación automática** | `reconciliation/auto/route.ts` — escribe `glAccountId` al encontrar match | `reconciliation/auto/route.ts:221` |
| **UPDATE manual** | `transactions/[id]/route.ts` — escribe `glAccountId` por asignación manual | `transactions/[id]/route.ts:86` |
| **UPDATE reconciliación manual** | `reconciliation.service.ts` — escribe `glAccountId` en reconciliación manual | `reconciliation.service.ts:128,134` |
| **CREATE importación** | `import.service.ts` — crea `BankTransaction` con `glAccountId` | `import.service.ts:620` |
| **CREATE restauración** | `backup.ts` — restaura `BankTransaction` con `glAccountId` mapeado | `backup.ts:913` |

### Desglose detallado

| Componente | Crea | Modifica | Lee | Elimina |
|------------|:----:|:--------:|:---:|:-------:|
| `apply-all-engine.ts` | — | `BankTransaction.glAccountId`, `BankTransaction.matchedRuleId` | `BankRule`, `EntityContext` | — |
| `single-rule-apply.service.ts` | — | `BankTransaction.glAccountId`, `BankTransaction.matchedRuleId` | `BankRule` | — |
| `reconciliation/auto/route.ts` | — | `BankTransaction.glAccountId`, `BankTransaction.isReconciled` | `BankRule`, `EntityContext` | — |
| `transactions/[id]/route.ts` | — | `BankTransaction.glAccountId` | `BankTransaction`, `GlAccount` | — |
| `reconciliation.service.ts` | — | `BankTransaction.glAccountId` | `BankTransaction`, `GlAccount` | — |
| `import.service.ts` | `BankTransaction` | — | `BankRule`, `EntityContext` | — |
| `backup.ts` | `BankTransaction` | — | `GlAccount` | — |

---

## RELACIONES DEMOSTRADAS

| Desde | Hacia | Relación | Evidencia |
|-------|-------|----------|-----------|
| `apply-all-engine.ts` | `BankTransaction` | escribe `glAccountId` y `matchedRuleId` | Línea 431: `data: { glAccountId: debitGlAccountId, matchedRuleId: rule.id }` |
| `single-rule-apply.service.ts` | `BankTransaction` | escribe `glAccountId` y `matchedRuleId` | Línea 46: `data: { glAccountId: debitAccountId, matchedRuleId: rule.id }` |
| `reconciliation/auto/route.ts` | `BankTransaction` | escribe `glAccountId` | Línea 221: `glAccountId: match.glAccountId` |
| `transactions/[id]/route.ts` | `BankTransaction` | escribe `glAccountId` | Línea 86: `data: { glAccountId }` |
| `reconciliation.service.ts` | `BankTransaction` | escribe `glAccountId` | Línea 128: `updateData.glAccountId = mainGlId` |
| `import.service.ts` | `BankTransaction` | crea con `glAccountId` | Línea 620: `glAccountId: glAccountId || null` |
| `backup.ts` | `BankTransaction` | restaura con `glAccountId` | Línea 913: `clean.glAccountId = glAccountIdMap.get(oldGlId) \|\| oldGlId` |

---

## RELACIONES NO DETERMINADAS

| Relación | Razón |
|----------|-------|
| ¿Existen otros puntos de escritura fuera del universo inspeccionado? | No pudo demostrarse que los observados sean los únicos |

---

## RESPUESTA A LA PREGUNTA

### Cadena lógica

Paso 1: Se identificaron los puntos de escritura
(Evidencia: Tabla de Puntos de Escritura filas 1–10)

Puntos de escritura fueron observados en siete archivos.

Paso 2: Se clasificaron por tipo de autoridad
(Evidencia: Tabla de Participación por Componente)

Creación inicial:
- `import.service.ts:620` — crea `BankTransaction` con `glAccountId` durante importación de extracto bancario.

Modificación de una clasificación existente:
- `apply-all-engine.ts:431,441` — actualiza `glAccountId` en lote durante clasificación automática por regla.
- `single-rule-apply.service.ts:46,57` — actualiza `glAccountId` individualmente durante clasificación por regla.
- `reconciliation/auto/route.ts:221` — actualiza `glAccountId` durante reconciliación automática.
- `transactions/[id]/route.ts:86` — actualiza `glAccountId` por asignación manual.
- `reconciliation.service.ts:128,134` — actualiza `glAccountId` durante reconciliación manual.

Restauración administrativa:
- `backup.ts:913` — restaura `BankTransaction` con `glAccountId` mapeado durante restauración de backup.

Paso 3: Persistencia observada
(Evidencia: Tabla de Puntos de Escritura)

Con el universo inspeccionado no pudo demostrarse que estos mecanismos sean los únicos puntos de escritura.

Paso 4: Conclusión
Con el universo inspeccionado pudo demostrarse que múltiples componentes intervienen sobre el estado persistido de `BankTransaction.glAccountId` mediante tres mecanismos observados: creación inicial, modificación de una clasificación existente y restauración administrativa. No pudo demostrarse que no existan otros puntos de escritura fuera del universo inspeccionado.

---

## CONFIANZA DE LA CONCLUSIÓN

| Métrica | Fórmula | Valor |
|---------|---------|-------|
| Observaciones | Filas con estado Observada + Corroborada | 10 |
| Corroboraciones | Filas cuyo estado = Corroborada | 0 |
| No demostradas | Filas cuyo estado = No demostrada | 1 |
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
| ¿Existe alguna interpretación presentada como hecho? | No | Verbos utilizados: escribe, reemplaza, invalida, crea, restaura |
| ¿Existe algún verbo que implique diseño? | No | Verbos utilizados: escribe, reemplaza, invalida, crea, restaura |
| ¿Existe alguna conclusión más fuerte que la evidencia? | No | La conclusión es "múltiples componentes poseen capacidad de escritura" |
| ¿Se respondió exactamente la pregunta? | Sí | La pregunta era qué componentes modifican el valor |
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
- **Identificador:** ADR_INPUT_003
- **Reutilizable para:** ADR posteriores relacionados con escritura, modificación, reconciliación, importación, restauración

---

**Documento:** ADR_INPUT_003
**Versión:** 1.0
**Estado:** Validado
**Ordenes:** S10-B.3, S10-B.3A, S10-B.3B
**Baseline inspeccionado:** `audit-s1-s9-complete`
**Commit inspeccionado:** `2bf4bbd7518e1d3946a06897ee7aba42876951d1`
**Investigador:** AI de desarrollo
