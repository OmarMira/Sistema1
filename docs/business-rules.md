# Business Rules

Reglas de negocio del sistema. No describen implementación — describen **qué** debe cumplirse.

---

## Chart of Accounts

- Cada `GlAccount` puede tener hijos (subcuentas) formando una jerarquía
- Una cuenta con hijos no puede recibir asientos directamente (solo cuentas hoja)
- Una cuenta no puede eliminarse si tiene transacciones o subcuentas

## Bank Reconciliation

- Una transacción conciliada queda vinculada a su `ReconciliationPeriod`
- Una transacción conciliada no puede modificarse ni eliminarse
- Des-reconciliar una transacción requiere justificación en `AuditLog`
- El saldo conciliado debe coincidir con el saldo del extracto bancario al cierre del período

## Fiscal Period

- Un `FiscalPeriod` cerrado no permite nuevos asientos
- Reabrir un período cerrado requiere registro en `AuditLog`
- Un período no puede cerrarse si hay transacciones sin clasificar en ese rango de fechas

## Import

- Un archivo subido se procesa una sola vez (idempotente por hash)
- Si el parser no reconoce el formato, se devuelve error sin crash
- Si el extracto no cierra (math mismatch), se importa igual pero queda marcado como warning
- Todo import queda registrado en `AuditLog`

## Transaction Classification

**Orden de prioridad:**

1. **BankRule explícita**: si una regla matchea, se aplica sin consultar IA
2. **Contexto histórico**: si la misma entidad ya se clasificó igual, se extrapola
3. **Entity Detection**: si el contexto sugiere una entidad conocida, se asigna
4. **IA propone**: solo cuando 1-3 no producen resultado
5. **Humano decide**: el contador acepta, rechaza o reclasifica

## Journal Entries

- Todo `JournalEntry` debe balancear (total débitos = total créditos)
- Un asiento puede tener múltiples líneas
- Las líneas de débito y crédito deben referenciar cuentas hoja del plan de cuentas
- Un asiento no puede modificarse una vez conciliado

## Audit

- Toda operación con efecto contable se registra en `AuditLog`
- El `AuditLog` forma una cadena de integridad: cada entrada contiene el hash de la anterior
- Las entradas de `AuditLog` son append-only: no se editan ni eliminan
