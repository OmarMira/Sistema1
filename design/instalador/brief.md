# AccountExpress Next Gen — Installation preview

Audience: people without computer or accounting knowledge. This is a standalone visual preview, not an operational installer.

## Requirements
- Preserve Sistema1's typography, readable font sizes and original header controls. The latest user feedback authorizes a wider, viewport-aware layout instead of the original stacked layout. Palette exception authorized by the user: use the accounting-flow screenshot's near-black background, emerald/turquoise accents and amber primary action, with a coordinated light theme. These are installer-local approximations of the screenshot, not new global application tokens. `design/system.md` remains the unchanged record of the application's original palette.
- Match the original header controls: globe + Spanish/English language selection, followed by the sun/moon theme toggle. Do not invent an authenticated account before registration.
- Translate all displayed copy, document title and accessible control labels. Keep theme and language choices independent, stored only under prototype-specific browser keys when storage is available.
- Show the AccountExpress Next Gen product name and clearly identify simulated actions. No database operations, email sends, environment access or installation claims.

## User feedback
"esto debe ser como el sistema original"; "cambio de modo a oscuro y lenguaje". Reference: user-provided ScreenClip `{EF377890-1E77-44C6-9360-4DC8A0E4CDBC}.png`.

Latest feedback: "me gustaria con estos colores manten la tipografia y los tamaños pero cambia los colores para que se vea mas llamativo el instalador". Reference: `{2993A6C3-B864-4CE1-8D42-D7A48C6FDCEE}.png`.

Approved appearance: "me gusta ahora si". Authorized continuation: "continua con todo el recorrido".

## Interactive walkthrough
1. Welcome: identify this as a simulation, explain the steps and start without technical jargon.
2. Company: enter a fictional legal business name, choose USD/EUR/MXN/ARS/GBP and simulate preparation. Demonstrate success, a recoverable failure, and existing-data detection. Existing data is never silently replaced; an explicit new-space simulation is the recovery path. Changing name/currency invalidates preparation.
3. Accounting start: enter a whole year from 2000 through 2100, choose a month and the existing calendar/custom-month/52–53-week period type. Explain that bank balances are incorporated per account during statement import; missing or unreadable information needs review. Do not request a global opening balance.
4. Administrator: require the initial administrator's fictional full name and email address, simulate sending and confirm the visible demonstration code `123456`. Show invalid-name/address, sending-failure and incorrect-code messages. Retry keeps the address. No password, SMTP credentials, real user creation, permission grant or verification.
5. Review: show fictional company, currency, fiscal details, administrator name/email, explicitly simulated initial superadministrator role and simulated checks; allow returning to correct them; finish with an explicit demonstration-complete screen and an option to restart.

Retain inputs when going back or switching language/theme. Editing an already-checked business name or email invalidates the affected check. Runtime data is memory-only and discarded on refresh/restart; only theme/language preferences may use prototype-scoped browser storage. Error messages and recovery actions are translated into Spanish and English.

## Verification
`node design/instalador/preview.test.cjs` exercises public DOM controls in isolated jsdom state, without application globalSetup. Cover the full journey, failure/retry paths, validation, back navigation, changed-input invalidation, theme/language, unavailable storage and escaped text. No database or network access. This does not establish actual installation readiness or replace visual browser review.

Observed checks: initial RED exited 1 because the old artboard had no navigable step state. After implementation, direct DOM suite GREEN exited 0 with 8/8 checks passing, no network operations. Static checks passed for inline JavaScript syntax, manifest JSON, matching 69 locale keys, and unchanged approved light/dark palette and base typography. Production build, application database tests, real SMTP delivery and independent visual browser review were not run because this delivery is a standalone simulation.

### Typing regression correction
User reported: "no funciona correctamente quiero escribir y no me deja escribir lo que pulso, ademas el cursor se queda pegado a la izq y escribe alrevez de derecha a izquierda". Reference: `{3F2750AD-B0C2-4954-ADCD-0C8802A216A4}.png`.

The old input handler replaced the native input on every keystroke. Preserve the original field, browser focus, caret and selection while updating only state, stale result panels and validation/navigation UI. RED exit 1 reproduced email node replacement. GREEN exit 0: 9/9 public DOM checks, including per-character typing, focus, caret, selection, composition and paste continuity plus the existing walkthrough. No real-browser keyboard/rendering run was performed; DOM evidence is not a visual-browser certification.

### Approved follow-up
The user approved removing the global opening-balance field and requested the same omission in the current application's onboarding. That separate, limited application edit removes the field/step and omits the optional balance from its request; it does not delete existing balances or change backend importing or startup guards. See `docs/initial-company-setup.md`.

The user additionally requested: "el instalador cuando pide el email deberia pedir el nombre del usuario y ya quedaria configurado el superAdministrador, de esta manera se completaria la instalacion de la base de datos con la empresa y el super Admin que puede controlar los datos de la empresa." This preview displays the requested initial administrator identity and role but never creates a real account or database.

New DOM RED exited 1 for the missing fiscal field; intermediate GREEN passed 12/12 checks. Administrator-name RED exited 1 for the missing name field; GREEN passed 13/13 checks, including all previous walkthrough/error/caret protections plus currencies, year/month validation and boundaries, all period choices, translations, no global-balance input, administrator-name gating and safe reset. Real-onboarding focused RED had 4 failing / 1 passing test; GREEN passed 17/17 tests including the existing page gates, using the isolated config without database setup.

### Full-window layout correction
Latest user request: "ya lo probe pero me parece importante que sea mas explicativo en la pantalla completa porque al ser tan largo provoca hacer scroll en la pantalla para poder ver lo que sigue o todo el texto, quiero que cada ventana se vea completa en la pantalla sin tener que hacer scroll".

Keep all five steps and required fictional details. Use the available desktop width: explanations on the left, controls on the right, compact progress and a single simulation notice. Place name/email and code/confirmation controls side by side where space allows; use a two-column final review. Replace redundant prepare/send actions with the relevant retry/new-space action rather than stacking more buttons. Do not shrink the approved 14px body, 24px h1 or 18px h2, clip content, hide overflow or introduce internal scrolling.

Real-browser verification: `node design/instalador/layout.test.cjs` uses the installed Windows Edge (or explicit `BROWSER_BIN`) with an isolated temporary profile under this design directory, blocks page HTTP(S), and removes that owned profile afterwards. No browser dependency is downloaded. It checks complete content and navigation at 1366×768, 1280×720, 1024×768, 1366×640 and 1024×640, Spanish/English, light/dark, including validation errors, open scenario selectors, retries, existing data, email/code, review and completion.

Observed RED exit 1: 220 overflowing states in 240 initial snapshots. Final GREEN exit 0: all 400 desktop state snapshots fit without document/panel scrolling or clipped controls; all 13 existing DOM walkthrough/validation/caret/state checks also pass. Extra-short desktop windows use reduced spacing, never reduced font sizes. Narrow/mobile windows and extreme zoom retain natural accessible flow rather than clipping; they are not certified scroll-free. Approved installer colors and font family remain unchanged. The canvas viewport now defaults to 1280×720 rather than 1440×900.

### Approved decorative background
User supplied `{BF6C73BD-BA3B-4D7C-B261-47A29D685C10}.png` to identify the existing landing-page illustration and then authorized replacing the screenshot copy with its original resource. The source is `public/hero-dashboard.png`, referenced by `src/components/spa/LandingPage.tsx:198`. Despite the filename extension, the original contains JPEG data: 1344×768, 91,908 bytes. Embed those exact bytes with `data:image/jpeg`, without cropping, resizing or re-encoding the source. Preserve the existing CSS cover positioning for the decorative background. There are no remote image URLs or runtime asset files; the standalone preview works offline. The shared original and application landing page are unchanged. A regression check compares SHA-256 of the embedded image with the original, so a future source change requires refreshing the embedded copy.

The decorative card layer is isolated from content, ignored by assistive technology and pointer input, and blurred by 4px at 80% saturation. Use 8% opacity in light mode and 18% in dark mode. Keep all text, inputs, controls, palette tokens and type sizes unchanged. Clip only this decorative layer's blur at the card border, never the content. Image colors are a user-authorized illustration exception, not new application palette tokens. This prototype use does not establish commercial rights to the supplied reference.

Initial background browser RED exited 1 for missing artwork. The original-resource correction then observed RED exit 1 for the screenshot/original hash mismatch. Final GREEN exit 0: all 14 functional checks and 400 real-browser layout states pass, including exact original image bytes and actual MIME, successful image decoding, blur confined to artwork, sharp foregrounds, and primary/muted/body text retaining at least 4.5:1 contrast even against worst-case black/white image pixels. Read the captured light/dark welcome screens: `.screenshots/background-light.png` and `.screenshots/background-dark.png`. Set `CAPTURE_PREVIEW=1` when running the layout test to refresh those proof screenshots. All five desktop viewport checks still pass without scrolling. A temporary browser profile initially resisted removal on Windows in the previous iteration; its separate cleanup succeeded. The original-resource verification cleaned up normally, and no browser profile is retained.

## Scope
Target artboard: `01-wizard.html`. Operational installer packaging, database provisioning, SMTP and secure first-superadministrator creation remain a later, separately authorized implementation. The prototype does not bypass the application's onboarding guard. No environment files, database records or real email accounts are changed.
