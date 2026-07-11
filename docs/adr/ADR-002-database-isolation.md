# ADR-002: Test Database Isolation

**Status:** Accepted (2026-07)

**Context:** Los tests estaban escribiendo en la base de producción. Causa raíz: ES module import hoisting impedía que `tests/setup.ts` overrideara `DATABASE_URL` a tiempo — PrismaClient se instanciaba con la URL de producción antes de que el setup se ejecutara.

**Decision:** Doble guardia de aislamiento:

1. **Config-time:** `vitest.config.ts` inyecta `DATABASE_URL` como `define` antes de que cualquier módulo se importe
2. **Runtime:** `src/lib/db.ts` verifica que `DATABASE_URL` contenga `accountexpress_test` y aborta si no coincide

**Consequences:**

- Es imposible que los tests escriban en producción accidentalmente
- Cualquier cambio futuro en la configuración de test debe mantener ambas guardias
- La protección es explícita y verificable (test dedicado)

**Rationale:**

- El bug de hoisting es silencioso y difícil de debuggear
- Una sola guardia puede tener el mismo problema de hoisting
- La doble guardia cubre config-time y runtime

**Related:** ADR-001 (PostgreSQL), `tests/database-isolation.test.ts`
