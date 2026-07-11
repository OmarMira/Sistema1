# ADR-003: SESSION_SECRET Required in All Environments

**Status:** Accepted (2026-07)

**Context:** `SESSION_SECRET` es la clave maestra AES-256-GCM para cifrar API keys de AI en la base de datos. Originalmente tenía un fallback hardcodeado para desarrollo/test que ocultaba errores de configuración y generaba falsa sensación de seguridad.

**Decision:**

- `SESSION_SECRET` es obligatorio en **todos los entornos** (producción, desarrollo, test)
- Sin fallback hardcodeado de ningún tipo
- Si falta, el sistema falla explícitamente con un mensaje claro
- Los mensajes de error nunca exponen API keys ni ciphertext

**Consequences:**

- Arranque inicial requiere generar y configurar la clave
- Los tests también requieren `SESSION_SECRET` en `.env`
- Mayor seguridad: no hay "modo inseguro" por omisión

**Rationale:**

- Un fallback en desarrollo permite que código inseguro llegue a producción
- La consistencia entre entornos elimina sorpresas en deploy
- Fallar temprano y fuerte es más seguro que fallar silenciosamente

**Related:** `src/lib/security/crypto.ts`, `src/lib/services/ai-config.ts`
