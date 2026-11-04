# Administrative user deletion

`DELETE /api/admin/users/:id` requires an authenticated superadmin. This does not authorize deleting real users for testing.

## Company access protection

Superadmins currently have global company access (`src/lib/rbac.ts`), independent of individual memberships. Deletion of a superadmin is blocked while any company exists unless another usable global superadmin remains. A usable replacement is active and email-confirmed, or an active legacy user already allowed by the session policy. An ordinary company administrator, suspended account or unconfirmed non-legacy account is not a replacement. Inactive companies are protected too, because global superadmins can still administer them.

The server returns HTTP409 with code `LAST_COMPANY_SUPERADMIN` and error `Deleting this user would leave companies without an active superadmin.` on refusal. No user, membership, session or audit mutation occurs in this branch. The caller's selected company and the target's membership count do not narrow the protection.

If another usable superadmin exists, deletion is allowed, including self-deletion. If no companies remain, the last superadmin may delete their own account. Successful responses retain `message` and `selfDeleted`; successful self-deletion expires the session cookie and the UI clears local authentication and returns to the landing page.

## Atomicity and feedback

The DELETE transaction takes the target email's registration/recovery locks before locking current superadmin rows in ID order and the target User row. It then rechecks caller authority and counts replacements. Identity cleanup, revocation of the target's sessions, audit creation and user deletion share that transaction. Concurrent deletions cannot both count the other administrator as their replacement; a failed transaction rolls back its writes.

The confirmation changes into an informational dialog on refusal, with a specific explanation and only an acknowledge action. Other HTTP/network failures show a distinct localized message, not a company-orphan warning. There is no automatic retry. Pending requests disable the destructive button and cancellation. Closing the message resets it for a later deliberate attempt.

Spanish blocking feedback identifies the last active superadmin, requires another enabled superadmin, and states that no changes were made. Equivalent English copy is provided. This protection applies to DELETE; it does not redesign unrelated role changes, account suspension or company creation flows.

## Clean access lifecycle

Successful deletion removes the target's verification challenges, pending registration and password-recovery challenges. Previously issued codes, recovery tokens and sessions cannot grant access to a later account, even when its email is the same. A new registration uses the newly supplied profile/password/company data and still requires a fresh email confirmation. No existing company or accounting data is deleted by this cleanup.

Opaque identity-security events and anti-abuse budgets remain. The deletion audit records the action and entity ID without copying the deleted email into its details. This is operational access cleanup, not a promise to erase delivered messages, backups or historical business records.

For accounts deleted before cleanup existed, an orphaned **confirmed** registration request is retired on the next registration or resend, after the usual anti-abuse checks. A fresh request/challenge replaces it without a 24-hour wait or inherited resend exhaustion. Existing accounts and ordinary unconfirmed requests retain their previous verification rules. Shared rate limits still apply.

If an administrator changes the target email while deletion waits, HTTP409 `USER_CHANGED` (`User details changed. Refresh and try again.`) refuses the stale request before deletion or cleanup. Refresh and make a new deliberate attempt; the server does not clean another email's request or silently retry. Password-recovery completion also locks the User row before consuming its challenge, matching deletion's lock order. Its password update uses the existing text/CUID User identifier directly; an earlier UUID cast incorrectly rejected otherwise valid recovery tokens. A successful recovery still revokes sessions and consumes the token atomically.

## Isolated checks

```sh
node node_modules/vitest/vitest.mjs run --config vitest.admin-user-deletion.config.ts --maxWorkers 1
node node_modules/vitest/vitest.mjs run --config vitest.clean-identity.config.ts --maxWorkers 1
```

These configurations disable `.env`, setup and global setup. They cover mock-backed API/dialog behavior and orphaned-registration issuance. Do not replace them with the default Vitest configuration or use a real-user DELETE as a probe. Mock checks establish HTTP/UI behavior and transaction routing, not actual PostgreSQL lock scheduling or rollback.

`vitest.clean-identity-integration.config.ts` is the separate real-PostgreSQL check. It refuses to construct a client unless the launcher explicitly supplies an owned `clean_identity_test` database/user on a matching loopback port other than5432. It exercises the actual exported HTTP handlers, real session validation, rollback after an injected deletion failure, and deletion/recovery scheduling in disposable state. Email transport is simulated. It also emits a deterministic public-contract transcript for comparison with the pre-change source; no Git history is read by the committed test itself. This is not deployed-server, real-email or browser proof.
