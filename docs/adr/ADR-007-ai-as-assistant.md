# ADR-007: AI as Assistant

**Status:** Accepted (2026-07)

**Context:** El uso de IA en contabilidad requiere un límite claro: la IA no puede tomar decisiones contables autónomas porque eso introduce riesgos de compliance, auditoría y precisión que el negocio no puede aceptar.

**Decision:** La IA exclusivamente **propone** clasificaciones. Nunca **decide** ni **contabiliza**. Toda propuesta de IA:

- Ocurre solo cuando el motor determinista no encontró evidencia suficiente
- Se registra en `AuditLog` con trazabilidad completa (confianza, modelo, timestamp)
- Requiere aceptación humana o de una regla explícita para generar un asiento contable
- Puede ser sobreescrita por el contador sin restricciones

**Consequences:**

- La IA nunca genera `JournalEntry` directamente
- Toda transacción clasificada por IA queda en estado "pending approval" hasta decisión humana
- El override humano retroalimenta el modelo de aprendizaje
- Sin API key de AI configurada, el sistema funciona completo — solo salta la clasificación probabilística

**Rationale:**

- Compliance contable: un asiento sin aprobación humana no es válido en ninguna jurisdicción
- Auditabilidad: toda decisión contable debe tener un responsable humano
- Predictibilidad: el motor determinista da resultados 100% reproducibles; la IA no

**Related:** ADR-005 (Legacy Test Policy), `docs/architecture/ai-decision-model.md`
