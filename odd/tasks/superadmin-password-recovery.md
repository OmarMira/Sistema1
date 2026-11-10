# Superadministrator password recovery

Objective: give the installation owner a self-service way back in when the
superadministrator password is lost, without opening a password-reset path for
ordinary users and without revealing which accounts hold that role.

Branch: `feat/superadmin-password-recovery`. Delivery: one small pull request.
Status: specification only; no implementation yet.

## Specs

S1. Scope is the superadministrator only. An ordinary user never receives a reset
link; their path stays "ask your system administrator to set a new password",
which already exists in `src/app/api/admin/users`.

S2. The UI copy must cover both cases without revealing which one applies. User's
own wording, verbatim:

> "Si ese correo corresponde al administrador de la instalación, vas a recibir un
> enlace para restablecer la contraseña. En caso de ser un usuario del sistema le
> debe pedir a su administrador del sistema que le restablezca la contraseña."

Professional revision of that wording, to be used as the exact UI string:

- es: `Si el correo pertenece al administrador de la instalación, recibirás un enlace para restablecer la contraseña. Si tu cuenta es de usuario, solicita a tu administrador que la restablezca.`
- en: `If the address belongs to the installation administrator, you will receive a link to reset the password. If your account is a regular user, ask your administrator to reset it.`

S3. The response is identical for every request: unknown address, ordinary user,
inactive user, unverified address and superadministrator. Same status, same body,
same timing class. Only the delivered email differs.

S4. A token is issued only when the account is an ACTIVE `super_admin` whose email
is verified. Every other case is discarded silently.

S5. The token is single use, stored hashed (never in clear), expires in 60 minutes,
and invalidates any earlier outstanding token for the same user.

S6. Consuming the token and updating `passwordHash` happen in one transaction.
Reusing a consumed, expired or unknown token fails the same generic way.

S7. A successful reset closes every active session of that user.

S8. The new password must satisfy the same policy the registration path enforces.

S9. Every request is audited, including the ones discarded because the account is
not a superadministrator. The token value is never written to the audit row.

S10. No mail transport available: the request must not claim an email was sent.
The endpoint decides this at runtime by calling `createRecoveryMailTransport(process.env)`
(`src/lib/backup-recovery-mail.ts:44`), the same single decision point both restore
routes already use. It returns `null` when nothing is configured, a transport
otherwise. A `null` result is an INSTALLATION property, not a per-account one, so
answering it explicitly reveals nothing about any account: the response says the
installation has no mail delivery and points at the installation recovery path.
If a transport exists but `deliverRecoveryToken` (`:21`) does not return `sent`,
the token must not remain usable and the answer is the same honest one, with the
failure audited.

S11. The reset page never authenticates the user automatically; it returns to the
login form.

## Open decisions

D1. CLOSED. No mail transport: detected at runtime through
`createRecoveryMailTransport(process.env)` (`src/lib/backup-recovery-mail.ts:44`).
`null` means the installation has no channel; the response says so and points at
the installation recovery path. Nothing is read from `.env` directly and the
answer is identical for every address, so it can never identify an account.
Note the relay caveat: `ACCOUNTEXPRESS_MAIL_MODE=relay` returns a transport
without validating `relay.json` (`src/lib/identity/relay-transport.ts:12-26`), so
a send-time failure must follow the same honest branch as `mail_unavailable`.

D2. CLOSED (user, verbatim "2 de acuerdo"). A superadministrator whose email is
unverified cannot use this path. Verifying the address inside the reset flow is
rejected: the requester may not be the owner.

D3. CLOSED (user, verbatim "3 correcto"). Several superadministrators each
recover their own account; the filter is by role, not by "the" owner.

## Reusable pieces (verified)

| Need | Existing piece |
| --- | --- |
| Transport detection | `createRecoveryMailTransport` `src/lib/backup-recovery-mail.ts:44`; outcome vocabulary `sent`/`mail_unavailable`/`delivery_failed` at `:15,:21` |
| Rate limit | `authRateLimiter` `src/lib/rate-limiter.ts:9,145`; `check`/`increment` at `:65,:95`; precedent `src/app/api/auth/resend-verification/route.ts:18-26` |
| Password policy | `registerSchema.password` `src/lib/validations/auth.ts:16` (no shared validator exists; extract one instead of duplicating a third copy) |
| Close sessions | `deleteAllUserSessions(userId, tx?)` `src/lib/sessions.ts:80`; transaction precedent `src/app/api/settings/password/route.ts:52-71` |
| Audit with chain | `createAuditLogWithRetry` `src/lib/audit.ts:79` |
| One-time token pattern | `IdentityChallenge` `prisma/schema.prisma:925-938` (purpose, digest, expiresAt, usedAt, unique subject+purpose); `randomBytes(32).toString('hex')` `src/lib/identity/crypto.ts:11`; `sha256` digest `:15` |
| Route guard | `apiHandler(..., { allowAnonymous })` `src/lib/api-handler.ts:54-58` |
| Client IP | `getClientIp` `src/lib/security/client-ip.ts:24` |

## Surface

| Piece | Change |
| --- | --- |
| `src/components/spa/LoginPage.tsx:125-127` | The dead `button` gets an `onClick` opening the request form |
| Request form | Email field, submit, neutral result, i18n es/en |
| `POST /api/auth/forgot-password` | Rate limited, silent role filter, token issue, mail, audit |
| `GET /api/auth/reset-password/validate` | Non-consuming token check for the form state |
| `POST /api/auth/reset-password` | Policy check, transaction consume + hash update, session close, audit |
| `src/app/(auth)/reset-password` page | New password form with generic failure states |
| Token storage | New table: id, userId, tokenHash, expiresAt, consumedAt, createdAt |

## Security rules

- Never distinguish "exists" from "does not exist", nor "is owner" from "is not".
- Never send a password, temporary or otherwise, by email.
- Constant-time comparison of the token hash.
- Rate limit per normalized email and per IP, stricter than login.
- The mail link contains only the opaque token.
- Discarded attempts are audited with the reason, never with the token.

## Acceptance checks

| Req | Check |
| --- | --- |
| S3 | Same status and body for unknown, ordinary, inactive, unverified and superadmin addresses |
| S4 | Ordinary user request creates no token row and sends no mail |
| S5 | Two requests leave exactly one usable token; the first is invalidated |
| S6 | Replay, expiry and unknown token all answer the same generic error; password unchanged |
| S7 | After reset, an existing session cookie is rejected |
| S8 | A password below policy is refused and no token is consumed |
| S9 | Audit rows exist for discarded requests, without token material |
| S10 | With no transport, response reports no delivery and no token is left usable |
| S11 | Reset does not create a session |

Tests: unit for the role filter and token rules; API suite against disposable
PostgreSQL for the full endpoints; UI test for the neutral message and the form
states. No real mail transport and no operator data in any test.

## Risks

Risk: item 2 (security). Authentication, credentials and a role-gated recovery
path. Requires writer self-verification plus an independent verifier, and every
acceptance row above observed.

Risk: item 3 (contract). New public endpoints and a new stored token table.

## Log

L1. User, verbatim: "lo importante es que esta recuperacion es solo para el
superadministrador porque si un usuario comun lo pierde el super admin le puede
cambiar la contraseña pero si el super admin la pierde no tiene alternativa."

L2. User, verbatim: "«Si ese correo corresponde al administrador de la instalación,
vas a recibir un enlace para restablecer la contraseña. En caso de ser un usuario
del sistema le debe pedir a su administrador del sistema que le restablezca la
contraseña.» se me ocurre, o algo mas profesional deja todo escrito antes de
implementar."

L3. Finding that opened this feature, verbatim request: "decime que hace el boton
de me olvide la contraseña". The button at `src/components/spa/LoginPage.tsx:125-127`
has no `onClick`, and no `forgot-password` or `reset-password` route exists in
`src/app/api/auth/`.

L4. User, verbatim: "para el 1 sin smtp primero tenes que analizar si no hay smtp y
si existe lo manejamos como esta previsto. 2 de acuerdo. 3 correcto."

L5. Analysis result closing D1: mail configuration is environment-only, there is no
DB-stored mail setting, and no endpoint exposes availability. Detection therefore
belongs inside the endpoint via the existing factory, not in a separate diagnostic
and never by reading `.env` from code or tooling.
