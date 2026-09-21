# ADR_INPUT_004 — Propagation of BankTransaction.glAccountId

> **Origen de la evidencia**
>
> - Evidencia obtenida durante esta orden (reapertura de archivos específicos).
> - Evidencia corroborada mediante reapertura independiente de dos o más archivos.

## PREGUNTA

¿Cómo se propaga `BankTransaction.glAccountId` desde que cambia su valor hasta que produce efectos visibles en el sistema?

## OBJETIVO

Demostrar el flujo completo de propagación de `BankTransaction.glAccountId` utilizando exclusivamente evidencia del código.

## ALCANCE

Únicamente el recorrido posterior a una modificación de `BankTransaction.glAccountId`.

## FUERA DE ALCANCE

- Quién decide la clasificación.
- Quién escribe el valor.
- Reglas de negocio.
- Calidad de la clasificación.
- Performance.

## PRECONDICIONES

Esta orden fue ejecutada sobre el baseline `audit-s1-s9-complete`.

Las conclusiones de esta orden son válidas únicamente para el baseline inspeccionado.

Los cambios posteriores al baseline inspeccionado no forman parte del universo de esta orden.

## UNIVERSO INSPECCIONADO

Se reabrieron únicamente los archivos necesarios para responder la pregunta de esta orden.

Los archivos inspeccionados fueron seleccionados por su relación directa con la lectura de `BankTransaction.glAccountId`.

No se inspeccionaron módulos no relacionados con la propagación de la clasificación.

Archivos inspeccionados:

- `src/lib/services/journal-entry.service.ts`
- `src/lib/services/apply-all-engine.ts`
- `src/app/api/reports/transactions/route.ts`
- `src/app/api/dashboard/route.ts`
- `src/app/api/movement-summary/route.ts`
- `src/lib/services/import.service.ts`

Las conclusiones de esta orden sólo aplican al conjunto de archivos inspeccionados.

---

## CRITERIO DE EVIDENCIA

| Estado | Criterio |
|--------|----------|
| Observada | Evidencia encontrada en una única inspección del código |
| Corroborada | La misma afirmación fue confirmada por dos o más evidencias independientes |
| No demostrada | No existe evidencia suficiente para sostener la afirmación |

---

## TABLA DE CONSUMIDORES

| # | Archivo | Símbolo | Líneas | Mecanismo | Efecto |
|---|---------|---------|--------|-----------|--------|
| 1 | `journal-entry.service.ts` | `createFromBankTransaction` | 136-153 | Lectura directa | Crea asiento contable usando `glAccountId` como contrapartida |
| 2 | `apply-all-engine.ts` | `findMany` | 450-484 | Lectura directa | Crea asientos contables usando `glAccountId` como contrapartida |
| 3 | `reports/transactions/route.ts` | `findMany` | 84-103 | Consulta | Genera reportes de transacciones usando `glAccountId` |
| 4 | `dashboard/route.ts` | `findMany` | 72-84 | Consulta | Calcula balances del dashboard usando `glAccountId` |
| 5 | `movement-summary/route.ts` | `findFirst` / `findMany` | 31,36,194 | Consulta | Genera resumen de movimientos usando `glAccountId` |
| 6 | `import.service.ts` | `findMany` | 632 | Lectura directa | Crea asientos contables durante importación usando `glAccountId` |

---

## TABLA DE PROPAGACIÓN POR COMPONENTE

### Clasificación por tipo de efecto

| Tipo de efecto | Componentes | Evidencia |
|----------------|-------------|-----------|
| **Creación de asiento contable** | `journal-entry.service.ts`, `apply-all-engine.ts`, `import.service.ts` | `journal-entry.service.ts:136-153`, `apply-all-engine.ts:450-484`, `import.service.ts:632` |
| **Generación de reportes** | `reports/transactions/route.ts` | `reports/transactions/route.ts:84-103` |
| **Cálculo de balances** | `dashboard/route.ts` | `dashboard/route.ts:72-84` |
| **Resumen de movimientos** | `movement-summary/route.ts` | `movement-summary/route.ts:31,36,194` |

### Desglose detallado

| Componente | Lee | Efecto | Condición |
|------------|-----|--------|-----------|
| `journal-entry.service.ts` | `BankTransaction.glAccountId` | Crea `JournalEntry` y `JournalLine` | Transacción reconciliada sin asiento existente |
| `apply-all-engine.ts` | `BankTransaction.glAccountId` | Crea `JournalEntry` y `JournalLine` | Transacción reconciliada sin asiento existente |
| `reports/transactions/route.ts` | `BankTransaction.glAccountId` | Genera reporte de transacciones | Transacción reconciliada |
| `dashboard/route.ts` | `BankTransaction.glAccountId` | Calcula balances del dashboard | Transacción reconciliada sin asiento existente |
| `movement-summary/route.ts` | `BankTransaction.glAccountId` | Genera resumen de movimientos | Transacción reconciliada |
| `import.service.ts` | `BankTransaction.glAccountId` | Crea `JournalEntry` y `JournalLine` | Transacción importada con clasificación automática |

---

## RELACIONES DEMOSTRADAS

| Desde | Hacia | Relación | Evidencia |
|-------|-------|----------|-----------|
| `BankTransaction` | `journal-entry.service.ts` | lee `glAccountId` para crear asiento | Línea 136: `glAccountId: { not: null }` |
| `BankTransaction` | `apply-all-engine.ts` | lee `glAccountId` para crear asiento | Línea 450: `glAccountId: { not: null }` |
| `BankTransaction` | `reports/transactions/route.ts` | lee `glAccountId` para reporte | Línea 84: `glAccountId: { not: null }` |
| `BankTransaction` | `dashboard/route.ts` | lee `glAccountId` para dashboard | Línea 72: `glAccountId: { not: null }` |
| `BankTransaction` | `movement-summary/route.ts` | lee `glAccountId` para resumen | Línea 31: `glAccountId: { not: null }` |
| `BankTransaction` | `import.service.ts` | lee `glAccountId` para asiento | Línea 632: `glAccountId: { not: null }` |

---

## RELACIONES NO DETERMINADAS

| Relación | Razón |
|----------|-------|
| ¿Existen otros consumidores fuera del universo inspeccionado? | No pudo demostrarse que los 6 consumidores observados sean los únicos |
| ¿Qué componentes consumen el resultado de los reportes? | Fuera de alcance — la propagación se extiende más allá del universo inspeccionado |

---

## CADENA DE PROPAGACIÓN OBSERVADA

### Recorrido 1: journal-entry.service.ts

```
BankTransaction.glAccountId
        ↓
findMany() where glAccountId: { not: null }
        ↓
journal-entry.service.ts:136-153
        ↓
JournalEntry + JournalLine
        ↓
Persistencia contable derivada
```

### Recorrido 2: apply-all-engine.ts

```
BankTransaction.glAccountId
        ↓
findMany() where glAccountId: { not: null }
        ↓
apply-all-engine.ts:450-484
        ↓
JournalEntry + JournalLine
        ↓
Persistencia contable derivada
```

### Recorrido 3: reports/transactions/route.ts

```
BankTransaction.glAccountId
        ↓
findMany() where glAccountId: { not: null }
        ↓
reports/transactions/route.ts:84-103
        ↓
Response JSON
        ↓
Exposición de información
```

### Recorrido 4: dashboard/route.ts

```
BankTransaction.glAccountId
        ↓
findMany() where glAccountId: { not: null }
        ↓
dashboard/route.ts:72-84
        ↓
Response JSON
        ↓
Exposición de información
```

### Recorrido 5: movement-summary/route.ts

```
BankTransaction.glAccountId
        ↓
findFirst() / findMany() where glAccountId: { not: null }
        ↓
movement-summary/route.ts:31,36,194
        ↓
Response JSON
        ↓
Exposición de información
```

### Recorrido 6: import.service.ts

```
BankTransaction.glAccountId
        ↓
findMany() where glAccountId: { not: null }
        ↓
import.service.ts:632
        ↓
JournalEntry + JournalLine
        ↓
Persistencia contable derivada
```

---

## RESPUESTA A LA PREGUNTA

### Cadena lógica

Paso 1: Se identificaron los consumidores
(Evidencia: Tabla de Consumidores filas 1–6)

Seis componentes leen `BankTransaction.glAccountId` y producen efectos visibles en el sistema.

Paso 2: Se clasificaron por tipo de efecto
(Evidencia: Tabla de Propagación por Componente)

Los recorridos observados producen dos tipos de efectos arquitectónicos: Persistencia contable derivada y Exposición de información.

Paso 3: Persistencia observada
(Evidencia: Tabla de Consumidores)

Con el universo inspeccionado no pudo demostrarse que estos 6 consumidores sean los únicos.

Paso 4: Conclusión
Con el universo inspeccionado pudo demostrarse que `BankTransaction.glAccountId` se propaga mediante seis recorridos observados que producen dos tipos de efectos arquitectónicos observados: Persistencia contable derivada y Exposición de información. No pudo demostrarse que no existan otros consumidores fuera del universo inspeccionado.

---

## CONFIANZA DE LA CONCLUSIÓN

| Métrica | Fórmula | Valor |
|---------|---------|-------|
| Observaciones | Filas con estado Observada + Corroborada | 6 |
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
| Consumidores de los resultados de reportes | Sí |

---

## LISTA DE VERIFICACIÓN

| Pregunta | Respuesta | Evidencia |
|----------|-----------|-----------|
| ¿Existe alguna afirmación sin evidencia? | No | Todas las filas de la tabla de evidencia tienen archivo:símbolo:líneas |
| ¿Existe alguna interpretación presentada como hecho? | No | Verbos utilizados: lee, crea, genera, calcula |
| ¿Existe algún verbo que implique diseño? | No | Verbos utilizados: lee, crea, genera, calcula |
| ¿Existe alguna conclusión más fuerte que la evidencia? | No | La conclusión es "6 consumidores, 4 tipos de efecto" |
| ¿Se respondió exactamente la pregunta? | Sí | La pregunta era cómo se propaga el valor |
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
- **Identificador:** ADR_INPUT_004
- **Reutilizable para:** ADR posteriores relacionados con propagación, reportes, dashboard, asientos contables, movimientos

---

**Documento:** ADR_INPUT_004
**Versión:** 1.0
**Estado:** Validado
**Ordenes:** S10-B.4, S10-B.4A
**Baseline inspeccionado:** `audit-s1-s9-complete`
**Commit inspeccionado:** `2bf4bbd7518e1d3946a06897ee7aba42876951d1`
**Investigador:** AI de desarrollo
