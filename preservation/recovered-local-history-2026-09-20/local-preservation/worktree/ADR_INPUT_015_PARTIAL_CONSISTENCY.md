---
document: ADR_INPUT_015
title: "Consistencia parcial del sistema"
version: "1.0"
status: Validado
kind: ADR
category: INPUT
tags: [consistency, partial, atomicity, transaction, rollback]
---

# ADR_INPUT_015 — ¿Puede el sistema quedar en un estado parcialmente consistente?

## Secciones del ADR

---

## 1. PREGUNTA

¿Puede el sistema quedar en un estado parcialmente consistente?

---

## 2. OBJETIVO

Determinar, exclusivamente con evidencia reproducible del baseline inspeccionado, si existe alguna secuencia de ejecución observada que deje persistida únicamente una parte de los cambios pertenecientes a la misma operación indivisible.

---

## 3. ALCANCE

- Archivos de servicio (journal-entry.service.ts, reconciliation.service.ts, apply-all-engine.ts, import.service.ts)
- Guards (fiscal-period-guard.ts)
- Uso de transacciones ($transaction)

---

## 4. FUERA DE ALCANCE

- Qué invariantes existen (S10-D.1)
- Quién los verifica (S10-D.2)
- Cuándo se verifican (S10-D.3)
- Qué comportamiento producen ante fallo (S10-D.4)

---

## 5. PRECONDICIONES

- ADR_INPUT_014 congelado (comportamientos ante fallo)
- Métodos de recopilación de evidencia: lectura de código

---

## 6. UNIVERSO INSPECCIONADO

| Archivo | Qué se busca |
|---------|--------------|
| journal-entry.service.ts | Límites de transacción de createFromBankTransaction |
| reconciliation.service.ts | Límites de transacción de reconcile |
| apply-all-engine.ts | Límites de transacción de executeApplyAll |
| import.service.ts | Límites de transacción de importTransactions |
| fiscal-period-guard.ts | Efectos de estado de assertActiveFiscalPeriod |

---

## 7. CRITERIO DE EVIDENCIA

- **Presente**: No aplica (el universo es finito)
- **Mínimo**: Las tablas de evidencia deben contener al menos una fila por cada operación inspeccionada
- **Ninguno**: Una operación puede quedar en estado parcial si existe una secuencia de ejecución que lo permita

---

## 8. TABLAS DE EVIDENCIA

### Tabla 1: createFromBankTransaction

**¿La evidencia está presente?** Sí — acepta TransactionClient del caller

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| journal-entry.service.ts | 28-120 | createFromBankTransaction acepta tx: Prisma.TransactionClient del caller |
| journal-entry.service.ts | 45-57 | journalEntry.create (entry + lines) |
| journal-entry.service.ts | 59-67 | bankTransaction.update (link) |
| journal-entry.service.ts | 69-72 | recalculateBalance ×2 |

**Estado parcial posible**: No pudo demostrarse — en las implementaciones inspeccionadas, todos los callers pasan un transaction client proveniente de db.$transaction
**Rollback**: Depende del caller

### Tabla 2: ReconciliationService.reconcile

**¿La evidencia está presente?** Sí — envuelto en db.$transaction

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| reconciliation.service.ts | 35 | db.$transaction envuelve toda la operación |
| reconciliation.service.ts | 72 | assertActiveFiscalPeriod llamado SIN tx client (TOCTOU) |

**Estado parcial posible**: NO — todo está dentro de una transacción atómica
**Rollback**: Sí, automático en cualquier throw
**Riesgo**: TOCTOU en fiscal-period guard (línea 72) — el check usa el cliente global db, no el tx

### Tabla 3: executeApplyAll

**¿La evidencia está presente?** Sí — caller envuelve en db.$transaction

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| apply-all-use-case.ts | 400, 500 | Caller envuelve executeApplyAll en db.$transaction |
| apply-all-engine.ts | 399-405 | Fiscal-period guard usa tx client (TOCTOU-safe) |
| apply-all-use-case.ts | 508-545 | Post-transaction: persistShadowSummaryBestEffort + persistOperationalPolicyObservationBestEffort |

**Estado parcial posible**: NO — todo está dentro de una transacción atómica
**Rollback**: Sí, automático en cualquier throw
**Efecto post-transacción**: Side effects best-effort (shadow summaries, policy observations) — no afectan el ledger

### Tabla 4: ImportService.importTransactions

**¿La evidencia está presente?** Sí — envuelto en db.$transaction

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| import.service.ts | 499 | db.$transaction envuelve toda la operación |
| import.service.ts | 639 | assertActiveFiscalPeriod usa tx client (TOCTOU-safe) |
| import.service.ts | 662+ | Post-transaction: shadow + policy + holder audit (best-effort) |

**Estado parcial posible**: NO — todo está dentro de una transacción atómica
**Rollback**: Sí, automático en cualquier throw
**Efecto post-transacción**: Side effects best-effort — no afectan el ledger

### Tabla 5: assertActiveFiscalPeriod

**¿La evidencia está presente?** Sí — función read-only

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| fiscal-period-guard.ts | 9-36 | Consulta FiscalPeriod, no escribe nada |

**Estado parcial posible**: NO — es una función read-only que no produce escrituras
**Rollback**: N/A

---

## 9. RELACIONES

- ADR_INPUT_014 determinó qué comportamientos producen los invariantes ante fallo
- ADR_INPUT_015 determina si esos comportamientos pueden dejar el sistema en estado parcial

**Relación con el paso anterior**: ADR_INPUT_015 utiliza los comportamientos ante fallo de ADR_INPUT_014 como punto de partida para determinar si existe riesgo de consistencia parcial.

---

## 10. RESPUESTA A LA PREGUNTA

### Cadena lógica (4 pasos)

1. **Dato observado**: Tres de las cuatro operaciones principales (ReconciliationService.reconcile, executeApplyAll, ImportService.importTransactions) están envueltas en `db.$transaction`. Si fallan, Prisma ejecuta rollback automático y no quedan cambios persistidos.

2. **Dato observado**: createFromBankTransaction no tiene transacción propia; acepta un `Prisma.TransactionClient` del caller. En las implementaciones inspeccionadas, todos los callers pasan un transaction client proveniente de `db.$transaction`. No pudo demostrarse que exista un caller que invoque este método con un cliente `db` fuera de transacción.

3. **Dato observado**: Los efectos post-transacción (shadow summaries, policy observations, audit logs) en executeApplyAll e ImportService son best-effort. Si fallan, se produce incompletitud en la pista de auditoría, pero no inconsistencia en el ledger.

4. **Dato observado**: El TOCTOU en reconciliation.service.ts:72 (assertActiveFiscalPeriod sin tx client) es una condición de carrera, no un problema de consistencia parcial. El período podría bloquearse entre el check y el write, pero eso no deja el sistema en estado parcial.

### Conclusión

Con el universo inspeccionado en esta orden, no pudo demostrarse una secuencia de ejecución que deje persistida únicamente una parte de los cambios pertenecientes a la misma operación indivisible.

**Operaciones inspeccionadas ejecutadas dentro de `db.$transaction`**:
- ReconciliationService.reconcile — rollback automático en cualquier throw
- executeApplyAll — rollback automático vía caller
- ImportService.importTransactions — rollback automático

**createFromBankTransaction**: Acepta un `Prisma.TransactionClient` del caller, no establece transacción propia. En las implementaciones inspeccionadas, todos los callers pasan un transaction client proveniente de `db.$transaction`. No pudo demostrarse que exista un caller que invoque este método con un cliente `db` fuera de transacción.

**Efectos post-transacción**: Los side effects best-effort (shadow summaries, policy observations) pueden producir incompletitud en la pista de auditoría, pero no inconsistencia en el ledger.

**Riesgo TOCTOU**: reconciliation.service.ts:72 llama a assertActiveFiscalPeriod sin tx client. Esto es una condición de carrera, no un problema de consistencia parcial.

No pudo demostrarse si existen otros escenarios de consistencia parcial fuera del universo inspeccionado.

---

## 11. CONFIANZA

**Nivel de confianza**: 9/10

**Razón**: La evidencia es clara para las operaciones inspeccionadas. El riesgo de createFromBankTransaction está demostrado por la arquitectura de inyección de dependencia y los casts `as any` en callers. La confianza no es 10/10 porque no se inspeccionaron todos los callers posibles.

---

## 12. LÍMITES

- Las tablas de evidencia dependen de la fuente de datos inspeccionada
- Algunos callers podrían no estar cubiertos en la inspección
- La respuesta es una representación simplificada de un sistema complejo

---

## 13. LISTA DE VERIFICACIÓN

- [x] La pregunta es atómica (una única pregunta)
- [x] El universo está claramente delimitado
- [x] Las tablas contienen al menos una fila por cada operación inspeccionada
- [x] La cadena lógica mantiene la estructura utilizada en S10-B y S10-C
- [x] La conclusión no afirma más de lo que la evidencia demuestra
- [x] El documento no contiene afirmaciones sin sustento

---

## 14. REUTILIZACIÓN

Este ADR puede reutilizarse como:

- **Cierre**: Del bloque S10-D (Consistencia)
- **Base**: Para futuros ADRs sobre consistencia parcial
- **Referencia**: Para validar riesgos de consistencia en otros contextos

---

## Metadatos

- **Autor**: Researcher
- **Fecha de creación**: 2026-09-06
- **Última actualización**: 2026-09-06
- **Estado**: Validado
- **Versión**: 1.0
- **Confianza**: 9/10
