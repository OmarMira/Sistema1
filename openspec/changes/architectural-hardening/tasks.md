# Tasks: Architectural Hardening

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~1000-1600 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | 3 PRs (TS → Decimal → Postgres+Session) |
| Delivery strategy | auto-chain |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|------|------|-----------|-------|
| 1 | Enable strict TS, fix all errors | PR 1 | base=main |
| 2 | Float→Decimal schema + services | PR 2 | base=main; depends on PR 1 for tsc net |
| 3 | Postgres provider + session hashing | PR 3 | base=main; depends on PR 2 Decimal fields |

## PR 1 — TypeScript Enforcement

- [ ] 1.1 Create `next.config.mjs` with `typescript: { ignoreBuildErrors: false }`
- [ ] 1.2 Create root `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`
- [ ] 1.3 Run `npx tsc --noEmit`; catalog all errors by category
- [ ] 1.4 Fix type misuse, null safety, unused vars, logic errors, JSX prop types
- [ ] 1.5 `npx tsc --noEmit` exits 0; full test suite passes
- [ ] 1.6 Commit: `fix: enable TypeScript strict checking in build`

## PR 2 — Float to Decimal

- [ ] 2.1 Data export script: dump 12 Float fields across 5 models as JSON
- [ ] 2.2 Schema: change 12 Float → `Decimal` on BankAccount.balance/initialBalance, BankStatement.openingBalance/closingBalance/totalCredits/totalDebits, BankTransaction.amount, ReconciliationPeriod.statementBalance/bookBalance/difference, JournalLine.debit/credit
- [ ] 2.3 Service files: replace `+=` → `.plus()`, `Math.abs(x)` → `.abs()`, `Number(x)` → `.toNumber()`, `Math.round(x*100)/100` → `.toDecimalPlaces(2)` across 15 files (import, closing-engine, reconciliation, journal, onboarding, flow-aggregator, insight-engine, budget/engine, predictive-engine, ofx-parser, pdf-parser, entity-detector, rule-matching-engine, import-hash)
- [ ] 2.4 Remove monetary `Math.round` workarounds from service files + API routes
- [ ] 2.5 Data re-import script: JSON → Prisma Decimal
- [ ] 2.6 Update test assertions in 8 test files
- [ ] 2.7 Full test suite + `npx tsc --noEmit` pass
- [ ] 2.8 Commit(s): `feat: migrate Float fields to Decimal(18,2)`

## PR 3 — Postgres + Session Hashing

- [x] 3.1 Schema: provider `postgresql`; add `@db.Decimal(18,2)` to 12 Decimal fields; remove `@@index([token])` on Session (redundant with `@unique`)
- [x] 3.2 Remove PRAGMAs from `src/lib/db.ts`
- [ ] 3.3 Update `next.config.mjs` `serverExternalPackages` if needed
- [ ] 3.4 `prisma migrate dev --name init_postgres` — generate initial migration
- [ ] 3.5 Add `hashToken()` using `crypto.createHash('sha256')` in `src/lib/sessions.ts`
- [ ] 3.6 Modify `createSession`: store SHA-256(token), return raw token to client
- [ ] 3.7 Modify `getSessionUserId`: hash cookie token before DB lookup
- [ ] 3.8 Modify `destroySession`: hash token before DB delete
- [ ] 3.9 Invalidate existing sessions: delete rows where token is not 64-char hex
- [ ] 3.10 Update session tests for hash flow
- [ ] 3.11 Full test suite + `npx tsc --noEmit` pass
- [ ] 3.12 Commit(s): `feat: migrate to Postgres and hash session tokens`
