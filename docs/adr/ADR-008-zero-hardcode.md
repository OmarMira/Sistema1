# ADR-008: Zero Hardcode

**Status:** Accepted (2026-07)

**Context:** El proyecto acumuló múltiples valores hardcodeados que dificultaban el mantenimiento: configuraciones de banco, reglas de importación, perfiles de parsing, textos de UI, y reglas de negocio. Cada cambio requería modificar código y redeployar.

**Decision:** Toda configuración que represente una decisión del negocio debe estar externalizada en archivos JSON en `rules/` o en la base de datos. El código fuente solo contiene lógica, no datos de configuración.

**Consequences:**

- 24 archivos JSON en `rules/` cubriendo: RBAC, cuentas contables, bancos, importación, reports, dashboards, presupuestos, seguridad, IA, etc.
- Cambiar el comportamiento del sistema no requiere modificar código — solo editar JSON o DB
- Las configuraciones son versionables y auditablees via git
- `BankProfile` y `BankRule` viven en DB, no hardcodeadas

**Exceptions:**

- Variables de entorno para secrets (`SESSION_SECRET`, `DATABASE_URL`)
- Config de compilación (Next.js, Tailwind, TypeScript) — esas son decisiones técnicas, no de negocio

**Rationale:**

- Separar código de configuración permite que personal no técnico ajuste reglas de negocio
- Reduce riesgo de bugs por cambios de código
- Facilita auditoría: se puede ver el historial de cambios de configuración independientemente del código

**Related:** ADR-006 (Local First), `rules/` directory
