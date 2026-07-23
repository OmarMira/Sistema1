# Auditoría de Integridad Transaccional — S7-12

**Estado:** COMPLETADA
**Fecha:** 2026-07-22
**Tipo:** Auditoría de riesgo operacional sobre procesos contables
**Alcance:** 5 endpoints que modifican datos contables
**Auditor:** Automatizado con verificación física de código (file + line)

---

## 1. Resumen Ejecutivo

Se auditaron 5 procesos del sistema que realizan escrituras contables. Tres de ellos presentan riesgo **CRÍTICO** por ausencia de `$transaction`, falta de control de período cerrado, y inexistencia de recálculo de balances. Un cuarto presenta riesgo **ALTO** con el audit log fuera de la transacción. El quinto (cierre de ejercicio) está correctamente implementado y su riesgo es **MEDIO** únicamente por falta de cobertura de test en la ruta HTTP.

**Hallazgos por severidad:**

| Severidad | Cantidad | Procesos |
|-----------|:--------:|----------|
| CRÍTICO | 3 | PATCH transacción, Post/Void asiento, Apply individual |
| ALTO | 1 | Auto-reconciliación |
| MEDIO | 1 | Cierre de ejercicio (engine correcto, falta test de ruta) |

**Patrón común en los 3 críticos:** escrituras contables sin límites transaccionales suficientes, sin `assertActiveFiscalPeriod`, y con cobertura de tests inexistente.

---

## 2. Metodología

Cada hallazgo fue verificado contra el código fuente en el momento de la auditoría:

1. **Identificación**: se inventariaron todos los endpoints que modifican datos contables.
2. **Selección**: se priorizaron los 5 de mayor riesgo potencial por tipo de escritura.
3. **Verificación física**: se inspeccionó cada archivo buscando: `$transaction`, `assertActiveFiscalPeriod`, audit log, recálculo de balances, y cobertura de tests.
4. **Clasificación**: riesgo confirmado con impacto contable documentado.
5. **Recomendación**: cambio mínimo necesario para mitigar, con archivos afectados y límites de refactor.

---

## 3. Hallazgos Detallados

### H1 — PATCH /api/transactions/[id]

**Riesgo inicial:** 🔴 CRÍTICO

**Evidencia física:**

- `src/app/api/transactions/[id]/route.ts:55-59` — El unlink de `journalEntryId` a `null` se ejecuta **fuera** de `$transaction`:
  ```typescript
  if (transaction.journalEntryId) {
    await db.bankTransaction.update({       // ← fuera de $transaction
      where: { id },
      data: { journalEntryId: null },
    });
  }
  ```
- `route.ts:64-95` — El `$transaction` existe pero solo cubre el update + creación del JE nuevo. El unlink previo queda huérfano.
- No hay llamada a `assertActiveFiscalPeriod` en ningún punto del handler.
- No hay audit log.
- No existen tests para este endpoint (0 tests encontrados).

**Riesgo confirmado:** 🔴 CRÍTICO

**Impacto contable:**
- Si el proceso falla entre L55-59 y el `$transaction` (L64), la transacción queda sin `journalEntryId` y el JE viejo queda huérfano (apunta a una transacción que ya no lo referencia).
- En período cerrado se puede reclasificar una transacción (cambiar `glAccountId`) porque no hay `assertActiveFiscalPeriod`.
- No hay trazabilidad de quién cambió qué y cuándo.

**Cambio mínimo recomendado:**
1. Mover el unlink (`journalEntryId = null`) **adentro** del `$transaction` existente.
2. Agregar `assertActiveFiscalPeriod(companyId, transaction.date)` antes de cualquier escritura.
3. Agregar audit log dentro del `$transaction`.
4. Agregar tests unitarios e integración.

**Archivos afectados:**
- `src/app/api/transactions/[id]/route.ts`

**Qué no debe tocarse:**
- La lógica de clasificación contable (cálculo de `bankGlAccountId`, selección de `counterpartyGlAccountId`).
- La estructura del `JournalEntryService.createFromBankTransaction`.
- El contrato HTTP de la respuesta.

---

### H2 — POST /api/journal/[id] (post / void)

**Riesgo inicial:** 🔴 CRÍTICO

**Evidencia física:**

- `src/app/api/journal/[id]/route.ts:200-297` — El handler `POST` para acciones `post` y `void` **no usa `$transaction`** en ningún momento:
  ```typescript
  // L228-251: action === 'post'
  const updated = await db.journalEntry.update({
    where: { id },
    data: { status: 'posted' },    // ← fuera de $transaction
    // ...
  });

  // L261-292: action === 'void'
  const updated = await db.journalEntry.update({
    where: { id },
    data: { status: 'void' },      // ← fuera de $transaction
    // ...
  });
  ```
- No hay llamada a `assertActiveFiscalPeriod`.
- No hay recálculo de `GlAccount.balance` después del cambio de estado (`recalculateBalance` no se invoca).
- No hay audit log.
- No existen tests para este endpoint.

**Riesgo confirmado:** 🔴 CRÍTICO

**Impacto contable:**
- El cambio de estado (`draft → posted` o `posted → void`) es **irreversible** y corre sin protección transaccional. Si el proceso se interrumpe después del `update`, el asiento queda en el nuevo estado sin que ninguna otra operación atómica lo respalde.
- En período cerrado se puede postear o anular un asiento porque no hay `assertActiveFiscalPeriod`.
- `GlAccount.balance` no se actualiza. Un asiento `posted` no impacta el balance del mayor, y un `void` no lo restaura.
- Sin audit log no hay trazabilidad de quién posteó o anuló.

**Cambio mínimo recomendado:**
1. Envolver cada acción (`post`, `void`) en `db.$transaction`.
2. Agregar `assertActiveFiscalPeriod(companyId, entry.date)` antes de modificar el estado.
3. Agregar recálculo de `GlAccount.balance` para todas las líneas del asiento (`recalculateBalance`).
4. Agregar `createAuditLogWithRetry` dentro del `$transaction`.
5. Agregar tests unitarios e integración.

**Archivos afectados:**
- `src/app/api/journal/[id]/route.ts`

**Qué no debe tocarse:**
- Las validaciones de estado (solo `draft → posted`, solo `posted → void`).
- La lógica `GET` y `PUT` (update de draft).
- El modelo `JournalEntry` (status enum, lines).

---

### H3 — POST /api/bank-rules/[id] (apply individual)

**Riesgo inicial:** 🔴 CRÍTICO

**Evidencia física:**

- `src/app/api/bank-rules/[id]/route.ts:373-483` — El handler `POST` con `action=apply`:
  - **No usa `$transaction`**. Las dos llamadas a `updateMany` (L444-449, L454-459) corren secuencialmente sin protección:
    ```typescript
    const result = await db.bankTransaction.updateMany({
      where: eligibleForClassificationWhere({ id: { in: debitIds } }),
      data: { glAccountId: debitAccountId, matchedRuleId: rule.id },
    });
    // ... separación, no hay $transaction
    const result = await db.bankTransaction.updateMany({
      where: eligibleForClassificationWhere({ id: { in: creditIds } }),
      data: { glAccountId: creditAccountId, matchedRuleId: rule.id },
    });
    ```
  - El audit log (L469-476) corre **después** de las escrituras, fuera de cualquier transacción:
    ```typescript
    await createAuditLogWithRetry({...});  // ← fuera de $transaction, después de writes
    ```
  - No hay `assertActiveFiscalPeriod`.
  - No hay tests para este endpoint.
  - La lógica duplica parcialmente el engine de `apply-all`.

**Riesgo confirmado:** 🔴 CRÍTICO

**Impacto contable:**
- Si el primer `updateMany` (debits) succeede y el segundo (credits) falla, las transacciones débito quedan clasificadas pero las de crédito no. No hay rollback.
- Si la escritura succeede pero el audit log falla, el usuario ve un error 500 pero los datos ya se modificaron. No hay trazabilidad.
- En período cerrado se pueden clasificar transacciones nuevas contra una regla.
- Al no delegar en `apply-all-engine`, la lógica de enforcement (S7-11) no se aplica. Un apply individual puede omitir blocking/warnings.

**Cambio mínimo recomendado:**
1. Opción A (recomendada): Delegar en el mismo engine que usa `apply-all`, que ya tiene enforcement, `$transaction`, y audit log.
2. Opción B (mínima): Envolver los dos `updateMany` + audit log en `db.$transaction` y agregar `assertActiveFiscalPeriod`.
3. Agregar tests.

**Archivos afectados:**
- `src/app/api/bank-rules/[id]/route.ts` (handler POST action=apply)

**Qué no debe tocarse:**
- La lógica de matching (`transactionMatchesRule`, `loadEntityFirstContext`, `eligibleForClassificationWhere`).
- Los handlers GET, PUT, DELETE del mismo archivo.
- El engine de `apply-all` (ya está auditado y cubierto).

---

### H4 — POST /api/reconciliation/auto (auto-reconciliación)

**Riesgo inicial:** 🔴 ALTO

**Evidencia física:**

- `src/app/api/reconciliation/auto/route.ts:51-270` — Existe `$transaction` que cubre toda la lógica de matching + reconciliación + creación de JEs.
- `route.ts:287-303` — El audit log **queda fuera** del `$transaction`:
  ```typescript
  // }); ← cierra $transaction en L270
  // ...
  // L288:
  await db.auditLog.create({    // ← FUERA de $transaction
    data: { companyId, userId, action: 'auto_reconcile', ... },
  });
  ```
- `route.ts:233-248` — `journalEntry.create` dentro de `$transaction` siempre crea JEs con `status: 'posted'`.
- No se llama a `recalculateBalance` después de crear JEs ni de reconciliar transacciones.
- `GlAccount.balance` nunca se actualiza (el balance de la cuenta contable asociada al banco queda stale).
- No existen tests de integración para la lógica real de reconciliación.
- Existe `recalculateBankAccountBalance` en `src/lib/reconciliation.ts` pero **no tiene ningún caller** en todo el código base.

**Riesgo confirmado:** 🔴 ALTO

**Impacto contable:**
- Si el `$transaction` succeede pero el audit log falla (L288-303), la API responde con 500 pero las transacciones ya están reconciliadas y los JEs creados. No hay trazabilidad del evento.
- `GlAccount.balance` queda desactualizado. El mayor general no refleja los movimientos de la auto-reconciliación después de creados los JEs.
- `recalculateBankAccountBalance` es código muerto que nadie llama.
- `assertActiveFiscalPeriod` se llama por transacción (L206) pero recibe un `tx` tipado incorrectamente (`tx as any`).

**Cambio mínimo recomendado:**
1. Mover `db.auditLog.create` **adentro** del `$transaction`.
2. Agregar `recalculateBalance` para cada JE creado (usando `JournalEntryService.recalculateBalance` como ya se hace en `journal-entry.service.ts:65-66`).
3. Agregar test de integración que verifique: transacciones reconciliadas, JEs creados, audit log creado, balance actualizado.
4. Evaluar si `recalculateBankAccountBalance` debe llamarse o eliminarse.
   - **Decisión:** se difiere. `recalculateBankAccountBalance` queda como deuda técnica independiente (no forma parte del cierre de H4).

**Archivos afectados:**
- `src/app/api/reconciliation/auto/route.ts`
- `src/lib/reconciliation.ts` (decisión: eliminar o integrar)

**Qué no debe tocarse:**
- La lógica de matching por reglas y por importe (Steps 1 y 2 dentro del `$transaction`).
- El flujo de creación de JEs con contrapartida.
- El contrato de respuesta de la API.

---

### H5 — POST /api/fiscal-periods/close (cierre de ejercicio)

**Riesgo inicial:** 🔴 (candidato inicial)

**Evidencia física:**

- `src/app/api/fiscal-periods/close/route.ts:1-28` — Ruta thin que delega en `executeYearClose`. No tiene lógica propia de escritura.
- `src/lib/services/closing-engine.ts:72-99` — `executeYearClose` usa `$transaction` correctamente:
  ```typescript
  return await db.$transaction(async (tx) => {
    const entry = await tx.journalEntry.create({...});   // L73-82
    await createAuditLogWithRetry({...}, tx as any);     // L83-93 ← audit log DENTRO
    await tx.fiscalPeriod.updateMany({...});             // L94-97
    return { success: true, entryId: entry.id };
  });
  ```
- Audit log creado dentro de la transacción usando `tx as any` (L92).
- Existen 8 tests unitarios del engine.
- El asiento de cierre valida balance cuadrado antes de crear (L65-70).

**Único faltante:**
- ~~No existe test de integración que ejercite la ruta HTTP completa (route + engine + DB real).~~ ✅ Agregado en tests/api/fiscal-periods-close.test.ts (2 tests).
- El `assertActiveFiscalPeriod` no aplica aquí porque el cierre bloquea períodos, no opera dentro de uno abierto.

**Riesgo confirmado:** 🟡 MEDIO → ✅ Eliminado

**Impacto contable:**
- El engine está correctamente protegido. El riesgo es únicamente de cobertura: un cambio futuro en el route podría romper el contrato sin que los tests lo detecten.

**Cambio mínimo recomendado:**
- Agregar test de integración de la ruta HTTP (POST /api/fiscal-periods/close).
- No requiere cambios en el engine.

**Archivos afectados:**
- Solo tests nuevos (no modificar engine ni route).

**Qué no debe tocarse:**
- `src/lib/services/closing-engine.ts` — el engine es correcto y está cubierto.
- `src/app/api/fiscal-periods/close/route.ts` — la ruta es correcta.
- La lógica de cálculo de asiento de cierre.

---

## 4. Tabla Consolidada de Hallazgos

| ID | Proceso | Líneas críticas | Sin $tx | Sin period lock | Sin audit log | Sin balance recalc | Sin tests | Riesgo |
|:--:|---------|:---------------:|:-------:|:---------------:|:-------------:|:------------------:|:---------:|:------:|
| H1 | PATCH /api/transactions/[id] | 55-59 | Parcial | ✅ | ✅ | N/A | ✅ | 🔴 CRÍTICO |
| H2 | POST /api/journal/[id] (post/void) | 228-292 | ✅ | ✅ | ✅ | ✅ | ✅ | 🔴 CRÍTICO |
| H3 | POST /api/bank-rules/[id] (apply) | 443-476 | ❌ | ❌ | ❌ | N/A | ❌ | 🔴 CRÍTICO → ✅ |
| H4 | POST /api/reconciliation/auto | 288-303 → dentro | ❌ | ❌ | ❌ (dentro) | ❌ | ❌ | 🔴 ALTO → ✅ |
| H5 | POST /api/fiscal-periods/close | — | ❌ | ❌ (no aplica) | ❌ (dentro) | ❌ (no aplica) | ❌ | 🟡 MEDIO → ✅ |

## 5. Priorización para S7-13

### Bloque 1 — Integridad transaccional crítica (S7-13)

| Orden | Hallazgo | Proceso | Justificación |
|:-----:|:--------:|---------|--------------|
| 1 | H1 | PATCH transacción | Unlink fuera de $transaction + sin period lock. Puede producir datos huérfanos. |
| 2 | H2 | Post/Void asiento | Sin $transaction + sin period lock + sin recalcular balance. El más riesgoso por impacto contable inmediato. |
| 3 | H3 | Apply individual | ✅ Resuelto en Sprint 13.3 |
| 4 | H4 | Auto-reconciliación | ✅ Resuelto en Sprint 13.4 |

### Excluido de S7-13

| Hallazgo | Proceso | Motivo |
|:--------:|---------|--------|
| H5 | Cierre de ejercicio | ✅ Resuelto — test de integración HTTP agregado. Engine no requirió cambios. |

---

## 6. Principios Rectores para S7-13

1. **Los routes no tienen lógica de negocio.** Todo cambio debe preservar la separación: route = JSON mapping, service = lógica transaccional.
2. **No extraer abstracciones prematuramente.** Si un patrón se repite en 2+ procesos, recién ahí considerar extracción.
3. **El enforcement de S7-11 es el estándar.** Todo endpoint que modifique contabilidad debe tener `buildEnforcementResult` o su equivalente.
4. **`assertActiveFiscalPeriod` es obligatorio** en cualquier escritura contable.
5. **`$transaction` debe cubrir TODAS las escrituras**, incluyendo audit log.
6. **`recalculateBalance` debe llamarse** después de crear/modificar JEs que afecten cuentas del mayor.
7. **Todo cambio de S7-13 debe indicar explícitamente qué hallazgo (H1-H5) elimina.** Si el cambio no elimina total o parcialmente un hallazgo documentado, no forma parte de S7-13 y debe rechazarse. Queda prohibido: renombrar, mover archivos, crear servicios nuevos, cambiar contratos HTTP, o "modernizar" código sin un hallazgo asociado. La revisión al final del sprint evalúa exclusivamente riesgos eliminados, no cantidad de código escrito.
8. **Al terminar cada sub-sprint (13.1-13.4), el hallazgo correspondiente debe cambiar explícitamente de estado.** Estados posibles: `Confirmado` → `Mitigado` → `Eliminado` | `Requiere rediseño`. Si un hallazgo no puede eliminarse completamente, debe reflejar su estado real. No se permite dejar hallazgos en el limbo.
9. **Un hallazgo marcado como "Eliminado" no puede volver a "Confirmado" sin evidencia nueva.** La evidencia debe provenir de una auditoría, un bug reproducible o un test que demuestre una regresión. No se reabren hallazgos por corazonadas o discusiones sin sustento.

### Seguimiento de estados

| Hallazgo | Estado inicial | Sprint 13.1 | Sprint 13.2 | Sprint 13.3 | Sprint 13.4 |
|:--------:|:--------------:|:-----------:|:-----------:|:-----------:|:-----------:|
| H1 | Confirmado | | | | |
| H2 | Confirmado | | | | |
| H3 | Confirmado | | | ✅ Eliminado | |
| H4 | Confirmado | | | | ✅ Eliminado |
| H5 | Confirmado (fuera de S7-13) | — | — | — | ✅ Eliminado |

---

## 7. Firmas Técnicas

| Elemento | Valor |
|----------|-------|
| Hash del código auditado | Cabeza de `main` al 2026-07-22 |
| Commits incluidos | Hasta S7-11 inclusive |
| Próxima revisión sugerida | Al completar S7-13 |
| Reproduce | `git checkout main && npx tsc --noEmit` (clean) + `npm run test` (580 passing) |
