# Opcione A — Confirmación automática de email (S7 + primer super_admin)
Branch: feat/bootstrap-first-user-superadmin (continuación, sin cambio de rama autorizado)
Test runner: vitest; riesgo: auth (T3/T4)

## Specs
S1 (autorización usuario, log L1): "siempre todas las confirmaciones deben ser con la opcion A".
S2 (autoridad de jerarquía, log L2): "solo el primero es super usuario el resto son usuarios comunes salvo que el super usuario le cambie la gerarquia".
S3 (técnico T2-T7): registro `PENDING` (`emailVerifiedAt == null`) → `IdentityService.beginRegistration` envía código 6 dígitos (5 intentos, 10 min, 3 reenvíos) → `POST /api/auth/verify` confirma → `emailVerifiedAt` actualizado; primer usuario verificado recibe `super_admin`; restantes reciben `user`.

## Tasks
T1: nodemailer + adapter SMTP real (`mail.ts`) — .env SMTP_H/E defaults, no inventar PASS
T2: `.env` SMTP defaults (host=smtp.gmail.com, port=587, secure=false)
T3: `register/route.ts` → `IdentityService.beginRegistration` tras crear usuario
T4: `POST /api/auth/verify/route.ts` → `verifyCode` → `emailVerifiedAt = NOW()` + primer-user super_admin
T5: `RegisterPage.tsx`: paso de código (post-register UI mínimo)
T6: `tests/identity/s7-acceptance.integration.test.ts`: actualizar caso S7 con flujo real (opcional)

## Log
L1: 2026-10-20 — usuario autoriza "opción A" y primero=super_admin (verbatim).
L2: 2026-10-20 — DB reseteada limpia (0 users, schema aplicado); guard T3 intacto; guard DELETE corregido.
