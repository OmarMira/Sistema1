---
document: ADR_INPUT_012
title: "Verificadores de invariantes de consistencia"
version: "1.0"
status: Validado
kind: ADR
category: INPUT
tags: [consistency, verification, verifier, application, database]
---

# ADR_INPUT_012 — ¿Quién verifica cada invariante?

## Secciones del ADR

---

## 1. PREGUNTA

¿Quién verifica cada invariante de consistencia identificado en ADR_INPUT_011?

**Definición de "verificador"**: Componente (servicio, guard, o motor de base de datos) que implementa la lógica que preserva o valida el invariante. Un verificador puede ser un servicio de aplicación, un guard reutilizable, o una restricción de base de datos.

---

## 2. OBJETIVO

Determinar qué componente es responsable de verificar cada uno de los catorce invariantes de consistencia identificados en ADR_INPUT_011, con evidencia del código.

---

## 3. ALCANCE

- Archivos de servicio (journal-entry.service.ts, reconciliation.service.ts, apply-all-engine.ts)
- Schema de base de datos (schema.prisma)
- Guards (fiscal-period-guard.ts, transaction-invariants.ts)

---

## 4. FUERA DE ALCANCE

- Qué invariantes existen (S10-D.1)
- Cuándo se verifican (S10-D.3)
- Qué ocurre cuando falla (S10-D.4)
- Si el sistema puede quedar en estado parcialmente consistente (S10-D.5)

---

## 5. PRECONDICIONES

- ADR_INPUT_011 congelado (inventario de invariantes)
- Métodos de recopilación de evidencia: lectura de código, schema de base de datos

---

## 6. UNIVERSO INSPECCIONADO

| Archivo | Qué se busca |
|---------|--------------|
| journal-entry.service.ts | Verificador de balance doble |
| reconciliation.service.ts | Verificador de splits, tenant, 1:1 |
| fiscal-period-guard.ts | Verificador de período fiscal |
| transaction-invariants.ts | Verificador de clasificación one-shot |
| apply-all-engine.ts | Verificador de período fiscal batch |
| schema.prisma | Verificadores de base de datos |

---

## 7. CRITERIO DE EVIDENCIA

- **Presente**: No aplica (el universo es finito)
- **Mínimo**: Las tablas de evidencia deben contener al menos una fila por cada invariante
- **Ninguno**: Un invariante tiene un verificador si el código o schema lo implementa

---

## 8. TABLAS DE EVIDENCIA

### Tabla 1: Balance doble (debit = credit)

**¿La evidencia está presente?** Sí — JournalEntryService crea ambas líneas atómicamente

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| journal-entry.service.ts | 45-57 | JournalEntryService.createFromBankTransaction crea ambas líneas en una sola operación nested create |

**Verificador**: JournalEntryService (aplicación)
**Mecanismo**: Construcción — ambas líneas se crean con el mismo monto, una con debit=amount y otra con credit=amount

### Tabla 2: Suma de splits = monto de transacción

**¿La evidencia está presente?** Sí — ReconciliationService valida explícitamente

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| reconciliation.service.ts | 186-196 | ReconciliationService.reconcile valida Math.abs(splitSum - absBankAmount) > 0.01 → throw ValidationError |

**Verificador**: ReconciliationService (aplicación)
**Mecanismo**: Validación explícita + throw

### Tabla 3: Aislamiento de tenant

**¿La evidencia está presente?** Sí — ReconciliationService y JournalEntryService verifican

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| reconciliation.service.ts | 84-101 | Pre-write: todos los GL IDs propuestos se verifican contra glAccountMap filtrado por companyId |
| journal-entry.service.ts | 96-100 | Post-write: recalculateBalance agrega solo líneas donde entry.companyId === glAccount.companyId |

**Verificador**: ReconciliationService + JournalEntryService (aplicación)
**Mecanismo**: Pre-write companyId check + post-write scoped aggregation

### Tabla 4: Una JournalEntry por BankTransaction (1:1)

**¿La evidencia está presente?** Sí — ReconciliationService + schema @unique

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| reconciliation.service.ts | 103-108, 178 | ReconciliationService.reconcile salta creación si bankTx.journalEntryId ya existe |
| schema.prisma | 213 | journalEntryId String? @unique |

**Verificador**: ReconciliationService (aplicación) + PostgreSQL (base de datos)
**Mecanismo**: Skip-if-exists logic + unique constraint

### Tabla 5: Período fiscal activo (per-transaction)

**¿La evidencia está presente?** Sí — assertActiveFiscalPeriod verifica

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| fiscal-period-guard.ts | 9-36 | assertActiveFiscalPeriod consulta período bloqueado y lanza ForbiddenError |
| journal-entry.service.ts | 34 | Llama a assertActiveFiscalPeriod antes de crear JournalEntry |
| reconciliation.service.ts | 72 | Llama a assertActiveFiscalPeriod dentro del loop |

**Verificador**: assertActiveFiscalPeriod (aplicación)
**Mecanismo**: Query locked period + throw

### Tabla 6: Clasificación one-shot

**¿La evidencia está presente?** Sí — eligibleForClassificationWhere filtra

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| transaction-invariants.ts | 3-17 | eligibleForClassificationWhere requiere 5 campos null/false |
| apply-all-engine.ts | 178-182, 387-391, 429, 439 | Usa el filtro en cada query de clasificación |

**Verificador**: eligibleForClassificationWhere (aplicación)
**Mecanismo**: 5-field Prisma filter on update

### Tabla 7: Código GL único por company

**¿La evidencia está presente?** Sí — schema.prisma define @@unique

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 148 | @@unique([companyId, code]) en GlAccount |

**Verificador**: PostgreSQL (base de datos)
**Mecanismo**: DB unique composite index

### Tabla 8: Bank statement único por cuenta/rango

**¿La evidencia está presente?** Sí — schema.prisma define @@unique

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 194 | @@unique([bankAccountId, startDate, endDate]) en BankStatement |

**Verificador**: PostgreSQL (base de datos)
**Mecanismo**: DB unique composite index

### Tabla 9: Membresía de company única

**¿La evidencia está presente?** Sí — schema.prisma define @@unique

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 121 | @@unique([userId, companyId]) en CompanyMember |

**Verificador**: PostgreSQL (base de datos)
**Mecanismo**: DB unique composite index

### Tabla 10: Import hash único

**¿La evidencia está presente?** Sí — schema.prisma define @unique

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 212 | importHash String? @unique en BankTransaction |

**Verificador**: PostgreSQL (base de datos)
**Mecanismo**: DB unique index

### Tabla 11: Idempotency key de JournalEntry única

**¿La evidencia está presente?** Sí — schema.prisma define @@unique

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 332 | @@unique([companyId, idempotencyKey]) en JournalEntry |

**Verificador**: PostgreSQL (base de datos)
**Mecanismo**: DB unique composite index

### Tabla 12: Idempotency key de RuleApplyRecord única

**¿La evidencia está presente?** Sí — schema.prisma define @unique

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 364 | idempotencyKey String @unique en RuleApplyRecord |

**Verificador**: PostgreSQL (base de datos)
**Mecanismo**: DB unique index

### Tabla 13: Nombre de período fiscal único por company

**¿La evidencia está presente?** Sí — schema.prisma define @@unique

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 390 | @@unique([companyId, name]) en FiscalPeriod |

**Verificador**: PostgreSQL (base de datos)
**Mecanismo**: DB unique composite index

### Tabla 14: Período fiscal batch check

**¿La evidencia está presente?** Sí — executeApplyAll valida batch

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| apply-all-engine.ts | 395-405 | executeApplyAll valida todas las fechas antes de cualquier mutación |

**Verificador**: executeApplyAll (aplicación)
**Mecanismo**: Pre-write loop + atomic transaction abort

---

## 9. RELACIONES

- ADR_INPUT_011 inventarió los catorce invariantes de consistencia
- ADR_INPUT_012 identifica quién verifica cada uno
- S10-D.3 determinará cuándo se verifican

**Relación con el paso anterior**: ADR_INPUT_012 utiliza el inventario de ADR_INPUT_011 como punto de partida y produce la evidencia necesaria para S10-D.3 (cuándo se verifican).

---

## 10. RESPUESTA A LA PREGUNTA

### Cadena lógica (4 pasos)

1. **Dato observado**: Los invariantes 1, 2, 3, 5, 6 y 14 son verificados por componentes de aplicación: JournalEntryService (construcción de líneas), ReconciliationService (validación de splits y tenant), assertActiveFiscalPeriod (query de período bloqueado), eligibleForClassificationWhere (filtro de elegibilidad), y executeApplyAll (validación batch).

2. **Dato observado**: El invariante 4 (una JournalEntry por BankTransaction) tiene verificación dual: ReconciliationService salta la creación si ya existe, y PostgreSQL previene duplicados con @unique.

3. **Dato observado**: Los invariantes 7, 8, 9, 10, 11, 12 y 13 son verificados por PostgreSQL mediante restricciones @@unique o @unique en el schema.

4. **Dato observado**: El invariante 1 (balance doble) no tiene una verificación explícita; se preserva por construcción cuando JournalEntryService crea ambas líneas en una sola operación.

### Conclusión

Con el universo inspeccionado en esta orden, los catorce invariantes de consistencia identificados en ADR_INPUT_011 tienen los siguientes verificadores:

**Verificadores de aplicación** (6 invariantes):
- Balance doble — JournalEntryService (construcción por diseño)
- Split sum = monto — ReconciliationService (validación explícita + throw)
- Aislamiento de tenant — ReconciliationService + JournalEntryService (pre-write + post-write)
- Período fiscal activo — assertActiveFiscalPeriod (query + throw)
- Clasificación one-shot — eligibleForClassificationWhere (5-field filter)
- Período fiscal batch — executeApplyAll (pre-write loop)

**Verificadores duales** (1 invariante):
- Una JournalEntry por BankTransaction — ReconciliationService (skip-if-exists) + PostgreSQL (@unique)

**Verificadores de base de datos** (7 invariantes):
- Código GL único por company — @@unique
- Bank statement único por cuenta/rango — @@unique
- Membresía de company única — @@unique
- Import hash único — @unique
- Idempotency key de JournalEntry única — @@unique
- Idempotency key de RuleApplyRecord única — @unique
- Nombre de período fiscal único — @@unique

En el universo inspeccionado se observó el siguiente patrón: la aplicación verifica invariantes de negocio, la base de datos verifica invariantes de unicidad, y un invariante tiene verificación dual. No pudo demostrarse si este patrón se extiende a invariantes fuera del universo inspeccionado.

---

## 11. CONFIANZA

**Nivel de confianza**: 9/10

**Razón**: La evidencia es clara para cada invariante individual. El patrón es consistente: la aplicación verifica invariantes de negocio, la base de datos verifica invariantes de unicidad.

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

- **Entrada**: Para S10-D.3 (¿cuándo se verifican?), S10-D.4 (¿qué ocurre cuando falla?), S10-D.5 (¿puede quedar en estado parcial?)
- **Base**: Para futuros ADRs sobre verificación de consistencia
- **Referencia**: Para validar quién verifica invariantes en otros contextos

---

## Metadatos

- **Autor**: Researcher
- **Fecha de creación**: 2026-09-06
- **Última actualización**: 2026-09-06
- **Estado**: Validado
- **Versión**: 1.0
- **Confianza**: 9/10
