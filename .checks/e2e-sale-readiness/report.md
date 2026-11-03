# T16 / S16 — Browser E2E on the corrected flows (observed evidence)

Task: `odd/tasks/sale-readiness-hardening.md` T16, spec **S16**.
Repo: `C:/Users/PC Omar/Downloads/Sistema1`, branch `feat/sale-readiness-hardening` (no branch switch, no commits, no application-source edits).
Run date: 2026-11-03. Server: Next 16.4.2 dev on `http://localhost:3210`.

## Verification channel — read this first

> **Superseded for F1-F7 by "Browser pass 2" below (same day, second run): the `agent-browser` CLI
> was installed afterwards and all seven flows are now BROWSER-VERIFIED.** This pass-1 section is
> kept as-is for its HTTP-level evidence and its historical environment notes.

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

---

# Browser pass 2 — BROWSER-VERIFIED (agent-browser CLI, in-place dev server)

Run date: 2026-11-03 (second pass, same day). This pass supersedes the channel claim of pass 1: the
`agent-browser` CLI **is** installed now (`agent-browser 0.41.1`, headless Chrome 156 under
`~/.agent-browser`), the Next dev lock was free, and the app was run **in place** from the repo root
(no mirror copy). All seven flows were driven through the real UI with real clicks/fills, not HTTP.

Server: `npx next dev -p 3210` started from the repo root,
`SESSION_SECRET='e2e-sale-readiness-secret'`,
`DATABASE_URL='postgresql://postgres@127.0.0.1:54497/accountexpress_test?schema=public'`,
`/api/health` → 200 `database:"connected"`. Fixture DB was re-seeded with
`.checks/e2e-sale-readiness/seed.cjs` (fresh: 2 users, `e2e-company-1`, 1 GL account) and the AI key
was stored through `POST /api/config/ai` before the browser session started.

## Results — BROWSER-VERIFIED

| # | Flow | Result | Browser evidence (refs, observed text, artifacts) |
|---|------|--------|---------------------------------------------------|
| F1 | Login via the real form → authenticated shell | **PASS** | `open http://localhost:3210` → landing view; `click @e4` ("Iniciar Sesión") → login form (`textbox "Correo electrónico" @e24`, `textbox "Contraseña" @e27`, `button "Iniciar Sesión" @e26`); `fill` + `click @e26` → snapshot shows the authenticated shell (company picker buttons incl. `"E2E Sale Readiness SA RFC / NIT: E2E-30-12345678-1" @e38`, `button "Cerrar Sesión" @e44`), no login form. `POST /api/auth/login` 200, `GET /api/auth/me` 200. Screenshot: `screens/f1-login-form.png`. |
| F2 | Dashboard view renders, no error boundary | **PASS** | After `click @e38` (company) the shell renders `heading "Panel" @e52`, KPIs `Total de Activos $0.00`, `Total de Pasivos $0.00`, `Ingresos del Período`, `Gastos del Período`, the assistant paragraph `"Para 2026-11, el flujo neto fue de 0.00…"` and the `FLUJO DE CAJA REAL EN STAGING` section. `agent-browser errors` → empty; no error-boundary text. Screenshot: `screens/f2-dashboard.png`. Caveat: the first attempt showed `"No se pudieron cargar los datos del panel"` + `Reintentar` because the hand-seeded company had **no module entitlements** (`GET /api/dashboard` 403 `MODULE_NOT_ENTITLED`, `reason:"NOT_CONFIGURED"`); fixed by the app's own contract (`PATCH /api/company/entitlements/{accounting,banking}` → 200), i.e. a fixture gap, not a product defect. |
| F3 | Settings → AI tab: masked key, save-without-change, reload | **PASS** | `click @e101` ("Configuración") → `click @e119` ("Configuración IA") → `click @e121` ("Editar Configuración"): the key field is a password input whose value is `sk-e...0001`. `click @e127` ("Guardar y Activar") **without editing** → the browser POSTed `{"apiKey":"sk-e...0001","model":"openrouter/free","providerId":"openrouter"}` and received `{"success":true,"providerId":"openrouter","keyUnchanged":true}` (captured request 36456.320). Stored envelope sha `2f53a0abe1563178`, `updatedAt 17:34:13.760Z`, decrypted plaintext sha `841d4e0b8b16f262`, length 32, `containsEllipsis:false` — **identical before and after the UI save**. After `reload` + re-navigation (`Configuración` → `Configuración IA` → `Editar Configuración`) the field still reads `sk-e...0001`. Screenshots: `screens/f3-ai-tab-masked.png`, `screens/f3-ai-tab-after-save-reload.png`. |
| F4 | Backup create → list → download → encrypted at rest | **PASS** (browser-triggered download; no CLI-saved file — see Environment note 2) | `click @e213` ("Crear Respaldo") → `POST /api/backup` 200, `GET /api/backup?companyId=e2e-company-1` 200, the item renders `"E2E Sale Readiness SA" · "3 nov 2026, 12:39 p.m." · "8.7 KB"` and `manifest.json` gains the entry. `click @e214` (item download) → `GET /api/backup/e2e-company-1_9eba0cf1-….json?companyId=e2e-company-1` **200**; an in-page hook (`URL.createObjectURL` + `HTMLAnchorElement.prototype.click`) observed the UI build the download with `filename:"e2e-company-1_9eba0cf1-56fa-400d-b92a-fbeb83b263dc.json"`, `hrefScheme:"blob"`, `blobSize:8866`, `blobType:"application/json"`, head `{"manifest":{"version":"2.1.0","id":"9eba0cf…`. Disk: `db/backups/e2e-company-1_9eba0cf1-….json` = 12 046 bytes starting `ACCOUNTEXPRESS-ENCRYPTED-BACKUP/1` + `{"format":"accountexpress-company-backup","version":1,"algorithm":"AES-256-GCM","keyDerivation":"PBKDF2-SHA256-100000","ciphertext":…}`, **0** occurrences of `passwordHash`, `e2e-admin@example.test` or `E2E Sale Readiness SA`; the API-downloaded payload (identical 8 866 bytes) **does** contain 2 × admin e-mail and 2 × legal name → encryption roundtrip proven. Audit chain fired: `BACKUP_CREATED` (hash `e947b224`) → `SECURITY_BACKUP_DOWNLOADED` (prev `e947b224`, hash `e5ece1c1`) → three further chained download rows, each `previousHash` = the prior `hash`. Screenshot: `screens/f4-backup-list.png`. |
| F5 | Reports view renders values, no error boundary | **PASS** | `click @e242` ("Reportes") → `heading "Reportes"`, tabs `Balanza de Comprobación` (selected), `Listado de Transacciones`, `Transacciones Pendientes`; the trial-balance panel renders its date field (`Fecha al: 2026-11-03`), `Actualizar`/`CSV`/`PDF`/`Imprimir` and the empty-state `"No hay datos disponibles para el período seleccionado."` (fixture has no journal data). `click @e271` (transactions tab) renders the range `2026-10-04 — 2026-11-03`, `Desde`/`Hasta` date pickers, `Cuenta Contable` combo and `CSV`/`PDF`. Network: `GET /api/reports/trial-balance…` 200, `GET /api/reports/transactions…` 200; `agent-browser errors` empty. Screenshot: `screens/f5-reports.png`. |
| F6 | Logout returns to the login view | **PASS** | `click @e223` (avatar `EA`) → `menuitem "Cerrar Sesión" @e296` → `click` → `POST /api/auth/logout` **200**; the snapshot is the public landing/login view (`button "Iniciar Sesión"`, `button "Registrarse"`, hero headings) with **no** authenticated shell and no session cookie left (`agent-browser cookies` → no `session`). Screenshot: `screens/f6-after-logout.png`. This closes the "visual redirect unverified" caveat of pass 1. |
| F7 | Viewer session: download control on the backup page | **PASS (server) + UI-VERIFIED UX DEFECT** | Logged out (F6), logged in as `e2e-viewer@example.test` through the same form, picked `e2e-company-1`, `Configuración` → `Respaldos del Sistema`: the page renders the item row **with the download icon button visible** (`button @e374`) — plus `"Crear Respaldo" @e376` and `"Seleccionar archivo de respaldo" @e373`, all visible to a `viewer`. `click @e374` → `GET /api/backup/e2e-company-1_9eba0cf1-….json?companyId=e2e-company-1` → **403** `{"error":"Forbidden","code":"FORBIDDEN"}` (captured request 36456.673) and **nothing happens in the UI**: the sonner container (`div[role=region] aria-label="Notifications (F8)" > ol`) stayed at `children.length = 0`, zero `[data-sonner-toast]` nodes, no inline error, no navigation, no file. Screenshots: `screens/f7-viewer-backup-page.png` (control visible), `screens/f7-viewer-download-silent.png` (identical page after the click). |

No FAIL rows. F4 carries one explicit channel limitation (the browser download was not persisted to
disk by the CLI — Environment note 2); everything else was observed in the rendered DOM.

## Findings (reported, not fixed — verification-only task)

1. **F7 UX defect confirmed in a real browser (S4 server side is correct).** A `viewer` sees the
   download control on the backup page; clicking it issues
   `GET /api/backup/<file>?companyId=…` which correctly returns `403 FORBIDDEN`, and the user gets
   **no feedback whatsoever**. Code: `src/components/spa/settings/BackupTab.tsx:106-120`
   (`handleDownload` only has `if (res.ok) { … }`; its `catch` covers network throws only), and the
   same shape in `src/components/spa/BackupPage.tsx` (`handleDownload`, ~:124-136). The same silent
   403 applies to `"Crear Respaldo"` (`POST /api/backup` 403) and to the restore/upload control on
   this fixture, i.e. a viewer is offered three actions that all fail invisibly. Not fixed here.
2. **Sonner toasts did not render at all in this dev session**, which makes the silent-403 defect
   worse than the code alone suggests. With a `MutationObserver` on `document.body` installed
   *before* the click, **no** `[data-sonner-toast]` node ever appeared for (a) viewer
   `POST /api/backup` → 403 (which *does* call `toast.error`, `BackupTab.tsx:98`) nor for (b) admin
   `POST /api/backup` → **200** (which *does* call `toast.success`, `BackupTab.tsx:89`). The Toaster
   container exists (`div[role=region] aria-label="Notifications (F8)" > ol`) and stays empty;
   `agent-browser errors` and `agent-browser console` are clean; the dev log has no 500 and no
   `Module not found`. Not diagnosed further and **not reproduced in a production build** — flagged
   as an environment/build observation, not a proven product defect.
3. **Fixture gap: hand-seeded companies have no `CompanyModuleEntitlement` rows.** Without
   `PATCH /api/company/entitlements/{accounting,banking}` the dashboard/reports show
   `"No se pudieron cargar los datos del panel"` (`403 MODULE_NOT_ENTITLED`). Companies created by
   registration get the defaults, so this is a seed limitation; the seed script could call the same
   endpoint to be self-sufficient.
4. **`super_admin` sees every company of the shared fixture** (11 companies incl. leftovers such as
   `Chain Mixed Co`, `RC21 NoMember Co`) and must pick one before the shell renders. By design
   (`/api/auth/me` returns all companies for a platform admin), noted only because it makes the
   browser flow stop on a company picker.
5. **The `passwordHash` disk assertion remains weaker than it looks** (restated from pass 1): the
   exported snapshot carries no `passwordHash` at all, so "0 occurrences on disk" would hold even
   unencrypted. Encryption is proven here by the legal name / admin e-mail appearing twice in the
   *decrypted* download payload and being absent from the on-disk envelope.
6. **`db/backups` hygiene after this pass**: the two E2E backups were moved to
   `/tmp/sistema1-backup-quarantine/e2e-pass2/` and `db/backups/manifest.json` was reset to
   `{"backups":[]}` so the shared directory stays clean for the suites (L9 follow-up still open:
   suites should isolate their backup directory instead of sharing `db/backups`).

## Environment notes (pass 2)

1. **The stale dev server from pass 1 is gone**: port 3000 is free and `.next/dev/lock` did not
   exist, so `next dev` could run **in place** from the repo root. Port 3210 was free before start
   and is free again after teardown (`GET /api/health` → 000, no listener, `.next/dev/lock` removed,
   the dev process tree was killed with `taskkill /PID <pid> /T /F`).
2. **`agent-browser download <sel> <path>` cannot capture a download in this headless setup**: it
   reports `✗ Download was canceled` even for a control page consisting of a plain
   `<a download href="data:text/plain,hello">` (no app code involved), so it is a CLI/Chrome
   limitation, not an app defect. The app download was therefore verified by (a) the 200 response of
   the backup GET and (b) an in-page hook recording the anchor download produced by
   `downloadBackup()` (filename, `blobSize: 8866`, `blobType: application/json`, first 60 bytes).
   The hook instruments only the standard `URL.createObjectURL` + `anchor.click()` pair, so a future
   regression in that helper stays visible.
3. **CLI quirks worth remembering**: `--timeout` is neither a global flag before the subcommand nor a
   trailing argument — it gets swallowed by `fill`/`screenshot` (`fill @e24 "x" --timeout 30000`
   types `x --timeout 30000`, and `screenshot <path> --timeout` writes a file literally named
   `--timeout`). Use `agent-browser screenshot <selector> <path>` and bound each call from the shell.
4. **PG17 fixture** at `127.0.0.1:54497` / `accountexpress_test` (41 tables) was already running
   under `…/Temp/gpj8xV4Z/sistema1-company-recovery-acceptance/pgdata-2` and was left running.

## Reproduction (pass 2)

```bash
# 1. seed the disposable fixture (never the ambient .env DB)
DATABASE_URL='postgresql://postgres@127.0.0.1:54497/accountexpress_test?schema=public' \
  node .checks/e2e-sale-readiness/seed.cjs
# 2. in-place dev server (repo root, detached), then poll /api/health until 200
SESSION_SECRET='e2e-sale-readiness-secret' \
DATABASE_URL='postgresql://postgres@127.0.0.1:54497/accountexpress_test?schema=public' \
  npx next dev -p 3210 > /tmp/e2e-dev3.log 2>&1 &
# 3. store an AI key through the API contract (admin cookie)
curl -s -c admin.cookies -X POST http://localhost:3210/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"e2e-admin@example.test","password":"E2ePassword!123"}'
curl -s -b admin.cookies -X POST http://localhost:3210/api/config/ai \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"sk-e2e-pass2-openrouter-key-0001","providerId":"openrouter"}'
# 4. entitlements, otherwise dashboard/reports answer 403 MODULE_NOT_ENTITLED
for m in accounting banking; do
  curl -s -b admin.cookies -X PATCH \
    "http://localhost:3210/api/company/entitlements/$m?companyId=e2e-company-1" \
    -H 'Content-Type: application/json' -d '{"enabled":true}'; done
# 5. drive the browser, screenshot each flow, then close
agent-browser open http://localhost:3210
agent-browser snapshot -i        # click/fill the refs recorded in the table above
agent-browser screenshot body .checks/e2e-sale-readiness/screens/<flow>.png
agent-browser close
```

Credentials: `e2e-admin@example.test` / `e2e-viewer@example.test`, password `E2ePassword!123`
(from `.checks/e2e-sale-readiness/seed.cjs`).

Scratch paths used by this pass (outside the worktree):

- `/tmp/e2e-dev3.log` — dev-server log of this pass (33 954 lines, 0 × 500, 0 × module-not-found)
- `/tmp/e2e-download/` — empty; the CLI download attempts wrote nothing
- `/tmp/sistema1-backup-quarantine/e2e-pass2/` — the two E2E backup files
  (`e2e-company-1_9eba0cf1-….json` 12 046 B, `e2e-company-1_88c1e756-….json` 19 318 B), safe to delete
- `/tmp/admin.cookies`, `/tmp/login.json`, `/tmp/dl.json`, `/tmp/dl-decoded.json`, `/tmp/e2e-health.json`
- PG17 data dir (pre-existing, left running):
  `C:/Users/PC Omar/AppData/Local/Temp/gpj8xV4Z/sistema1-company-recovery-acceptance/pgdata-2`
