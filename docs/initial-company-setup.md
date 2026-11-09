# Initial company setup without a global opening balance

The company setup wizard no longer asks for one cash/bank balance for the whole company. A company may have several bank accounts; their statement balances belong to those individual accounts, not to a single company-wide capital contribution.

## Current application

The wizard has five steps: company, fiscal period, chart of accounts, tax information, and finish. Its final screen explains that bank balances are incorporated during statement import, with a warning that missing or unreadable information needs review.

The completion request retains company name, currency, fiscal year/month and period type, but omits `initialCashBalance`. This UI path therefore does not request an opening cash/equity entry. Existing stored balances, statement importing and the `isOnboardingComplete` startup guard are unchanged. The backend's optional opening-balance parameter remains compatible with other callers; this change does not remove that API capability or migrate existing records.

## Installer preview

`design/instalador/01-wizard.html` is still a standalone simulation, not an operational installer. Its five steps collect fictional company name/currency, fiscal year/month/period, and initial superadministrator full name/email, followed by a review. Email/code confirmation, space preparation and the displayed superadministrator role are explicitly simulated. No real user, permissions, database or opening entry is created.

The application's fresh-start path now mounts `InstallationWizard` from `BootstrapPage`. It requests a real registration code, verifies it through the existing endpoint, completes company/fiscal onboarding and confirms the saved company through `/api/auth/me` before hydrating the session. The standalone HTML above remains a design reference, not that operational controller. The wizard captures company legal name, currency, fiscal year/month/period type (no opening balance), and the initial administrator first/last name, real email, and secure password confirmation. Retry completes onboarding without re-registering; back/retry does not duplicate accounts. No password/code is stored in localStorage.

Passwords and verification codes remain in component memory only. Existing application preferences and active-company persistence remain unchanged; no new credential persistence is introduced.

## Checks without a database

```bash
node design/instalador/preview.test.cjs
node node_modules/vitest/vitest.mjs run --config vitest.onboarding.config.ts
node node_modules/vitest/vitest.mjs run --config vitest.packaging.config.mts
```

The opt-in Vitest config runs the onboarding form and existing page-gate component tests without application global setup. Network requests and auth state are mocked; production database tests, SMTP delivery and actual installation are not exercised. The preview uses jsdom: passing its tests does not certify visual rendering or native browser keyboard behavior.
