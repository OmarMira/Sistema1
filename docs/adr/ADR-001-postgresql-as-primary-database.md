# ADR-001: PostgreSQL as Primary Database

**Status:** Accepted (2026-07)

**Context:** El proyecto comenzó con SQLite como base de datos. Durante el desarrollo, SQLite se volvió insuficiente para los requerimientos de concurrencia, integridad referencial y características de PostgreSQL (enums, schemas, migraciones).

**Decision:** PostgreSQL es la base de datos primaria y única soportada. SQLite queda como histórico — no debe aparecer como arquitectura vigente.

**Consequences:**

- Prisma usa `provider = "postgresql"` en `schema.prisma`
- Servicio Windows de PostgreSQL (no Docker)
- Dos bases: `accountexpress` (producción/desarrollo) y `accountexpress_test` (tests)
- Toda referencia a SQLite eliminada de la configuración vigente

**Rationale:**

- Enums nativos > strings
- Concurrencia real > simulación
- Migraciones robustas > schema push
- La suite de tests requiere aislamiento de base de datos

**Related:** ADR-002 (Database Isolation)
