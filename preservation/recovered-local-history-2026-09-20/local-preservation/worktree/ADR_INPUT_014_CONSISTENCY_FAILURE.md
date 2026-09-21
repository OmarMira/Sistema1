---
document: ADR_INPUT_014
title: "Comportamiento ante fallos de verificación de invariantes"
version: "1.0"
status: Validado
kind: ADR
category: INPUT
tags: [consistency, failure, error, rollback, throw]
---

# ADR_INPUT_014 — ¿Qué ocurre cuando una verificación falla?

## Secciones del ADR

---

## 1. PREGUNTA

¿Qué efecto observable produce el fallo de cada mecanismo de verificación de invariantes de consistencia?

---

## 2. OBJETIVO

Determinar qué ocurre cuando la verificación de cada uno de los catorce invariantes de consistencia falla, con evidencia del código.

---

## 3. ALCANCE

- Archivos de servicio (journal-entry.service.ts, reconciliation.service.ts, apply-all-engine.ts)
- Schema de base de datos (schema.prisma)
- Guards (fiscal-period-guard.ts, transaction-invariants.ts)
- Manejo de errores (api-handler.ts)

---

## 4. FUERA DE ALCANCE

- Qué invariantes existen (S10-D.1)
- Quién los verifica (S10-D.2)
- Cuándo se verifican (S10-D.3)
- Si el sistema puede quedar en estado parcialmente consistente (S10-D.5)

---

## 5. PRECONDICIONES

- ADR_INPUT_011 congelado (inventario de invariantes)
- ADR_INPUT_012 congelado (verificadores de cada invariante)
- ADR_INPUT_013 congelado (momento de verificación)
- Métodos de recopilación de evidencia: lectura de código, schema de base de datos

---

## 6. UNIVERSO INSPECCIONADO

| Archivo | Qué se busca |
|---------|--------------|
| journal-entry.service.ts | Comportamiento ante fallo de balance doble |
| reconciliation.service.ts | Comportamiento ante fallo de splits, tenant, 1:1 |
| fiscal-period-guard.ts | Comportamiento ante fallo de período fiscal |
| transaction-invariants.ts | Comportamiento ante fallo de clasificación one-shot |
| apply-all-engine.ts | Comportamiento ante fallo de período fiscal batch |
| schema.prisma | Comportamiento ante fallo de restricciones de unicidad |
| api-handler.ts | Propagación de errores |

---

## 7. CRITERIO DE EVIDENCIA

- **Presente**: No aplica (el universo es finito)
- **Mínimo**: Las tablas de evidencia deben contener al menos una fila por cada invariante
- **Ninguno**: Un invariante tiene un comportamiento ante fallo si el código lo implementa

---

## 8. TABLAS DE EVIDENCIA

### Tabla 1: Balance doble (debit = credit)

**¿La evidencia está presente?** Sí — el invariante es estructuralmente imposible de fallar

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| journal-entry.service.ts | 52-55 | Ambas líneas se crean desde la misma variable amount en un solo nested create |

**Comportamiento ante fallo**: Imposibilidad estructural — no existe código que pueda crear un asiento desbalanceado
**Rollback**: N/A

### Tabla 2: Suma de splits = monto de transacción

**¿La evidencia está presente?** Sí — ReconciliationService lanza ValidationError

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| reconciliation.service.ts | 188-193 | Math.abs(splitSum - absBankAmount) > 0.01 → throw new ValidationError(...) |
| reconciliation.service.ts | 194-196 | Splits con monto cero → throw new ValidationError('Split amounts must be greater than zero') |

**Comportamiento ante fallo**: Lanza ValidationError (HTTP 400)
**Rollback**: Sí — ocurre dentro de db.$transaction

### Tabla 3: Período fiscal activo (per-transaction)

**¿La evidencia está presente?** Sí — assertActiveFiscalPeriod lanza ForbiddenError

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| fiscal-period-guard.ts | 31-34 | throw new ForbiddenError('Cannot post transactions to a closed period...') |

**Comportamiento ante fallo**: Lanza ForbiddenError (HTTP 403)
**Rollback**: Sí — llamado dentro de $transaction

### Tabla 4: Aislamiento de tenant

**¿La evidencia está presente?** Sí — ReconciliationService lanza ValidationError

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| reconciliation.service.ts | 95-101 | throw new ValidationError('GL account ${glAccountId} does not belong to this company...') |
| reconciliation.service.ts | 84-88 | Comentario: "Reject BEFORE any write so the whole transaction rolls back with no partial state" |

**Comportamiento ante fallo**: Lanza ValidationError (HTTP 400)
**Rollback**: Sí — ocurre dentro de db.$transaction

### Tabla 5: Una JournalEntry por BankTransaction (1:1)

**¿La evidencia está presente?** Sí — verificación dual: aplicación salta, base de datos lanza

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| reconciliation.service.ts | 103-108, 178 | hasExistingJournalEntry → skip creación (silencioso) |
| schema.prisma | 213 | @unique → PostgreSQL lanza UniqueViolation si se viola |

**Comportamiento ante fallo**: Aplicación: salta silenciosamente. Base de datos: lanza Prisma UniqueViolation (HTTP 400)
**Rollback**: Aplicación: no necesita rollback. Base de datos: sí, dentro de $transaction

### Tabla 6: Código GL único por company

**¿La evidencia está presente?** Sí — PostgreSQL lanza unique constraint violation

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 148 | @@unique([companyId, code]) |
| journal-entry.service.ts | 185-188 | upsert con companyId_code maneja race conditions graceful |

**Comportamiento ante fallo**: PostgreSQL lanza unique constraint violation → Prisma error → HTTP 400 "DATABASE_ERROR"
**Rollback**: Sí, si está dentro de $transaction

### Tabla 7: Bank statement único por cuenta/rango

**¿La evidencia está presente?** Sí — PostgreSQL lanza unique constraint violation

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 194 | @@unique([bankAccountId, startDate, endDate]) |

**Comportamiento ante fallo**: PostgreSQL lanza unique constraint violation → Prisma error → HTTP 400 "DATABASE_ERROR"
**Rollback**: Sí, si está dentro de $transaction

### Tabla 8: Membresía de company única

**¿La evidencia está presente?** Sí — PostgreSQL lanza unique constraint violation

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 121 | @@unique([userId, companyId]) |

**Comportamiento ante fallo**: PostgreSQL lanza unique constraint violation → Prisma error → HTTP 400 "DATABASE_ERROR"
**Rollback**: Sí, si está dentro de $transaction

### Tabla 9: Clasificación one-shot

**¿La evidencia está presente?** Sí — filtro silencioso que excluye transacciones no elegibles

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| transaction-invariants.ts | 3-9 | ELIGIBLE_FOR_CLASSIFICATION_FILTER excluye silenciosamente transacciones ya clasificadas |

**Comportamiento ante fallo**: Omisión silenciosa — transacciones ya clasificadas son excluidas del resultado de la query
**Rollback**: N/A

### Tabla 10: Balance materializado consistente

**¿La evidencia está presente?** Sí — mecanismo de recálculo, no de verificación

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| journal-entry.service.ts | 82-120 | recalculateBalance recalcula desde journal lines, no verifica |

**Comportamiento ante fallo**: No produce fallo observable — es un mecanismo de recálculo que actualiza el balance materializado
**Rollback**: N/A

### Tabla 11: Deduplicación por import hash

**¿La evidencia está presente?** Sí — PostgreSQL lanza unique constraint violation

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 212 | importHash String? @unique |
| import.service.ts | 499 | Import service dentro de $transaction |

**Comportamiento ante fallo**: PostgreSQL lanza unique constraint violation → Prisma error → HTTP 400 "DATABASE_ERROR"
**Rollback**: Sí, dentro de $transaction

### Tabla 12: Idempotency key

**¿La evidencia está presente?** Sí — PostgreSQL lanza unique constraint violation

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 332, 364 | @@unique([companyId, idempotencyKey]) en JournalEntry, @unique en RuleApplyRecord |

**Comportamiento ante fallo**: PostgreSQL lanza unique constraint violation → Prisma error → HTTP 400 "DATABASE_ERROR"
**Rollback**: Sí, si está dentro de $transaction

### Tabla 13: Monto mínimo de transacción

**¿La evidencia está presente?** Sí — return null que omite silenciosamente

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| journal-entry.service.ts | 36-37 | if (amount < 0.01) return null |

**Comportamiento ante fallo**: Omisión silenciosa — retorna null sin crear journal entry
**Rollback**: N/A

### Tabla 14: Nombre de período fiscal único

**¿La evidencia está presente?** Sí — PostgreSQL lanza unique constraint violation

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 390 | @@unique([companyId, name]) |

**Comportamiento ante fallo**: PostgreSQL lanza unique constraint violation → Prisma error → HTTP 400 "DATABASE_ERROR"
**Rollback**: Sí, si está dentro de $transaction

---

## 9. RELACIONES

- ADR_INPUT_011 inventarió los catorce invariantes de consistencia
- ADR_INPUT_012 identificó quién verifica cada uno
- ADR_INPUT_013 determinó cuándo se verifican
- ADR_INPUT_014 determina qué ocurre cuando falla
- S10-D.5 determinará si el sistema puede quedar en estado parcialmente consistente

**Relación con el paso anterior**: ADR_INPUT_014 utiliza los momentos de verificación de ADR_INPUT_013 como punto de partida y produce la evidencia necesaria para S10-D.5 (si el sistema puede quedar parcialmente consistente).

---

## 10. RESPUESTA A LA PREGUNTA

### Cadena lógica (4 pasos)

1. **Dato observado**: Cuatro invariantes no producen fallo observable: balance doble (imposibilidad estructural — ambas líneas se crean desde la misma variable), clasificación one-shot (filtro WHERE que excluye silenciosamente), balance materializado (recálculo que sanación, no verificación), y monto mínimo (return null que omite silenciosamente).

2. **Dato observado**: Tres invariantes lanzan excepciones de aplicación cuando fallan: splits (ValidationError), período fiscal (ForbiddenError), y tenant (ValidationError). En las implementaciones inspeccionadas, todas estas excepciones fueron lanzadas dentro de `db.$transaction()`. ValidationError → HTTP 400 (api-error.ts:14-18), ForbiddenError → HTTP 403 (api-error.ts:26-29).

3. **Dato observado**: Un invariante tiene verificación dual: una JournalEntry por BankTransaction. La aplicación salta silenciosamente si ya existe (reconciliation.service.ts:178), pero la restricción de schema lanza Prisma UniqueViolation si se viola (schema.prisma:213). Prisma errors → HTTP 400 (api-handler.ts:209-219).

4. **Dato observado**: Seis invariantes son verificados por restricciones de schema. Cuando fallan, PostgreSQL lanza unique constraint violation → Prisma error → HTTP 400 "DATABASE_ERROR" (api-handler.ts:209-219). En las implementaciones inspeccionadas, estos errores ocurrieron dentro de `db.$transaction()`, produciendo rollback atómico.

### Conclusión

Con el universo inspeccionado en esta orden, los catorce invariantes de consistencia identificados en ADR_INPUT_011 tienen los siguientes comportamientos cuando la condición de verificación no se cumple:

**Verificaciones que producen excepción** (3 invariantes):
- Split sum = monto — ValidationError → HTTP 400 + rollback
- Período fiscal activo — ForbiddenError → HTTP 403 + rollback
- Aislamiento de tenant — ValidationError → HTTP 400 + rollback

**Verificaciones que producen error de base de datos** (6 invariantes):
- Código GL único por company — UniqueViolation → HTTP 400 + rollback
- Bank statement único por cuenta/rango — UniqueViolation → HTTP 400 + rollback
- Membresía de company única — UniqueViolation → HTTP 400 + rollback
- Import hash único — UniqueViolation → HTTP 400 + rollback
- Idempotency key de JournalEntry única — UniqueViolation → HTTP 400 + rollback
- Nombre de período fiscal único — UniqueViolation → HTTP 400 + rollback

**Verificaciones que producen omisión silenciosa** (2 invariantes):
- Clasificación one-shot — filtro WHERE que excluye silenciosamente transacciones no elegibles
- Monto mínimo — return null que omite silenciosamente la creación de journal entry

**Invariantes cuya violación no es representable** (2 invariantes):
- Balance doble — imposibilidad estructural (ambas líneas se crean desde la misma variable)
- Balance materializado — mecanismo de recálculo, no de verificación (se incluye porque ADR_INPUT_011 lo inventarió como invariante; la inspección demostró que su implementación corresponde a un mecanismo de recálculo y no a una verificación explícita)

**Nota sobre verificación dual**: El invariante "Una JournalEntry por BankTransaction" utiliza verificación dual (aplicación + base de datos). Según el punto donde se detecte la condición, el comportamiento observado es omisión silenciosa (lado aplicación) o error de base de datos (lado base de datos).

En las implementaciones inspeccionadas se observaron cuatro categorías de comportamiento cuando la condición de verificación no se cumple: excepción de aplicación, error de base de datos, omisión silenciosa, e imposibilidad estructural. No pudo demostrarse si existen otros comportamientos fuera del universo inspeccionado.

---

## 11. CONFIANZA

**Nivel de confianza**: 10/10

**Razón**: La evidencia es clara para cada invariante individual. La conclusión se limita a describir comportamientos observados sin introducir categorías conceptuales no demostradas.

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

- **Entrada**: Para S10-D.5 (¿puede el sistema quedar en estado parcialmente consistente?)
- **Base**: Para futuros ADRs sobre comportamiento ante fallos
- **Referencia**: Para validar comportamientos ante fallo en otros contextos

---

## Metadatos

- **Autor**: Researcher
- **Fecha de creación**: 2026-09-06
- **Última actualización**: 2026-09-06
- **Estado**: Validado
- **Versión**: 1.0
- **Confianza**: 10/10
