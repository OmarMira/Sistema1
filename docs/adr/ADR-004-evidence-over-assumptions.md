# ADR-004: Evidence Over Assumptions

**Status:** Accepted (2026-07)

**Context:** Durante la etapa de estabilización, múltiples problemas fueron inicialmente asumidos como "pre-existentes" o "conocidos". En todos los casos, la investigación con evidencia concreta (archivo + línea) reveló causas diferentes a las asumidas, incluyendo bugs reales no detectados.

**Decision:** Toda decisión técnica debe respaldarse con evidencia verificable, no con inferencia.

**Rules:**

- No afirmar "esto es pre-existente" sin verificar
- No afirmar "esto debe ser la causa" sin investigar
- Toda vulnerabilidad citada debe incluir archivo + línea
- Toda decisión de arquitectura debe referenciar su ADR

**Consequences:**

- Mayor tiempo de investigación inicial
- Menos bugs pasan desapercibidos
- Las discusiones técnicas son más productivas (se discuten datos, no opiniones)

**Examples:**

- Los 157 tests no eran "fallos pre-existentes" — 7% eran bugs reales
- El bug de DB isolation no era "imposible" — era hoisting de ES modules
- El test multicolumna no era "funcionalidad pendiente" — era legacy incorrecto

**Related:** ADR-005 (Legacy Test Policy)
