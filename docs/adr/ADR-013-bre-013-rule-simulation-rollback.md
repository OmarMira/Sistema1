# ADR-013: Ancla durable de apply y rollback compensatorio (BRE-013)

**Status:** Accepted

---

## Problem and Context

Antes de BRE-013, aplicar reglas (apply-all y single-rule `action=apply`) persistía la
clasificación contable y los asientos generados sin un ancla transaccional durable que
identificara UNA ejecución: no existía un registro que relacionara transacciones y asientos
con el apply que los produjo. Eso hacía imposible una reversión compensada y trazable, y
dejaba la auditoría dependiente solo del log de eventos.

Además, la ejecución concurrente de applies sobre la MISMA fila de `BankTransaction` podía
persistir registros espurios: el motor trataba los IDs candidatos (calculados antes de la
transacción) como si fueran IDs realmente adquiridos. Un perdedor que no adquiría NINGUNA
fila (el ganador ya las había reclamado vía la actualización filtrada por elegibilidad)
creaba igualmente un `RuleApplyRecord` vacío y repuntaba el `ruleApplyRecordId` de la fila
disputada hacia su registro vacío.

## Decisiones

### Decisión 1 — `RuleApplyRecord` como ancla durable (1 tabla + FKs)

Todo apply cubierto persiste un `RuleApplyRecord` dentro de la MISMA transacción atómica
que ya realiza la clasificación y el journaling. El modelo es de UNA tabla con FKs
nullable: `BankTransaction` y `JournalEntry` apuntan al registro activo. El re-apply
sobrescribe los FKs; la trazabilidad histórica se conserva en `AuditLog` (RULE_APPLIED /
RULE_REVERTED). Un registro classification-only (`single-rule`) existe sin asientos.

### Decisión 2 — Rollback por void, no hard-delete

La reversión NUNCA borra asientos ni transacciones: void de journals, recálculo de balances
de GL y desvinculación de FKs. La transición de estado es unidireccional `applied →
reverted` con CAS atómico; el transactor perdedor aborta. No existe `reversalOfId`, no hay
rollback-of-rollback: el re-apply es un registro nuevo.

### Decisión 3 — La adquisición de filas es la única fuente de verdad (apply-vs-apply)

El apply reclama filas de forma atómica y considera adquiridas SOLO las que la actualización
retorna. El registro durable y el link `ruleApplyRecordId` se crean únicamente después de una
adquisición exitosa de filas. Un perdedor concurrente que no adquiere filas no persiste ningún
registro y no puede repuntar el `ruleApplyRecordId` de otra ejecución. Esta decisión cierra la
carrera apply-vs-apply.

### Decisión 4 — Simulación sin garantía de precisión contable

La simulación es un pronóstico read-only que reutiliza el matcher real con orden canónico
determinista. NO predice asientos ni saldos: no se afirma precisión contable. Escribe cero y
nunca crea un registro.

### Decisión 5 — Guard fiscal por fecha, dentro de la transacción

La validación de período fiscal se ejecuta por fecha de transacción DENTRO de la transacción
de apply y de revert (sin TOCTOU). Si CUALQUIER período está cerrado o bloqueado, toda la
transacción aborta.

### Decisión 6 — Entry point de rollback separado

El rollback se expone en una ruta propia y delegada, separada del CRUD de reglas y del funnel
apply-all. El handler existente de void de journal no se reutiliza porque no desvincula los
links de journal.

---

## Alternativas consideradas

- **Join table para navegación histórica** → no seleccionada para esta implementación: agrega
  complejidad de esquema para una navegación que ningún proceso de negocio requiere hoy. Se
  reevalúa si surge una demanda forense concreta.
- **Row lock (`SELECT ... FOR UPDATE`) para exclusión de revert** → no seleccionado para esta
  implementación: serializa, suma superficie de deadlock y requiere SQL crudo; el CAS al
  finalizar es el árbitro real.
- **Versionado optimista (columna de versión)** → no seleccionado para esta implementación:
  columna extra + lógica de retry sin ventaja sobre el CAS para una transición terminal
  one-shot.
- **Recomputar elegibilidad dentro de la transacción y gatear por candidatos** → no seleccionado:
  el recomputo es una segunda lectura que deriva de la adquisición atómica; el registro vacío del
  perdedor sigue siendo posible.
- **Reutilizar el handler de void de journal existente para el rollback** → no seleccionado: no
  desvincula los links de journal.

---

## Consecuencias

- El apply es trazable por `idempotencyKey` y produce un ancla durable para auditoría y reversión.
- La concurrencia apply-vs-apply queda cerrada: exactamente UN registro legítimo por fila
  disputada; el perdedor no persiste nada.
- La reversión es compensatoria, nunca destructiva, y atómica (all-or-nothing).
- La simulación coexiste con la ruta legacy de simulación de condiciones sin reemplazarla.
- El cambio es aditivo (nuevo modelo + rutas + servicios); revertir equivale a quitar la
  migración/modelo y las rutas nuevas.
