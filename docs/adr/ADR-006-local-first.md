# ADR-006: Local First

**Status:** Accepted (2026-07)

**Context:** El sistema targeta pequeñas y medianas empresas contables donde la conectividad a internet no es garantizada y la dependencia de cloud agrega complejidad operativa innecesaria.

**Decision:** La operación core del sistema no depende de ningún servicio cloud. La base de datos, el motor de reglas, la clasificación AI (vía API key configurable) y todo el pipeline contable funcionan localmente.

**Consequences:**

- PostgreSQL es local (servicio Windows)
- Sin dependencia de Redis, S3, u otros servicios externos para operación diaria
- La configuración AI requiere API key del usuario, no es un servicio embebido
- Los backups son a filesystem local
- El rate limiting es single-instance

**Limitations:**

- No hay HA ni failover automático
- El rate limiting no escala horizontalmente
- Los backups cloud son una mejora futura (SaaS migration)

**Related:** ADR-001 (PostgreSQL), ADR-008 (Zero Hardcode)
