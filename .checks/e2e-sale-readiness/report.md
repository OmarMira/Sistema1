# T16 / S16 — Browser E2E on the corrected flows (observed evidence)

Task: `odd/tasks/sale-readiness-hardening.md` T16, spec **S16**.
Repo: `C:/Users/PC Omar/Downloads/Sistema1`, branch `feat/sale-readiness-hardening` (no branch switch, no commits, no application-source edits).
Run date: 2026-11-03. Server: Next 16.4.2 dev on `http://localhost:3210`.

## Verification channel — read this first

**No flow is BROWSER-VERIFIED. All seven are HTTP-VERIFIED.**

The `agent-browser` CLI is **not installed** in this environment (`which agent-browser` → not found;
`node_modules` has no `agent-browser`; installing it was not authorized), so no browser step could
be executed. Every flow below was driven over HTTP against the running app with the real session
cookie issued by `POST /api/auth/login`, i.e. the same endpoints the UI components call, and the
client-side code paths were read to confirm which request shape the UI produces.

Two flows are structurally not observable over HTTP and are marked as such:

- "authenticated shell / redirect to login" — the app is a **client-rendered SPA**: `/` always
  returns the same 200 shell and the view is chosen in the browser after `hydrate()`. HTTP can only
  prove the auth contract (`/api/auth/me`), never the rendered view.
- "no error boundary" — a React error boundary only trips in a browser.

## Environment notes (blocking issues encountered and how they were side-stepped)

1. **A stale dev server blocks every new `next dev` in this repo.** PID 33316 has been serving
   `http://localhost:3000` from this repo since 2026-11-02 21:00, bound to the ambient `.env`
   `DATABASE_URL` (`postgres:5432`, unreachable) — `/api/health` returns 503 and
   `/api/bootstrap/check` returns 500 for hours. Next 16's dev lockfile (`.next/dev/lock`) makes a
   second `next dev` in the same directory exit with "Another next dev server is already running".
   **I did not kill it** (not mine). Instead the app was run from a mirror copy outside the worktree
   with a real copy of `node_modules` (a junction was rejected by Turbopack: "Could not find the
   Next.js package … files outside of the workspace root are not compiled"). The mirror is a
   byte-identical copy of `src/`, `prisma/`, `public/`, `rules/`, the config files and `.env*`, so
   the code under test is the branch HEAD.
2. **PG17 fixture** at `127.0.0.1:54497` / `accountexpress_test` was already running (41 tables).
3. **Seed**: `.checks/e2e-sale-readiness/seed.cjs` created company `e2e-company-1`, a verified
   `super_admin` (`e2e-admin@example.test`), a `viewer` (`e2e-viewer@example.test`), both
   memberships and one GL account. Password: `E2ePassword!123`.
4. **Module entitlements are required.** Every business endpoint first answered
   `403 MODULE_NOT_ENTITLED` ("Module accounting is not available … NOT_CONFIGURED") because the
   seeded company had no `CompanyModuleEntitlement` rows. They were initialized through the app's
   own contract (`PATCH /api/company/entitlements/{accounting,banking}` → 200) rather than by
   writing rows by hand. A freshly registered company gets them from
   `initializeDefaultCompanyModuleEntitlements`; only hand-seeded fixtures need this step.
5. The `super_admin` account sees **every** company in `/api/auth/me` (326 rows in the shared
   fixture) — by design (`src/app/api/auth/me/route.ts:47`), noted only because it made the SPA
   land on a company picker instead of the seeded company.

## Results

| # | Flow | Result | Channel | Evidence (one line) |
|---|------|--------|---------|---------------------|
| F1 | Login → authenticated shell | **PASS** | HTTP-VERIFIED | `POST /api/auth/login` → 200, `Set-Cookie: session=…`, body `user.role=super_admin` + company list; `GET /api/auth/me` with that cookie → 200 same user; `GET /` → 200 (26 982-byte SPA shell). |
| F2 | Dashboard renders, no error boundary | **PASS** | HTTP-VERIFIED (data layer) | `GET /api/dashboard?companyId=e2e-company-1&locale=es` → 200 with totals/period payload; `GET /api/dashboard/financial?…` → 200; the dev-server log contains **zero** 500s and zero unhandled-error markers for the whole run. Rendered-DOM assertion impossible without a browser. |
| F3 | AI tab: masked key, save-without-change keeps key | **PASS** | HTTP-VERIFIED | `GET /api/config/ai` → `apiKey:"sk-e...wxyz"`; `POST /api/config/ai` with exactly that string (what `AiConfigTab` sends, see `AiConfigTab.tsx:126,188`) → `{"success":true,"providerId":"openrouter","keyUnchanged":true}`; `GET` again → identical mask; stored `SystemConfig.ai_encrypted_key` envelope sha256 prefix `350a14adc7680203` and `updatedAt 2026-11-03T14:45:11.403Z` **unchanged before/after the save**, decrypted plaintext still 21 chars `sk-e…wxyz`-shaped with **no ellipsis** (sha prefix `149ea5f487cebf72`). |
| F4 | Backup create → list → download → parses → encrypted at rest | **PASS** | HTTP-VERIFIED | `POST /api/backup?companyId=e2e-company-1` → 200 (`e2e-company-1_fe096daa-…json`, size 5594); `GET /api/backup` → 200 lists it; `GET /api/backup/<file>` → 200, base64 decodes to JSON with keys `manifest,data`, `manifest.version=2.1.0`, `manifest.companyId=e2e-company-1`; on disk the file is 7682 bytes starting `ACCOUNTEXPRESS-ENCRYPTED-BACKUP/1` + `{"format":"accountexpress-company-backup",…,"algorithm":"AES-256-GCM","keyDerivation":"PBKDF2-SHA256-100000"}` with **0** occurrences of `passwordHash`, the legal name or the user e-mails, while the decrypted download does contain those legal-name/e-mail strings (2 each) → encryption roundtrip proven through the download endpoint. Audit chain: `BACKUP_CREATED` (hash `e1cde451b7`) → `SECURITY_BACKUP_DOWNLOADED` (previousHash `e1cde451b7`, hash `fb1a6de9d1`). |
| F5 | Reports view renders without 500 | **PASS** | HTTP-VERIFIED | Trial balance `GET /api/reports/trial-balance` → 200 `{"accounts":[],"totalDebits":0,…}`; transactions `GET /api/reports/transactions` → 200; reconciliation `GET /api/reports/reconciliation` → 400 `{"error":"bankAccountId is required"}` **only when called without the parameter**: the UI never does that (`ReconciliationTab.tsx:36` returns early when no bank account is selected), so this is the documented contract, not a 500. |
| F6 | Logout → protected views redirect to login | **PASS** | HTTP-VERIFIED (server half) | `POST /api/auth/logout` → 200 `{"success":true}` with `Set-Cookie: session=; Path=/; Max-Age=0; HttpOnly; SameSite=lax`; replaying the old cookie gives `401 AUTH_REQUIRED` on `/api/auth/me`, `/api/backup`, `/api/dashboard`, `/api/reports/trial-balance`. `GET /` still returns the 200 shell, so the *visual* redirect to the login view is unverified (client-rendered SPA). |
| F7 | Viewer: backup download blocked | **PASS** (server-enforced only) | HTTP-VERIFIED | Viewer session: `GET /api/backup` → 200 (list), `GET /api/backup/<file>` → **403 `{"error":"Forbidden","code":"FORBIDDEN"}`**, `POST /api/backup` → 403, `DELETE /api/backup` → 403, `GET /api/dashboard` → 200. **NOT UI-hidden**: `BackupItem.tsx:87` renders the download button for every role. |

No FAIL rows. Two flows carry an explicit partial-observation caveat (F2 rendered DOM, F6 visual
redirect, F7 UI hiding) because they are only observable in a browser.

## Observations / non-fixed defects found while verifying (no code changed)

1. **Viewer download fails silently in the UI.** `BackupPage.handleDownload`
   (`src/components/spa/BackupPage.tsx:124-136`) calls the endpoint, and on `!res.ok` does nothing
   (no toast, no state). A viewer who clicks Download sees no feedback at all; only the network tab
   shows the 403. Server authorization (S4) is correct — this is a UI feedback gap.
2. **The `passwordHash` disk assertion is weaker than it looks.** The exported snapshot does not
   carry `passwordHash` at all (`users[]` keys: `id,email,firstName,lastName,isActive,phone,
   streetLine1,streetLine2,city,state,zipCode,avatar,createdAt,updatedAt,role`), so "no plaintext
   `passwordHash` on disk" would also hold without encryption. The encryption is instead proven by
   legal name / e-mail addresses being present in the decrypted payload and absent from the on-disk
   envelope.
3. **A pre-existing stale dev server (PID 33316, port 3000, ambient DB) remains running** and will
   block any future `next dev` in this repo until it is stopped. Left untouched by this task.

## Reproduction

```bash
# 1. fixture already running: 127.0.0.1:54497 / accountexpress_test
# 2. seed (never the ambient DB)
DATABASE_URL='postgresql://postgres@127.0.0.1:54497/accountexpress_test?schema=public' \
  node .checks/e2e-sale-readiness/seed.cjs
# 3. run the app from a mirror copy (see Environment note 1) with
SESSION_SECRET='e2e-sale-readiness-secret' \
DATABASE_URL='postgresql://postgres@127.0.0.1:54497/accountexpress_test?schema=public' \
  npx next dev -p 3210        # detached, log to a temp file, poll /api/health
# 4. login + AI key state inspection
curl -s -c admin.cookies -X POST http://localhost:3210/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"e2e-admin@example.test","password":"E2ePassword!123"}'
SESSION_SECRET='…' DATABASE_URL='…' node .checks/e2e-sale-readiness/ai-key-state.cjs
```

Scratch paths used (outside the worktree, safe to delete by the parent):

- temp root: `C:/Users/PC Omar/AppData/Local/Temp/gpqmIcDk/gaJQnyZ1/e2e-sale-readiness/`
  - `run2/` mirror copy incl. `node_modules` copy, `.env`, `.env.local` and `run2/db/backups/<backup>.json`
  - `apprun/` first (failed) mirror attempt with a `node_modules` junction — unused, contains a `.env` copy
  - `dev.log` (failed attempt), `dev2.log` (the run used, 9 470 lines, 0 × 500)
  - `admin.cookies`, `viewer.cookies`, `*.json` response captures
