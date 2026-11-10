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

S10. No SMTP transport configured: the request must not claim an email was sent.
The response says the installation has no mail delivery and points at the
installation recovery path.

S11. The reset page never authenticates the user automatically; it returns to the
login form.

## Open decisions

D1. Recovery when there is no SMTP transport. Recommendation: dedicated honest
message (S10), because the alternative — "check your email" for a mail that was
never sent — strands the owner.

D2. A superadministrator whose email is unverified cannot use this path. Verifying
the address inside the reset flow is rejected: the requester may not be the owner.

D3. Several superadministrators each recover their own account; the filter is by
role, not by "the" owner.

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
