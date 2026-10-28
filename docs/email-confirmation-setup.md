# Restore email confirmation

Email confirmation needs both the identity runtime and a working SMTP account. A running Next.js server alone does not establish email delivery.

## Configure privately

Edit `.env.local` in the project root. Never paste credentials, verification codes or recovery tokens into chat, logs or Git.

```dotenv
IDENTITY_INFRASTRUCTURE_ENABLED=true
IDENTITY_VERIFICATION_HMAC_KEY="<independent canonical base64 key, at least 32 random bytes>"
SMTP_HOST="<your SMTP provider host>"
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER="<your SMTP account>"
SMTP_PASS="<your provider-issued application password or SMTP credential>"
SMTP_FROM="<your authorized sender address>"
```

- The identity key must differ from `SESSION_SECRET` and `HMAC_SECRET`. Keep an existing valid key; changing it invalidates outstanding verification codes. Do not replace database/session/accounting configuration.
- The recovery preparation generates the identity key locally if absent. It does **not** recover or invent an SMTP password. Fill in the commented SMTP settings using your actual provider.
- Port `587` normally uses STARTTLS with `SMTP_SECURE=false`; port `465` normally uses `SMTP_SECURE=true`. Follow your provider's settings. For Gmail, use an application password, not your ordinary Google password.
- `SMTP_FROM` defaults to `SMTP_USER`; specify it when the provider requires an explicit authorized sender. `SMTP_FROM_NAME` is optional.
- These variables are server-only: never prefix secrets with `NEXT_PUBLIC_`. Next.js expands `$` in environment values; escape a literal dollar sign as `\$`.

Restart your existing `npm run dev` process after saving. Do not start a second server on the same port.

## Expected behavior

| Situation | Result |
| --- | --- |
| Identity disabled or key invalid | Registration reports `deliveryFailed: true`; verification is unavailable. |
| SMTP host, user or password missing | Delivery fails without attempting SMTP; no false successful send. |
| SMTP provider rejects the send | Delivery fails; provider payload and credentials are not exposed. |
| Provider accepts the send | Registration may report delivery success. Acceptance alone does not prove inbox arrival. |
| Code is verified successfully | The existing verification flow finalizes the account and creates the session. |

A resend response is deliberately neutral; it is not proof of delivery. `/api/auth/me` returning `401` before login means there is no authenticated session, not that SMTP failed.

## Check your password visually

The initial registration form and the resumed confirmation screen have an eye button beside each password field. Show or hide the password and its confirmation independently; both start hidden whenever the screen mounts. The buttons support keyboard activation and have translated accessible names. Showing a value does not submit the form, change validation, or save a password in browser storage. Hide the fields again before sharing your screen.

A browser draft can outlive its server-side pending request, for example after changing development databases. A neutral resend response does not recreate a missing request. Use **Back to registration** to return to the initial form, keeping the entered account details. Re-enter both passwords and submit registration again to request a code normally. Going back clears only the local draft and in-memory passwords; it does not send email or delete an account, challenge, or database record.

## Verify the real flow

Once the provider and credentials are configured, request a fresh code, check the inbox/spam folder, and confirm it in the application. Do not reuse a code generated with a different identity key. Do not bypass email verification or manually mark an account verified.

Automated SMTP tests use a mocked transport and no real database. They prove failure/success reporting, **not** external authentication, inbox arrival or completed end-to-end registration. Real-provider verification remains pending until credentials and permission to use that provider are supplied.
