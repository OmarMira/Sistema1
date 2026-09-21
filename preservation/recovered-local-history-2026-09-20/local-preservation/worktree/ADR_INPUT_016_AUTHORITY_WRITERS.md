---
document: ADR_INPUT_016
title: "Componentes con autoridad de escritura"
version: "1.1"
status: Validado
kind: ADR
category: INPUT
tags: [authority, writers, mutation, api-routes, services]
---

# ADR_INPUT_016 — ¿Qué componentes tienen autoridad para modificar el estado persistente?

## Secciones del ADR

---

## 1. PREGUNTA

¿Qué componentes tienen autoridad para modificar el estado persistente?

---

## 2. OBJETIVO

Determinar, exclusivamente con evidencia reproducible del baseline inspeccionado, qué componentes ejecutan o controlan mutaciones persistentes observadas.

---

## 3. ALCANCE

- Rutas de API bajo src/app/api
- Servicios bajo src/lib/services
- Infraestructura de escritura (sessions, audit, rate-limiter, etc.)

---

## 4. FUERA DE ALCANCE

- Quién delega autoridad (S10-E.3)
- Qué mecanismos limitan esa autoridad (S10-E.4)
- Si un componente puede modificar estado fuera de su autoridad (S10-E.5)
- Componentes de solo lectura (S10-E.2)

---

## 5. PRECONDICIONES

- Baseline inspeccionado (commit audit-s1-s9-complete)
- Métodos de recopilación de evidencia: lectura de código, búsqueda de mutaciones Prisma

---

## 6. UNIVERSO INSPECCIONADO

| Directorio | Qué se busca |
|------------|--------------|
| src/app/api | Rutas HTTP que ejecutan mutaciones |
| src/lib/services | Servicios que originan escrituras |
| src/lib | Infraestructura que escribe estado |

---

## 7. CRITERIO DE EVIDENCIA

- **Presente**: No aplica. El universo inspeccionado es finito y completamente recorrible.
- **Mínimo**: Las tablas de evidencia deben contener al menos una fila por cada categoría de componente
- **Ninguno**: Un componente tiene autoridad de escritura si ejecuta o controla una mutación persistente observada

---

## 8. DEFINICIONES

### Componente con autoridad de escritura

En este ADR se considera que un componente posee autoridad de escritura cuando ejecuta o controla directamente una mutación persistente observada en el baseline inspeccionado. Esta es una definición operacional del ADR, no una propiedad arquitectónica demostrada.

### Componente que recibe un transaction client

Un componente recibe un transaction client si su firma de función incluye un parámetro `tx` o `prisma` que representa una transacción abierta por otro componente. Este componente escribe dentro de la transacción del caller, no abre la transacción.

---

## 9. TABLAS DE EVIDENCIA

### Tabla 1: Rutas de API — Gestión de usuarios

**¿La evidencia está presente?** Sí — rutas que crean, actualizan y eliminan usuarios

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| POST /api/users | — | Crea User, CompanyMember, AuditLog |
| PATCH /api/users/profile | — | Actualiza User, crea AuditLog |
| POST /api/settings/password | — | Actualiza User, crea AuditLog, elimina Sessions |
| POST /api/admin/users | — | Crea User, crea AuditLog |
| PATCH /api/admin/users/[id] | — | Actualiza User, crea AuditLog, elimina Sessions |
| DELETE /api/admin/users/[id] | — | Elimina User, crea AuditLog |

### Tabla 2: Rutas de API — Gestión de companies

**¿La evidencia está presente?** Sí — rutas que crean, actualizan y eliminan companies

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| POST /api/admin/companies | — | Crea Company, CompanyMember, GLAccounts (seed), AuditLog |
| PUT /api/admin/companies/[id] | — | Actualiza Company, crea AuditLog |
| DELETE /api/admin/companies/[id] | — | Elimina Company + 12 tablas hijas por cascade |
| POST /api/admin/companies/[id]/users | — | Crea CompanyMember, crea AuditLog |
| DELETE /api/admin/companies/[id]/users/[userId] | — | Elimina CompanyMember, crea AuditLog |

### Tabla 3: Rutas de API — Gestión de cuentas contables

**¿La evidencia está presente?** Sí — rutas que crean, actualizan y eliminan GL accounts

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| POST /api/accounts | — | Crea GlAccount, crea AuditLog |
| PUT /api/accounts/[id] | — | Actualiza GlAccount, crea AuditLog |
| DELETE /api/accounts/[id] | — | Elimina GlAccount, crea AuditLog |

### Tabla 4: Rutas de API — Gestión de cuentas bancarias

**¿La evidencia está presente?** Sí — rutas que crean, actualizan y eliminan bank accounts

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| POST /api/banks | — | Crea BankAccount, JournalEntry, JournalLine, upsert GlAccount (OBE) |
| PUT /api/banks/[id] | — | Actualiza BankAccount, upsert GlAccount (OBE) |
| DELETE /api/banks/[id] | — | Soft-delete BankAccount |

### Tabla 5: Rutas de API — Core contable

**¿La evidencia está presente?** Sí — rutas que crean y modifican asientos contables

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| POST /api/journal | — | Crea JournalEntry, JournalLine, AuditLog, actualiza GlAccount |
| PATCH /api/transactions/[id] | — | Actualiza BankTransaction, crea JournalEntry, JournalLine, actualiza GlAccount |
| POST /api/reconciliation | — | Delega a ReconciliationService.reconcile |

### Tabla 6: Rutas de API — Reglas bancarias

**¿La evidencia está presente?** Sí — rutas que gestionan reglas y ejecutan clasificación

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| POST /api/bank-rules | — | Crea BankRule, crea AuditLog |
| PUT /api/bank-rules/[id] | — | Actualiza BankRule |
| DELETE /api/bank-rules/[id] | — | Elimina BankRule, actualiza BankTransactions |
| POST /api/bank-rules/[id] (apply) | — | Delega a single-rule-apply.service |

### Tabla 7: Rutas de API — Períodos fiscales

**¿La evidencia está presente?** Sí — rutas que gestionan períodos fiscales

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| POST /api/fiscal-periods | — | Crea FiscalPeriod, crea AuditLog |
| POST /api/fiscal-periods/generate | — | Crea FiscalPeriods (bulk), crea AuditLog |
| PATCH /api/fiscal-periods/[id] | — | Actualiza FiscalPeriod, crea AuditLog |
| POST /api/fiscal-periods/close | — | Delega a closing-engine.executeYearClose |

### Tabla 8: Rutas de API — Importación

**¿La evidencia está presente?** Sí — rutas que importan transacciones

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| POST /api/import | — | Delega a ImportService.importFile |

### Tabla 9: Rutas de API — Onboarding

**¿La evidencia está presente?** Sí — ruta que configura la empresa

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| POST /api/onboarding/complete | — | Delega a onboarding.service.completeOnboarding |

### Tabla 10: Servicios que originan mutaciones

**¿La evidencia está presente?** Sí — servicios que originan escrituras

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| JournalService.create | — | Crea JournalEntry, JournalLine, actualiza GlAccount |
| ReconciliationService.reconcile | — | Actualiza BankTransaction, crea JournalEntry, JournalLine, actualiza GlAccount |
| closing-engine.executeYearClose | — | Crea JournalEntry, JournalLine, actualiza FiscalPeriod |
| onboarding.service.completeOnboarding | — | Crea Company, FiscalPeriod, GlAccount, JournalEntry, JournalLine, BankAccount |
| ImportService.importFile | — | Crea BankStatement, BankTransaction, JournalEntry, JournalLine, actualiza GlAccount |
| apply-all-use-case.executeApplyAllUseCase | — | Actualiza BankTransaction, crea JournalEntry, JournalLine, actualiza GlAccount, crea RuleApplyRecord |
| entity-context-crud-service | — | Crea/actualiza/elimina EntityContext, BankRule |
| company-knowledge/entity/service | — | Crea/actualiza CompanyKnowledge, PendingApproval, KnowledgeAudit |
| rollback-apply.service.revertApplyRecord | — | Anula JournalEntry, actualiza BankTransaction, GlAccount, RuleApplyRecord |
| entity-classifier.classifyEntity | — | Crea/actualiza EntityContext, BankRule |

### Tabla 11: Servicios que reciben un transaction client del caller

**¿La evidencia está presente?** Sí — servicios que reciben transaction client del caller

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| JournalEntryService.createFromBankTransaction | — | Crea JournalEntry, JournalLine, actualiza BankTransaction, GlAccount |
| JournalEntryService.recalculateBalance | — | Actualiza GlAccount.balance |
| single-rule-apply.service | — | Actualiza BankTransaction, crea JournalEntry, JournalLine, actualiza GlAccount |
| chart-of-accounts.seedChartOfAccounts | — | Crea GlAccounts |

### Tabla 12: Infraestructura de escritura

**¿La evidencia está presente?** Sí — componentes de infraestructura que escriben

| Ubicación | Línea(s) | Observación |
|-----------|----------|-------------|
| lib/sessions.ts | — | Crea/elimina Sessions |
| lib/audit.ts | — | Crea AuditLog (createAuditLogWithRetry) |
| lib/bank-profile-service.ts | — | Upsert BankProfile |
| lib/ai-config.ts | — | Upsert SystemConfig |
| lib/rate-limiter.ts | — | Upsert rate limit windows |
| lib/backup.ts | — | Restore de 12+ tablas |
| lib/rule-engine/audit.ts | — | Crea RuleExecutionAudit |

---

## 10. RELACIONES

- S10-B determinó que no se pudo demostrar una única autoridad de decisión
- S10-D determinó los invariantes de consistencia y quién los verifica
- S10-E.1 inventaria los componentes con autoridad de escritura

**Relación con el paso anterior**: S10-E.1 utiliza el inventario de componentes como punto de partida para S10-E.2 (lectores), S10-E.3 (delegación), S10-E.4 (límites) y S10-E.5 (violaciones).

---

## 11. RESPUESTA A LA PREGUNTA

### Cadena lógica (4 pasos)

1. **Dato observado**: Se identificaron 30+ rutas de API que ejecutan mutaciones. Cada ruta importa `db` directamente desde `@/lib/db` y ejecuta operaciones Prisma.

2. **Dato observado**: Se identificaron 10 servicios que originan mutaciones (JournalService, ReconciliationService, closing-engine, onboarding.service, ImportService, apply-all-use-case, entity-context-crud-service, company-knowledge/entity/service, rollback-apply.service, entity-classifier). Estos reciben la request del caller y abren su propia transacción o ejecutan operaciones directas.

3. **Dato observado**: Se identificaron 4 servicios que reciben un transaction client del caller (JournalEntryService.createFromBankTransaction, JournalEntryService.recalculateBalance, single-rule-apply.service, chart-of-accounts.seedChartOfAccounts). Estos no abren transacciones propias; escriben dentro de la transacción del caller.

4. **Dato observado**: Se identificaron 9+ componentes de infraestructura que escriben (sessions.ts, audit.ts, bank-profile-service.ts, ai-config.ts, rate-limiter.ts, backup.ts, rule-engine/audit.ts).

### Conclusión

Con el universo inspeccionado en esta orden, los componentes con autoridad para modificar el estado persistente son:

**Rutas de API** (30+ rutas): Entry points HTTP que ejecutan mutaciones.

**Servicios que originan mutaciones** (10 servicios): JournalService, ReconciliationService, closing-engine, onboarding.service, ImportService, apply-all-use-case, entity-context-crud-service, company-knowledge/entity/service, rollback-apply.service, entity-classifier.

**Servicios que reciben un transaction client** (4 servicios): JournalEntryService.createFromBankTransaction, JournalEntryService.recalculateBalance, single-rule-apply.service, chart-of-accounts.seedChartOfAccounts. Estos escriben dentro de la transacción del caller.

**Infraestructura de escritura** (9+ componentes): sessions.ts, audit.ts, bank-profile-service.ts, ai-config.ts, rate-limiter.ts, backup.ts, rule-engine/audit.ts.

No pudo demostrarse si existen componentes con autoridad de escritura fuera del universo inspeccionado.

---

## 12. CONFIANZA

**Nivel de confianza**: 9/10

**Razón**: La evidencia es clara para las rutas y servicios inspeccionados. La confianza no es 10/10 porque el universo declarado (src/app/api, src/lib/services, src/lib) podría no cubrir todos los componentes que escriben estado (por ejemplo, scripts de migración, tareas cron, o componentes en otros directorios).

---

## 13. LÍMITES

- Las tablas de evidencia dependen de la fuente de datos inspeccionada
- Algunos componentes podrían no estar cubiertos en la inspección
- La respuesta es una representación simplificada de un sistema complejo

---

## 14. LISTA DE VERIFICACIÓN

- [x] La pregunta es atómica (una única pregunta)
- [x] El universo está claramente delimitado
- [x] Las tablas contienen al menos una fila por cada categoría de componente
- [x] La cadena lógica mantiene la estructura utilizada en S10-B, S10-C y S10-D
- [x] La conclusión no afirma más de lo que la evidencia demuestra
- [x] El documento no contiene afirmaciones sin sustento
- [x] Los términos están definidos antes de su uso

---

## 15. REUTILIZACIÓN

Este ADR puede reutilizarse como:

- **Entrada**: Para S10-E.2 (lectores), S10-E.3 (delegación), S10-E.4 (límites), S10-E.5 (violaciones)
- **Base**: Para futuros ADRs sobre autoridad de escritura
- **Referencia**: Para validar autoridad de escritura en otros contextos

---

## Metadatos

- **Autor**: Researcher
- **Fecha de creación**: 2026-09-06
- **Última actualización**: 2026-09-06
- **Estado**: Validado
- **Versión**: 1.1
- **Confianza**: 9/10
