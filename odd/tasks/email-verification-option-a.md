# Opcione A — Confirmación automática de email (S7 + primer super_admin)
Branch: feat/bootstrap-first-user-superadmin (continuación, sin cambio de rama autorizado)
Test runner: vitest; riesgo: auth (T3/T4)
Estado: T1-T6 conservan su evidencia histórica; reparación T7-T8 verificada, cierre T9 en curso. Baseline: 68ce49d. Delivery: ask-on-risk; reparación estimada <400 líneas autoradas.

## Specs
S1 (autorización usuario, log L1): "siempre todas las confirmaciones deben ser con la opcion A".
S2 (autoridad de jerarquía, log L2): "solo el primero es super usuario el resto son usuarios comunes salvo que el super usuario le cambie la gerarquia".
S3 (técnico T2-T7): registro `PENDING` (`emailVerifiedAt == null`) → `IdentityService.beginRegistration` envía código 6 dígitos (5 intentos, 10 min, 3 reenvíos) → `POST /api/auth/verify` confirma → `emailVerifiedAt` actualizado; primer usuario verificado recibe `super_admin`; restantes reciben `user`.

S4 (reporte actual): "algo tocaste que ahora no envia el mensaje y ademas fijate que el texto esta en ingles".
S5 (restauración autorizada): "quiero que eso funcione como corresponde funcionaba ayer cuando lo hicimos".

## Tasks
T1: nodemailer + adapter SMTP real (`mail.ts`) — .env SMTP_H/E defaults, no inventar PASS | done | commit 8f197ea (nodemailer + `package.json`), `a84489f` (`src/lib/identity/mail.ts` con adapter SMTP real, `src/lib/identity/runtime.ts` con `createIdentityService`).
T2: `.env` SMTP defaults (host=smtp.gmail.com, port=587, secure=false) | done | `.env` es local y no se versiona; los defaults documentados quedaron en `.env.example`. El `.env` local de este entorno no expone claves `SMTP_*`/`IDENTITY_*` activas: el servicio de identidad queda dormido y el registro sigue creando la cuenta en `PENDING` sin bloquear el alta (comportamiento documentado en `a84489f`).
T3: `register/route.ts` → `IdentityService.beginRegistration` tras crear usuario | done | commit `a84489f` (`src/app/api/auth/register/route.ts`: `identity.beginRegistration(...)` tras `AuthService.register`, con fallo de entrega no bloqueante y respuesta `requiresVerification`).
T4: `POST /api/auth/verify/route.ts` → `verifyCode` → `emailVerifiedAt = NOW()` + primer-user super_admin | done | commit `a84489f` (`src/app/api/auth/verify/route.ts` + `src/app/api/auth/resend-verification/route.ts`); bootstrap del primer usuario en `src/lib/identity/bootstrap.ts`.
T5: `RegisterPage.tsx`: paso de código (post-register UI mínimo) | done | commit `a84489f` (`src/components/spa/RegisterPage.tsx`, +93 líneas: paso de código post-registro).
T6: `tests/identity/s7-acceptance.integration.test.ts`: actualizar caso S7 con flujo real (opcional) | done | `tests/identity/s7-acceptance.integration.test.ts` commiteado; fixtures S7 verificadas 7/7 contra PostgreSQL descartable y repeatable (commits `6709449` "sync verified S7h fixtures (7/7)" y `7819e30`/`a174a16`). Correcciones acotadas registradas en `odd/tasks/identidad-recuperacion-fase-b.md` (L9).

T7 [S3-S5]: reparar el paso registro → verificación y los textos visibles, con regresiones RED/GREEN | delegated (failed) → inline recovery | done: GREEN17/17, unit19/19, diferencial42, typecheck0 | commit pendiente; Risk: item 2 (proxy de autenticación).
T8 [S3-S5]: verificación independiente de la reparación y compatibilidad de rutas protegidas | delegated, security verification | done | scratch backend14/14 + UI3/3; workspace17/17 y unit19/19; sin SMTP/DB operativa.
T9 [S4-S5]: cerrar la unidad local con evidencia y revisión nativa según assess | inline, parent owns Git | in_progress | commit local y evaluación nativa; sin push/PR/merge.

## Log
L1: 2026-10-20 — usuario autoriza "opción A" y primero=super_admin (verbatim).
L2: 2026-10-20 — DB reseteada limpia (0 users, schema aplicado); guard T3 intacto; guard DELETE corregido.
L3: 2026-10-21 — Implementación real commiteada (el documento había quedado con el checklist sin cerrar). Evidencia por commit: `8f197ea` "feat(identity): add nodemailer dependency for real SMTP delivery" (nodemailer + `package.json`); `a84489f` "feat(identity): Option A email verification — beginRegistration, code verify, resend, real SMTP adapter" (`src/lib/identity/mail.ts`, `src/lib/identity/runtime.ts`, `src/app/api/auth/register/route.ts`, `src/app/api/auth/verify/route.ts`, `src/app/api/auth/resend-verification/route.ts`, `src/components/spa/RegisterPage.tsx`).
L4: 2026-10-21 — Verificación de existencia en `HEAD` (`git ls-tree`/`git cat-file`) de las piezas T2-T7: `mail.ts`, `register/route.ts`, `verify/route.ts`, `bootstrap.ts`, `crypto.ts` (`hashToken`), `repository.ts`, migración `20261019000300_identity_bootstrap` (`legacyUser`) y `tests/identity/s7-acceptance.integration.test.ts` — todas presentes y commiteadas. La implementación de Fase B (T2-T7) no estaba pendiente: el documento `identidad-recuperacion-fase-b.md` conserva un checklist sin actualizar y debe reconciliarse con estos commits.
L5: 2026-10-21 — Corrección de estado: el trabajo de Opción A NO estaba pendiente de implementación. Lo pendiente era (a) cerrar este documento con la evidencia de commits, y (b) reconciliar los checklists de `identidad-recuperacion.md` y `identidad-recuperacion-fase-b.md`, que siguen listando T2-T7 como abiertas pese a estar implementadas y commiteadas.

L6: 2026-10-21 — Reporte del usuario (verbatim): "C:\Users\PC Omar\AppData\Local\Packages\MicrosoftWindows.Client.Core_cw5n1h2txyewy\TempState\ScreenClip\{47A51F1E-6FC1-40A4-B377-4E77160C4C70}.png algo tocaste que ahora no envia el mensaje y ademas fijate que el texto esta en ingles". Captura: POST /api/auth/verify 401; banner Unauthorized; clave register.optional visible. No demuestra fallo SMTP por sí sola.
L7: 2026-10-21 — Autorización del usuario (verbatim): "quiero que eso funcione como corresponde funcionaba ayer cuando lo hicimos". Mantener la Opción A, guard T3, CSRF y permisos existentes; no modificar usuarios, DB ni credenciales. La ausencia de SMTP/IDENTITY en T2 es evidencia histórica, NO estado actual: memoria posterior registra activación, pendiente corroboración sanitizada de presencia local.
L8: 2026-10-21 — Mapa y plan: proxy exige sesión antes de la ruta verify diseñada allowAnonymous; traducción register.optional ausente. Worker por backstop de contexto (lectura+implementación+checks juntos); no escritores paralelos. Solo pruebas con mocks, sin hooks globales que ejecutan db push/seed. Comandos autorizados: node node_modules/vitest/vitest.mjs run --config vitest.registration-verification.config.ts; node node_modules/vitest/vitest.mjs run --config vitest.identity-unit.config.ts; node node_modules/typescript/bin/tsc --noEmit --incremental false. No enviar correo real ni probar códigos de la captura.

L9: Escritor mvisrtqi-3-svd8 terminó sin informe; dejó cambios parciales sin tests. Padre retiró exclusivamente esos cambios propios para recuperar baseline de comportamiento y preparar RED; git diff confirma código de aplicación idéntico a HEAD. Nuevos tests/config aislados creados, no hooks DB.
L10: `node node_modules/vitest/vitest.mjs run --config vitest.registration-verification.config.ts` inició RUN v4.1.12 pero excedió timeout de 30s sin resultados; check FALLIDO por timeout, no RED/GREEN válido. No se reintentó ni se migró a background. Pendiente autorización humana para una segunda corrida acotada. Presencia local sanitizada: IDENTITY_INFRASTRUCTURE_ENABLED=true y HMAC/SMTP_HOST/PORT/USER/PASS/FROM presentes; sin uso de credenciales ni conexión.

L11: Usuario seleccionó explícitamente "Sí, ejecutar con límite de 3 minutos" (authorize_second_isolated_test_run). Autoriza segunda corrida aislada en background, límite 180s; sin DB/SMTP/instalaciones. No autoriza reintentos posteriores si vuelve a fallar por timeout.

L12: Segunda corrida autorizada terminó en35s, exit1: RED legítimo de proxy (verify/resend401) y metadatos de entrega; UI no probada por ResizeObserver faltante. Soporte DOM corregido; RED UI exit1 (2fallan/1pasa). Reparación mínima aplicada. GREEN focal exit0 (17/17); identidad-units exit0 (19/19); comparación diferencial de42 peticiones existentes conserva status/headers/body exactos compilando base/actual en memoria, sin scratch. Typecheck job8 pendiente. Cambios parciales del escritor fueron reemplazados por implementación inline; no evidencia inventada de su ejecución.

L13: Typecheck `node node_modules/typescript/bin/tsc --noEmit --incremental false` exit0 (29s). T7 completada con pruebas observadas; T8 inicia verificación independiente. T1-T6 permanecen históricas y no se reabren sin motivo.

L14: Usuario autorizó "Sí, verificar en esa copia temporal" (authorize_registration_verification_scratch), exclusivamente C:/Users/PC Omar/AppData/Local/Temp/sistema1-registration-verify-01a1602d, sin .env/credenciales/DB/SMTP/instalación. Verificador independiente mvitd3fx-4-ktqg en curso; src y datos operativos no se modifican durante la verificación.

L15: Chequeo adicional ESLint focal superó timeout30s sin veredicto; no se reintentó ni se relanzó en background. Pruebas funcionales/tipos ya observadas siguen vigentes, pero no equivalen a lint aprobado. T8 continúa en ejecución independiente; T9 no está completada ni hay commit/cierre. Proyección todo reconciliada con este estado.

L16: Verificador mvitd3fx-4-ktqg informó cero defectos de código; independiente workspace focal17/17 y units19/19; scratch proxy/mail14/14 pero UI falló por resolución de dependencias en la copia. No declarar ese chequeo aprobado. Usuario seleccionó "Completar los dos chequeos faltantes" (complete_remaining_bounded_checks): autoriza una corrección del montaje scratch y segunda ejecución de ESLint, límite3min por chequeo, sin cambios a aplicación/DB/SMTP. T8 continúa hasta observar el resultado acotado; no repetir barridos completos.

L17: Segunda ejecución autorizada ESLint terminó exit0 en76s, 0errores; tres warnings porque la política existente ignora tests/identity/registration-{mail,proxy,ui}.test.ts[x]. No se cambió la política ni se fuerza lint de archivos ignorados. Spot-check requerido del padre: suite focal17/17 exit0 (4.62s). Pendiente exclusivamente recheck UI scratch mvitnshk-5-jwws antes de cerrar T8.

L18: Recheck independiente mvitnshk-5-jwws completó UI scratch3/3 exit0 en8.75s tras una corrección solo del montaje de dependencias dentro de la copia autorizada. Sin cambios al original ni instalación/SMTP/DB. Evidencia independiente completa: proxy/mail14/14 + UI3/3 en scratch, suite17/17 y units19/19 en workspace; cero bloqueadores de código. T8 cerrada, T9 inicia unidad local. T7 y T8 se incluirán en el mismo commit de reparación; identidad/SMTP reales permanecen fuera de las pruebas autorizadas.
