# Read-only bank activity API

`GET /api/dashboard/bank-activity` reads imported bank facts for the authorized company. Existing authentication and accounting-module entitlement guards run before database queries. A caller-supplied `companyId` never determines authorization.

## Select the scope

- `accountId` is optional. Without it, the first authorized account in ID order is selected. An unavailable or foreign account returns `404`.
- `year` is an optional integer from `1900` through `9999`. Its default comes from available statement dates. With no statements, the current year is only an empty-query fallback, not an inferred bank period.
- `cursor` is an optional transaction ID for the next page. Account and year must remain the same throughout pagination.
- Account and cursor strings must contain 1–200 characters when supplied. Invalid query values return `400`.

Accounts, statements, transaction counts and transaction rows remain company/account scoped. Transaction dates use the selected UTC calendar year. Import timestamps and journal posting dates do not determine the bank period.

## Response and pagination

The response contains the selected `account`, authorized `accounts`, available `years`, selected `year`, intersecting `statements`, `transactions`, `total`, `hasMore` and `nextCursor`.

Movements have deterministic date/ID order. Each response contains at most 500 movements. Follow `nextCursor` while `hasMore` is true; the total is not a 500-row cap. Consumers must not publish totals from an incomplete or inconsistent sequence of pages.

Saved account classification and reconciliation/ignored flags are returned as source facts. Unclassified or unreconciled movements still represent bank activity. Original statement opening/closing amounts and their dates are separate from filtered movement subtotals. Cross-year statements alone do not establish a selected year's opening balance.

This endpoint never reads or writes journals, applies bank rules, changes stored dates, posts entries, reconciles movements, or forces balances to match. It leaves the existing `/api/dashboard/financial` contract unchanged.

## Isolated check

```sh
node node_modules/vitest/vitest.mjs run --config vitest.bank-activity.config.ts tests/api/bank-activity.test.ts
```

The dedicated configuration disables `.env` loading and database setup. These API checks mock Prisma, company context and entitlement boundaries; they do not connect to an operative database or prove a deployed authentication flow.
