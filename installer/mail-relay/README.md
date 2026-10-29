# Gmail verification relay — operator setup

This is the mail-only component of the Windows installer, **not the complete installer**. The installed application's identity transport is connected in explicit relay mode; operational delivery still requires the owner actions below. The accounting application and PostgreSQL remain on the customer's PC. This component sends only verification codes and recovery tokens through the owner's Gmail account.

**No Gmail password or app password is required by this component.** Google authorizes `MailApp` for the owner. The relay signing key is a different, generated secret: keep it on the operator's PC and in private Google Script Properties, never in a client package. No Google deployment or actual delivery has been performed by the repository tests.

## One-time owner actions

You must perform these steps while signed in to the Gmail account that will send the messages. Never paste its password, app password, cookies, Google session data or OAuth tokens into chat or client files. Any assisted Google operation requires explicit owner authorization for the new project and a fresh owner-started session; an existing browser login is not permission.

1. At https://script.google.com/, create an Apps Script project named `AccountExpress mail verification`.
2. Replace its `Code.gs` with this directory's `Code.gs`. In project settings, enable displaying the manifest, and replace `appsscript.json` with this directory's manifest. It requests send-mail permission, not access to your Gmail inbox.
3. In a private operator folder, create a signing key. For example, from the repository root in PowerShell:

   ```powershell
   New-Item -ItemType Directory -Force installer/mail-relay/.operator | Out-Null
   node installer/mail-relay/owner.cjs init --output installer/mail-relay/.operator/signing-key.txt
   ```

   The tool refuses to overwrite a key. Restrict the folder to your Windows account; POSIX mode `0600` alone does not establish Windows ACL privacy. This folder is ignored by Git and must be excluded from distribution. Keep a protected backup: losing/changing the key invalidates previously issued installation credentials.
4. In Apps Script **Project settings → Script properties**, add:

   | Property | Value |
   | --- | --- |
   | `RELAY_SIGNING_KEY` | The generated 64-character signing key, copied privately from its file |
   | `GLOBAL_DAILY_LIMIT` | `80` initially; the handler rejects values outside 1–100 |
   | `REVOKED_INSTALLATIONS` | `[]` initially; later add revoked installation IDs as a JSON array |

   Do not put these values in `Code.gs`, screenshots, support messages or the installer. Do not enter your SMTP app password here: it is not used.
5. Choose **Deploy → New deployment → Web app**. Execute as **Me** (the owner); allow **Anyone** to reach the URL. Requests still require the installation credential validated by the handler. Authorize only the project you just created with the stated send-mail permission. Availability of public deployment can depend on Google account/organization policy.
6. Save the published HTTPS `/exec` URL. The `/dev` URL is not a production endpoint. When code changes, update the deployment version; editing the editor alone does not update the published code.

Publishing executes code under your Google permissions. This is an explicit owner action, not something a local installer can silently authorize for you. Never transmit Google OAuth tokens to customers. Publishing a URL without this handler's authorization/limit checks would create an unsafe sender.

## Issue a separate mail authorization per installation

Generate one unique ID per customer installation, select an expiration, and issue its limited credential. Use a real future date and your own published URL:

```powershell
New-Item -ItemType Directory -Force installer/mail-relay/.credentials | Out-Null
node installer/mail-relay/owner.cjs issue `
  --key-file installer/mail-relay/.operator/signing-key.txt `
  --installation-id customer-000001 `
  --expires 2030-01-01 `
  --relay-url https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec `
  --output installer/mail-relay/.credentials/customer-000001.json
```

The command prints neither signing key nor token, creates a new file only, and rejects unsupported endpoints. The JSON contains the public relay URL and **only that installation's** authorization. It does not reveal the signing key or Gmail credentials. Copying an installation credential shares its same quota; it does not create new quota. Revoke a compromised ID through `REVOKED_INSTALLATIONS`. This is mail permission, not a paid licensing system. Copy only that installation's issued JSON to `<selected-data-directory>/relay.json`. The installed runtime explicitly selects relay mode and fails closed when this file is missing, invalid or expired; the development SMTP branch is unchanged. Never distribute `owner.cjs`, `.operator/`, other customers' credentials, or development `.env` files.

## Request and failure contract

The application integration must POST JSON over HTTPS to the published URL:

```json
{
  "version": 1,
  "token": "INSTALLATION_AUTHORIZATION",
  "requestId": "a-unique-uuid-for-this-attempt",
  "language": "es",
  "message": { "type": "verification", "to": "person@example.com", "code": "123456" }
}
```

Recovery uses `{"type":"recovery","to":"person@example.com","token":"THE_LOCAL_RECOVERY_TOKEN"}`. No caller-controlled subject, HTML, arbitrary message, recipient list, attachment, CC or BCC is accepted. Do not send accounting records, passwords or SMTP credentials. Verification codes must have six digits; recovery tokens are bounded URL-safe values. The route does not verify codes itself: the local identity service retains challenge expiry, consumption and password/session authorization.

Google ContentService may redirect the response to a Google-owned content URL. The installed client manually validates Google-only redirect destinations and follows the content response using GET without forwarding the installation credential/body. It bounds responses to8,192bytes and attempts to10seconds. **HTTP 200 is not success**: inspect JSON `ok` and `code`. `{"ok":true,"code":"accepted"}` means MailApp accepted the request, not that the recipient received it; actual verification still requires entering the received code.

Failures are sanitized: `invalid_request`, `not_configured`, `unauthorized`, `busy`, `rate_limited`, `quota_exhausted`, `request_conflict`, `delivery_failed`, `delivery_unknown`, or `unavailable`. Do not auto-retry an ambiguous send with a new request ID. Same-ID requests with identical content replay their stored result during the same UTC quota day; different content is rejected. Deduplication does not span UTC days. The installed client does not automatically retry a failed or ambiguous attempt. A resend is a new explicit user action through the identity service, not replay of an expired challenge. No provider error, address, code, recovery token or credential is logged by this code; counters retain message digests, not raw codes.

## Free-tier limits and honest availability

Default protections: 3 attempts/day per installation, 3/day per recipient across installations, 60 seconds between installation attempts, 80 attempts/day for the owner globally, and Google's actual remaining allowance. Failed/ambiguous sends conservatively consume reservations; unauthorized/invalid/quota-denied requests do not change counters. A script-wide lock serializes the check/reservation/send sequence. Dates are UTC; Google's own allowance may use a different rolling reset, so the actual quota is always checked.

Google currently publishes **100 email recipients/day for consumer accounts**, shared by the owner, not 100 per installation. These are provider-controlled quotas, can change, and have no application-specific availability guarantee. The script does not enroll in billing or upgrade a plan. Anonymous requests can still consume Google's execution resources even when our handler rejects them; this is not a DDoS-resistant service. Keep the signing key private, monitor quota, and do not promise unlimited production email. Google still processes recipient addresses and message contents as the mail provider.

Sources: [Apps Script availability](https://workspace.google.com/intl/en_US/products/apps-script/), [MailApp](https://developers.google.com/apps-script/reference/mail/mail-app), [quotas](https://developers.google.com/apps-script/guides/services/quotas), [web-app permissions](https://developers.google.com/apps-script/guides/web).

## Checks and remaining acceptance

```powershell
node --test --test-reporter=spec tests/installer/mail-relay.test.cjs
node installer/mail-relay/owner.cjs --help
node node_modules/vitest/vitest.mjs run --config vitest.packaging.config.mts
```

Tests invoke the public handler using fake Google services and the real operator CLI against temporary test files. They do not authorize Google, publish a web app, send real mail, create a production signing key or prove native Windows installation. A real owner-authorized deployment and inbox/code round trip remain required before claiming operational mail. Run that acceptance only with the exact account, endpoint and operation authorized by the owner; never reuse an ambient browser session or credential.
