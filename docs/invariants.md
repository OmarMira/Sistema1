# System Invariants

Estas reglas deben cumplirse siempre. Si alguna se rompe, es un bug.

---

## Accounting

| Invariant | Violación |
|---|---|
| `JournalEntry` siempre balancea (débitos = créditos) | Asiento inválido |
| Una transacción conciliada no puede editarse ni eliminarse | Inconsistencia contable |
| Todo `BankAccount` pertenece exactamente a una `Company` | Data integrity |
| `FiscalPeriod` cerrado/bloqueado no acepta nuevos asientos | Period locking |
| Un `JournalLine` siempre referenica una `GlAccount` existente | Integridad referencial |

---

## Import

| Invariant | Violación |
|---|---|
| `opening + transactions = closing` es el contrato matemático del extracto | Math mismatch (warning, no bloqueante) |
| Dos transacciones con el mismo hash no se importan dos veces | Deduplicación |
| Un `BankStatement` no puede tener transacciones de otro banco | Bank profile mismatch |

---

## Audit

| Invariant | Violación |
|---|---|
| Todo cambio contable genera un `AuditLog` | Falta de trazabilidad |
| `AuditLog.hash` depende de `previousHash` (cadena de integridad) | Manipulación de auditoría |
| Ninguna regla (AI o determinista) modifica transacciones históricas | Immutabilidad de histórico |

---

## Security

| Invariant | Violación |
|---|---|
| `SESSION_SECRET` es obligatorio en todos los entornos | Riesgo de seguridad |
| `DATABASE_URL` en tests siempre termina en `accountexpress_test` | Contaminación de producción |
| Ningún endpoint expone API keys de AI | Filtración de secrets |

---

## Multi-tenancy

| Invariant | Violación |
|---|---|
| Toda transacción y asiento pertenece a exactamente una `Company` | Cross-company leak |
| Un usuario sin `CompanyMember` no puede acceder a datos de una compañía | Authorization bypass |
