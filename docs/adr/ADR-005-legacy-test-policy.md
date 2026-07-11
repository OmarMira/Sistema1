# ADR-005: Legacy Test Policy

**Status:** Accepted (2026-07)

**Context:** Durante Test Health se encontraron tests legacy con `it.skip`. El análisis mostró que mantenerlos "por las dudas" generaba falsa impresión de cobertura pendiente y confusión en auditorías.

**Decision:**

- `it.skip` requiere justificación explícita en el comentario que la precede
- Si un test skip no representa un caso real actual, se elimina en lugar de dejarse como documentación
- La justificación debe especificar por qué se omite y qué tendría que pasar para reactivarlo
- Si la funcionalidad es válida pero postergada, se registra como issue/backlog item, no como skip

**Consequences:**

- La suite siempre muestra 0 skipped cuando no hay funcionalidad pendiente real
- Un skip existente siempre tiene contexto suficiente para decidir si eliminarlo o repararlo
- Se pierde la red de seguridad de tests legacy, pero se gana claridad

**Rationale:**

- `it.skip` no es documentación — es código no ejecutado que da falsa señal de cobertura
- El historial de git preserva el test eliminado si alguien necesita recuperarlo
- La suite debe reflejar el estado actual del sistema, no aspiraciones

**Related:** ADR-004 (Evidence Over Assumptions)
