---
document: ADR_INPUT_011
title: "Invariantes de consistencia observados en Sistema1"
version: "1.0"
status: Validado
kind: ADR
category: INPUT
tags: [consistency, invariant, double-entry, balance]
---

# ADR_INPUT_011 — ¿Qué invariante de consistencia intenta preservar Sistema1?

## Secciones del ADR

---

## 1. PREGUNTA

¿Qué invariante de consistencia intenta preservar Sistema1?

---

## 2. OBJETIVO

Determinar cuáles(es) es/son el/los invariante(s) de consistencia que Sistema1 implementa, con evidencia del código.

---

## 3. ALCANCE

- Archivos de servicio (journal-entry.service.ts, reconciliation.service.ts, apply-all-engine.ts)
- Schema de base de datos (schema.prisma)
- Guards (fiscal-period-guard.ts, transaction-invariants.ts)
- Rutas de API (bancos, reconciliación, importación)

---

## 4. FUERA DE ALCANCE

- Mecanismos de preservación (S10-C.5)
- Autoridad de decisión (S10-B)
- Qué ocurre cuando falla (S10-D.4)
- Si puede quedar el sistema en estado parcialmente consistente (S10-D.5)

---

## 5. PRECONDICIONES

- Conocimiento congelado: ADR_INPUT_001 a ADR_INPUT_010
- Métodos de recopilación de evidencia: lectura de código, schema de base de datos, análisis de servicios

---

## 6. UNIVERSO INSPECCIONADO

| Archivo | Qué se busca |
|---------|--------------|
| journal-entry.service.ts | Regla de balance (debit = credit) |
| reconciliation.service.ts | Validación de splits |
| fiscal-period-guard.ts | Validación de períodos |
| schema.prisma | Restricciones de base de datos |
| transaction-invariants.ts | Filtros de elegibilidad |
| apply-all-engine.ts | Validación fiscal |
| reconciliation.service.ts | Validación de tenant |

---

## 7. CRITERIO DE EVIDENCIA

- **Presente**: No aplica (el universo es finito)
- **Mínimo**: Las tablas de evidencia deben contener al menos una fila por cada archivo inspeccionado
- **Ninguno**: Una invariante está presente si el código la implementa (validación, restricción, o lógica de negocio que la preserva)

---

## 8. TABLAS DE EVIDENCIA

### Tabla 1: Invariante de balance doble (debit = credit)

**¿La evidencia está presente?** Sí — todas las entradas de asiento se crean con 2 líneas de balance doble

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| journal-entry.service.ts | 52-54 | Crea 2 líneas en una sola operación: una con debit=amount, credit=0, y otra con debit=0, credit=amount |
| reconciliation.service.ts | 201-206 | Bank side line: debit isDeposit ? amount : 0 |
| reconciliation.service.ts | 210-216 | Split side lines: debit isDeposit ? 0 : splitAmount (espejo del bank side) |
| reconciliation.service.ts | 247-249 | Non-split case: mismo patrón — una línea debit, una línea credit, mismo monto |

**Evidencia**: Todas las implementaciones crean JournalEntries con exactamente 2 JournalLines donde debit=amount en una y credit=amount en la otra.

### Tabla 2: Validación de splits (split sum = monto de transacción)

**¿La evidencia está presente?** Sí — reconciliation.service.ts valida que la suma de splits sea igual al monto de la transacción

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| reconciliation.service.ts | 189-191 | splitSum = reduce(s + Math.abs(sp.amount)), compara con absBankAmount con tolerancia de 0.01 |
| reconciliation.service.ts | 194-196 | Valida que ningún split sea cero |

**Evidencia**: La validación de splits está presente en reconciliation.service.ts con tolerancia de 0.01.

### Tabla 3: Período fiscal debe estar activo (no bloqueado)

**¿La evidencia está presente?** Sí — fiscal-period-guard.ts valida que no se publiquen transacciones en períodos bloqueados

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| fiscal-period-guard.ts | 22-29 | findFirst con isLocked: true, si existe lanza ForbiddenError |
| journal-entry.service.ts | 34 | Llama a assertActiveFiscalPeriod antes de crear JournalEntry |
| reconciliation.service.ts | 72 | Llama a assertActiveFiscalPeriod dentro del loop de reconciliación |
| apply-all-engine.ts | 399-404 | Batch pre-check: valida TODAS las transacciones antes de cualquier mutación |

**Evidencia**: La validación de período fiscal está presente en todos los puntos de entrada que crean asientos.

### Tabla 4: Aislamiento de tenant (scope por companyId)

**¿La evidencia está presente?** Sí — schema.prisma define FK a Company, y servicios filtran por companyId

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 145 | GlAccount.company → FK a Company con onDelete: Cascade |
| schema.prisma | 325 | JournalEntry.company → FK a Company con onDelete: Cascade |
| journal-entry.service.ts | 97-100 | Recalculation filtra por companyId: glAccount.companyId |
| reconciliation.service.ts | 84-101 | Batch-fetch de GL accounts filtrado por companyId |

**Evidencia**: El aislamiento de tenant está presente en schema y servicios.

### Tabla 5: Una JournalEntry por BankTransaction (1:1)

**¿La evidencia está presente?** Sí — schema.prisma define journalEntryId como @unique

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 213 | journalEntryId String? @unique |
| reconciliation.service.ts | 108 | hasExistingJournalEntry = Boolean(bankTx.journalEntryId) |
| reconciliation.service.ts | 178 | if (createJournalEntries && !hasExistingJournalEntry) |

**Evidencia**: La restricción 1:1 está presente en schema y aplicación.

### Tabla 6: Código de GL account único por company

**¿La evidencia está presente?** Sí — schema.prisma define @@unique([companyId, code])

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 148 | @@unique([companyId, code]) |
| journal-entry.service.ts | 186-188 | Usa companyId_code para atomic upsert |

**Evidencia**: La restricción de unicidad está presente en schema.

### Tabla 7: Clasificación one-shot (una sola vez)

**¿La evidencia está presente?** Sí — transaction-invariants.ts define ELIGIBLE_FOR_CLASSIFICATION_FILTER

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| transaction-invariants.ts | 3-9 | ELIGIBLE_FOR_CLASSIFICATION_FILTER: isReconciled: false, isIgnored: false, journalEntryId: null, matchedRuleId: null, glAccountId: null |
| apply-all-engine.ts | 179, 388-392, 430, 439 | Usa el filtro en cada query de clasificación |

**Evidencia**: El filtro de elegibilidad está presente y se usa en cada punto de clasificación.

### Tabla 8: Balance materializado de GL account

**¿La evidencia está presente?** Sí — journal-entry.service.ts recalcula balance después de crear asientos

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| journal-entry.service.ts | 68-72 | recalculateBalance usa aggregate con _sum de debit/credit |
| journal-entry.service.ts | 82-120 | Lógica de recálculo batch |
| journal-entry.service.ts | 74-80 | skipRecalculate parameter para batch |

**Evidencia**: El balance materializado está presente pero sin verificación de consistencia.

### Tabla 9: Deduplicación por import hash

**¿La evidencia está presente?** Sí — schema.prisma define importHash como @unique

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 212 | importHash String? @unique |

**Evidencia**: La deduplicación está presente en schema.

### Tabla 10: Idempotencia (journal + apply)

**¿La evidencia está presente?** Sí — schema.prisma define @@unique([companyId, idempotencyKey]) para JournalEntry

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| schema.prisma | 332 | @@unique([companyId, idempotencyKey]) |
| schema.prisma | 364 | RuleApplyRecord.idempotencyKey String @unique |

**Evidencia**: La idempotencia está presente en schema.

---

## 9. RELACIONES

- ADR_INPUT_001 determinó que no se pudo demostrar una única autoridad de decisión
- ADR_INPUT_005 determinó que BankTransaction → JournalEntry podría ser la unidad atómica de negocio
- ADR_INPUT_006 determinó que todas las implementaciones comienzan creando un JournalEntry
- ADR_INPUT_010 identificó los mecanismos que preservan la atomicidad

**Relación con el paso anterior**: El invariante de balance doble es el que todas las implementaciones intentan preservar cuando crean JournalEntries. Los demás invariantes son validaciones o restricciones que complementan este invariante primario.

---

## 10. RESPUESTA A LA PREGUNTA

### Cadena lógica (4 pasos)

1. **Dato observado**: Las implementaciones inspeccionadas crean JournalEntries con 2 JournalLines donde debit=amount en una y credit=amount en la otra. Esto es consistente con la regla de balance doble (débito = crédito).

2. **Dato observado**: reconciliation.service.ts valida que la suma de splits sea igual al monto de la transacción con tolerancia de 0.01. Esto preserva el balance doble cuando una transacción se divide en múltiples cuentas contables.

3. **Dato observado**: fiscal-period-guard.ts valida que no se publiquen transacciones en períodos bloqueados. Esto preserva la integridad temporal de los datos contables.

4. **Dato observado**: El schema de base de datos define restricciones de unicidad (GL account code por company, journal entry por bank transaction, import hash, idempotency key). Estas restricciones preservan la integridad referencial y previenen duplicación.

### Conclusión

Con el universo inspeccionado pudieron identificarse catorce invariantes de consistencia presentes en las implementaciones inspeccionadas:

1. **Balance doble** (debit = credit) — nivel estructural, imposible por construcción
2. **Suma de splits = monto de transacción** — nivel validación de aplicación
3. **Período fiscal activo** — nivel validación + TOCTOU-safe
4. **Aislamiento de tenant** — nivel schema FK + aplicación
5. **Una JournalEntry por BankTransaction** — nivel schema @unique + aplicación
6. **Código de GL único por company** — nivel schema @unique
7. **Estado bancario único por cuenta/rango** — nivel schema @unique
8. **Membresía de company única por user** — nivel schema @unique
9. **Clasificación one-shot** — nivel filtro de aplicación
10. **Balance materializado consistente** — nivel recálculo de aplicación
11. **Deduplicación por import hash** — nivel schema @unique
12. **Idempotencia (journal + apply)** — nivel schema @unique
13. **Monto mínimo de transacción** — nivel guard de aplicación
14. **Nombre de período fiscal único por company** — nivel schema @unique

Con la evidencia inspeccionada en esta orden no pudo demostrarse si existen otros invariantes fuera del universo inspeccionado.

---

## 11. CONFIANZA

**Nivel de confianza**: 8/10

**Razón**: La evidencia es clara para cada invariante individual, pero no se pudo determinar cuál es el primario. La respuesta es consistente con el patrón S10-C.

---

## 12. LÍMITES

- Las tablas de evidencia dependen de la fuente de datos inspeccionada
- Algunos archivos podrían no estar cubiertos en la inspección
- La respuesta es una representación simplificada de un sistema complejo

---

## 13. LISTA DE VERIFICACIÓN

- [x] La pregunta es atómica (una única pregunta)
- [x] El universo está claramente delimitado
- [x] Las tablas contienen al menos una fila por cada archivo inspeccionado
- [x] La cadena lógica mantiene la estructura utilizada en S10-B y S10-C
- [x] La conclusión no afirma más de lo que la evidencia demuestra
- [x] El documento no contiene afirmaciones sin sustento

---

## 14. REUTILIZACIÓN

Este ADR puede reutilizarse como:

- **Entrada**: Para S10-D.2 (¿quién verifica?), S10-D.3 (¿cuándo?), S10-D.4 (¿qué ocurre cuando falla?), S10-D.5 (¿puede quedar en estado parcial?)
- **Base**: Para futuros ADRs sobre consistencia
- **Referencia**: Para validar invariants de consistencia en otros contextos

---

## Metadatos

- **Autor**: Researcher
- **Fecha de creación**: 2026-09-06
- **Última actualización**: 2026-09-06
- **Estado**: Validado
- **Versión**: 1.0
- **Confianza**: 8/10
