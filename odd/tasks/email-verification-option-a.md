# Opcione A — Confirmación automática de email (S7 + primer super_admin)
Branch: feat/bootstrap-first-user-superadmin (continuación, sin cambio de rama autorizado)
Test runner: vitest; riesgo: auth (T3/T4)
Estado: implementada y commiteada (2026-10-21). T1-T5 con evidencia de commit; T6 con fixtures S7 verificadas.

## Specs
S1 (autorización usuario, log L1): "siempre todas las confirmaciones deben ser con la opcion A".
S2 (autoridad de jerarquía, log L2): "solo el primero es super usuario el resto son usuarios comunes salvo que el super usuario le cambie la gerarquia".
S3 (técnico T2-T7): registro `PENDING` (`emailVerifiedAt == null`) → `IdentityService.beginRegistration` envía código 6 dígitos (5 intentos, 10 min, 3 reenvíos) → `POST /api/auth/verify` confirma → `emailVerifiedAt` actualizado; primer usuario verificado recibe `super_admin`; restantes reciben `user`.

## Tasks
T1: nodemailer + adapter SMTP real (`mail.ts`) — .env SMTP_H/E defaults, no inventar PASS | done | commit 8f197ea (nodemailer + `package.json`), `a84489f` (`src/lib/identity/mail.ts` con adapter SMTP real, `src/lib/identity/runtime.ts` con `createIdentityService`).
T2: `.env` SMTP defaults (host=smtp.gmail.com, port=587, secure=false) | done | `.env` es local y no se versiona; los defaults documentados quedaron en `.env.example`. El `.env` local de este entorno no expone claves `SMTP_*`/`IDENTITY_*` activas: el servicio de identidad queda dormido y el registro sigue creando la cuenta en `PENDING` sin bloquear el alta (comportamiento documentado en `a84489f`).
T3: `register/route.ts` → `IdentityService.beginRegistration` tras crear usuario | done | commit `a84489f` (`src/app/api/auth/register/route.ts`: `identity.beginRegistration(...)` tras `AuthService.register`, con fallo de entrega no bloqueante y respuesta `requiresVerification`).
T4: `POST /api/auth/verify/route.ts` → `verifyCode` → `emailVerifiedAt = NOW()` + primer-user super_admin | done | commit `a84489f` (`src/app/api/auth/verify/route.ts` + `src/app/api/auth/resend-verification/route.ts`); bootstrap del primer usuario en `src/lib/identity/bootstrap.ts`.
T5: `RegisterPage.tsx`: paso de código (post-register UI mínimo) | done | commit `a84489f` (`src/components/spa/RegisterPage.tsx`, +93 líneas: paso de código post-registro).
T6: `tests/identity/s7-acceptance.integration.test.ts`: actualizar caso S7 con flujo real (opcional) | done | `tests/identity/s7-acceptance.integration.test.ts` commiteado; fixtures S7 verificadas 7/7 contra PostgreSQL descartable y repeatable (commits `6709449` "sync verified S7h fixtures (7/7)" y `7819e30`/`a174a16`). Correcciones acotadas registradas en `odd/tasks/identidad-recuperacion-fase-b.md` (L9).

## Log
L1: 2026-10-20 — usuario autoriza "opción A" y primero=super_admin (verbatim).
L2: 2026-10-20 — DB reseteada limpia (0 users, schema aplicado); guard T3 intacto; guard DELETE corregido.
L3: 2026-10-21 — Implementación real commiteada (el documento había quedado con el checklist sin cerrar). Evidencia por commit: `8f197ea` "feat(identity): add nodemailer dependency for real SMTP delivery" (nodemailer + `package.json`); `a84489f` "feat(identity): Option A email verification — beginRegistration, code verify, resend, real SMTP adapter" (`src/lib/identity/mail.ts`, `src/lib/identity/runtime.ts`, `src/app/api/auth/register/route.ts`, `src/app/api/auth/verify/route.ts`, `src/app/api/auth/resend-verification/route.ts`, `src/components/spa/RegisterPage.tsx`).
L4: 2026-10-21 — Verificación de existencia en `HEAD` (`git ls-tree`/`git cat-file`) de las piezas T2-T7: `mail.ts`, `register/route.ts`, `verify/route.ts`, `bootstrap.ts`, `crypto.ts` (`hashToken`), `repository.ts`, migración `20261019000300_identity_bootstrap` (`legacyUser`) y `tests/identity/s7-acceptance.integration.test.ts` — todas presentes y commiteadas. La implementación de Fase B (T2-T7) no estaba pendiente: el documento `identidad-recuperacion-fase-b.md` conserva un checklist sin actualizar y debe reconciliarse con estos commits.
L5: 2026-10-21 — Corrección de estado: el trabajo de Opción A NO estaba pendiente de implementación. Lo pendiente era (a) cerrar este documento con la evidencia de commits, y (b) reconciliar los checklists de `identidad-recuperacion.md` y `identidad-recuperacion-fase-b.md`, que siguen listando T2-T7 como abiertas pese a estar implementadas y commiteadas.
