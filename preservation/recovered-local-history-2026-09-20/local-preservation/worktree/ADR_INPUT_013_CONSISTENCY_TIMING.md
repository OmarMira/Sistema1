---
document: ADR_INPUT_013
title: "Momento de verificación de invariantes de consistencia"
version: "1.0"
status: Validado
kind: ADR
category: INPUT
tags: [consistency, timing, verification, before, during, schema]
---

# ADR_INPUT_013 — ¿Cuándo se verifica cada invariante?

## Secciones del ADR

---

## 1. PREGUNTA

¿En qué momento se verifica cada invariante de consistencia identificado en ADR_INPUT_011?

---

## 2. OBJETIVO

Determinar el momento de ejecución de la verificación de cada uno de los catorce invariantes de consistencia, con evidencia del código.

---

## 3. ALCANCE

- Archivos de servicio (journal-entry.service.ts, reconciliation.service.ts, apply-all-engine.ts)
- Schema de base de datos (schema.prisma)
- Guards (fiscal-period-guard.ts, transaction-invariants.ts)

---

## 4. FUERA DE ALCANCE

- Qué invariantes existen (S10-D.1)
- Quién los verifica (S10-D.2)
- Qué ocurre cuando falla (S10-D.4)
- Si el sistema puede quedar en estado parcialmente consistente (S10-D.5)

---

## 5. PRECONDICIONES

- ADR_INPUT_011 congelado (inventario de invariantes)
- ADR_INPUT_012 congelado (verificadores de cada invariante)
- Métodos de recopilación de evidencia: lectura de código, schema de base de datos

---

## 6. UNIVERSO INSPECCIONADO

| Archivo | Qué se busca |
|---------|--------------|
| journal-entry.service.ts | Momento de verificación de balance doble |
| reconciliation.service.ts | Momento de verificación de splits, tenant, 1:1 |
| fiscal-period-guard.ts | Momento de verificación de período fiscal |
| transaction-invariants.ts | Momento de verificación de clasificación one-shot |
| apply-all-engine.ts | Momento de verificación de período fiscal batch |
| schema.prisma | Momento de verificación de restricciones de unicidad |

---

## 7. CRITERIO DE EVIDENCIA

- **Presente**: No aplica (el universo es finito)
- **Mínimo**: Las tablas de evidencia deben contener al menos una fila por cada invariante
- **Ninguno**: Un invariante tiene un momento de verificación si el código o schema lo implementa en ese momento

---

## 8. TABLAS DE EVIDENCIA

### Tabla 1: Balance doble (debit = credit)

**¿La evidencia está presente?** Sí — JournalEntryService crea ambas líneas en una sola operación

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| journal-entry.service.ts | 52-55 | Dos JournalLine creadas en un solo prisma.journalEntry.create() con lines: { create: [...] } |

**Momento**: DURANTE la construcción (nested create)
**Mecanismo**: Estructural — ambas líneas se crean atómicamente desde la misma variable amount

### Tabla 2: Suma de splits = monto de transacción

**¿La evidencia está presente?** Sí — ReconciliationService valida antes de escribir

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| reconciliation.service.ts | 187-193 | splitSum computado y comparado con absBankAmount con tolerancia > 0.01 |
| reconciliation.service.ts | 194-196 | Splits con monto cero son rechazados |

**Momento**: ANTES de escribir (pre-write validation)
**Mecanismo**: Validación explícita + throw

### Tabla 3: Aislamiento de tenant

**¿La evidencia está presente?** Sí — ReconciliationService valida antes de escribir

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| reconciliation.service.ts | 84-101 | glAccountMap pre-filtrado por companyId, cada GL ID propuesto verificado antes de escribir |
| reconciliation.service.ts | 84-88 | Comentario: "Reject BEFORE any write so the whole transaction rolls back with no partial state" |

**Momento**: ANTES de escribir (pre-write validation)
**Mecanismo**: Map lookup + throw

### Tabla 4: Una JournalEntry por BankTransaction (1:1)

**¿La evidencia está presente?** Sí — Combinación de schema + pre-write guard

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 213 | journalEntryId String? @unique (database-level) |
| reconciliation.service.ts | 103-108, 178 | hasExistingJournalEntry check antes de crear |

**Momento**: COMBINACIÓN: SCHEMA + ANTES de escribir
**Mecanismo**: Defense in depth — código evita duplicados proactivamente, @unique es la red de seguridad

### Tabla 5: Período fiscal activo (per-transaction)

**¿La evidencia está presente?** Sí — assertActiveFiscalPeriod se ejecuta antes de escribir

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| fiscal-period-guard.ts | 9-36 | findFirst de período bloqueado, throw si existe |
| journal-entry.service.ts | 34 | Llamado antes de prisma.journalEntry.create() |
| reconciliation.service.ts | 72 | Llamado dentro de $transaction pero antes de escribir |

**Momento**: ANTES de escribir (pre-write validation)
**Mecanismo**: Query + throw, ejecutado dentro de la misma transacción (TOCTOU-safe)

### Tabla 6: Clasificación one-shot

**¿La evidencia está presente?** Sí — Filtro se ejecuta durante la query

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| transaction-invariants.ts | 3-9 | ELIGIBLE_FOR_CLASSIFICATION_FILTER requiere 5 campos null/false |
| apply-all-engine.ts | 178-181, 387-391, 429-433, 439-443 | Filtro usado en findMany y updateManyAndReturn WHERE clauses |

**Momento**: DURANTE la query (AT READ TIME / implicit pre-write gate)
**Mecanismo**: WHERE clause filtra transacciones elegibles; las ya clasificadas son excluidas silenciosamente

### Tabla 7: Período fiscal batch check

**¿La evidencia está presente?** Sí — executeApplyAll valida antes de escribir

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| apply-all-engine.ts | 399-405 | Todas las fechas validadas antes de cualquier updateManyAndReturn o createFromBankTransaction |
| apply-all-engine.ts | 396-398 | Comentario: "If ANY falls in a closed/locked period the whole apply aborts with no partial classification" |

**Momento**: ANTES de escribir (pre-write validation, batch)
**Mecanismo**: Loop + assertActiveFiscalPeriod, abort atómico si cualquiera falla

### Tablas 8-14: Restricciones de unicidad (database)

**¿La evidencia está presente?** Sí — schema.prisma define restricciones @unique o @@unique

| # | Invariante | Ubicación | Restricción |
|---|-----------|-----------|-------------|
| 8 | Código GL único por company | schema.prisma:148 | @@unique([companyId, code]) |
| 9 | Bank statement único por cuenta/rango | schema.prisma:194 | @@unique([bankAccountId, startDate, endDate]) |
| 10 | Membresía de company única | schema.prisma:121 | @@unique([userId, companyId]) |
| 11 | Import hash único | schema.prisma:212 | @unique |
| 12 | Idempotency key de JournalEntry única | schema.prisma:332 | @@unique([companyId, idempotencyKey]) |
| 13 | Idempotency key de RuleApplyRecord única | schema.prisma:364 | @unique |
| 14 | Nombre de período fiscal único | schema.prisma:390 | @@unique([companyId, name]) |

**Momento**: A NIVEL DE SCHEMA (durante INSERT/UPDATE)
**Mecanismo**: PostgreSQL unique constraint, retorna error si se viola

---

## 9. RELACIONES

- ADR_INPUT_011 inventarió los catorce invariantes de consistencia
- ADR_INPUT_012 identificó quién verifica cada uno
- ADR_INPUT_013 determina cuándo se verifican
- S10-D.4 determinará qué ocurre cuando falla

**Relación con el paso anterior**: ADR_INPUT_013 utiliza los verificadores de ADR_INPUT_012 como punto de partida y produce la evidencia necesaria para S10-D.4 (qué ocurre cuando falla).

---

## 10. RESPUESTA A LA PREGUNTA

### Cadena lógica (4 pasos)

1. **Dato observado**: Los invariantes 2, 3, 5 y 7 son verificados ANTES de escribir (pre-write validation). En cada caso, la validación se ejecuta dentro de la transacción pero antes de cualquier mutación, y falla con una excepción que provoca rollback.

2. **Dato observado**: El invariante 1 (balance doble) se preserva DURANTE la construcción (nested create). No hay verificación explícita; el invariante se preserva porque ambas líneas se crean atómicamente desde la misma variable.

3. **Dato observado**: El invariante 6 (clasificación one-shot) se verifica DURANTE la query (AT READ TIME). El filtro de elegibilidad se ejecuta en la cláusula WHERE, excluyendo silenciosamente transacciones ya clasificadas. Un filtro WHERE constituye una verificación porque determina qué transacciones son elegibles para clasificación; una transacción que no pasa el filtro es rechazada implícitamente.

4. **Dato observado**: Los invariantes 4 y 8-14 se verifican durante la ejecución de INSERT o UPDATE en la base de datos. El invariante 4 tiene verificación dual: el código verifica antes de escribir y la restricción de schema verifica durante INSERT/UPDATE. Los demás son verificados únicamente por restricciones de schema durante INSERT/UPDATE.

### Conclusión

Con el universo inspeccionado en esta orden, los catorce invariantes de consistencia identificados en ADR_INPUT_011 se verifican en los siguientes momentos:

**ANTES de escribir** (pre-write validation, 4 invariantes):
- Split sum = monto — ReconciliationService (validación explícita + throw)
- Aislamiento de tenant — ReconciliationService (map lookup + throw)
- Período fiscal activo — assertActiveFiscalPeriod (query + throw)
- Período fiscal batch — executeApplyAll (loop + throw)

**DURANTE la construcción** (nested create, 1 invariante):
- Balance doble — JournalEntryService (construcción atómica)

**DURANTE la query** (AT READ TIME, 1 invariante):
- Clasificación one-shot — eligibleForClassificationWhere (WHERE clause)

**DURANTE INSERT/UPDATE** (database constraint, 8 invariantes):
- Una JournalEntry por BankTransaction — código (skip-if-exists) + schema (@unique)
- Código GL único por company — @@unique
- Bank statement único por cuenta/rango — @@unique
- Membresía de company única — @@unique
- Import hash único — @unique
- Idempotency key de JournalEntry única — @@unique
- Idempotency key de RuleApplyRecord única — @@unique
- Nombre de período fiscal único — @@unique

En el universo inspeccionado se observaron cuatro momentos de verificación: antes de escribir (4 invariantes), durante la construcción (1 invariante), durante la evaluación de la query (1 invariante), y durante INSERT/UPDATE (8 invariantes). No pudo demostrarse si este patrón se extiende a invariantes fuera del universo inspeccionado.

---

## 11. CONFIANZA

**Nivel de confianza**: 10/10

**Razón**: La evidencia es clara para cada invariante individual. La conclusión se limita a agrupar por momento temporal sin introducir categorías conceptuales no demostradas.

---

## 12. LÍMITES

- Las tablas de evidencia dependen de la fuente de datos inspeccionada
- Algunos archivos podrían no estar cubiertos en la inspección
- La respuesta es una representación simplificada de un sistema complejo

---

## 13. LISTA DE VERIFICACIÓN

- [x] La pregunta es atómica (una única pregunta)
- [x] El universo está claramente delimitado
- [x] Las tablas contienen al menos una fila por cada invariante
- [x] La cadena lógica mantiene la estructura utilizada en S10-B y S10-C
- [x] La conclusión no afirma más de lo que la evidencia demuestra
- [x] El documento no contiene afirmaciones sin sustento

---

## 14. REUTILIZACIÓN

Este ADR puede reutilizarse como:

- **Entrada**: Para S10-D.4 (¿qué ocurre cuando falla?), S10-D.5 (¿puede quedar en estado parcial?)
- **Base**: Para futuros ADRs sobre timing de verificación
- **Referencia**: Para validar momentos de verificación en otros contextos

---

## Metadatos

- **Autor**: Researcher
- **Fecha de creación**: 2026-09-06
- **Última actualización**: 2026-09-06
- **Estado**: Validado
- **Versión**: 1.0
- **Confianza**: 9/10
