# Delta Spec: Architectural Hardening

Cross-cutting infrastructure hardening across three chained PRs. No domain behavior changes — existing domain specs are unaffected.

---

## PR 1 — TypeScript Enforcement

### ADDED Requirements

#### Requirement: Build MUST fail on TypeScript errors

The build system MUST NOT suppress TypeScript errors. `typescript.ignoreBuildErrors` in Next.js config SHALL be removed.

#### Scenario: Remove ignoreBuildErrors

- GIVEN `next.config.mjs` contains `ignoreBuildErrors: true`
- WHEN the config is edited to remove that property
- THEN `tsc --noEmit` SHALL exit 0 with zero errors

#### Scenario: Fix all existing TS errors

- GIVEN a codebase with latent TS errors (previously suppressed)
- WHEN `ignoreBuildErrors` is removed and `tsc --noEmit` is run
- THEN all errors MUST be fixed without using `any` or `@ts-ignore`
- AND `tsc --noEmit` SHALL pass with 0 errors

#### Scenario: Full build passes

- GIVEN all TS errors are fixed
- WHEN `npm run build` executes
- THEN the build MUST succeed

#### Scenario: Tests unaffected

- GIVEN all TS errors are fixed
- WHEN all 33 test files (171 tests) are run
- THEN they MUST all pass

---

## PR 2 — Float to Decimal

### ADDED Requirements

#### Requirement: Monetary fields MUST use Decimal(18,2)

All monetary fields SHALL be stored as `Decimal @db.Decimal(18,2)` in Prisma schema.

#### Scenario: Schema migration

- GIVEN the Prisma schema with Float fields on BankAccount, BankStatement, BankTransaction, ReconciliationPeriod, and JournalLine
- WHEN each Float field is changed to `Decimal @db.Decimal(18,2)`
- THEN all 12 monetary fields MUST be of type Decimal

Affected fields: `BankAccount.balance`, `BankAccount.initialBalance`, `BankStatement.openingBalance`, `BankStatement.closingBalance`, `BankStatement.totalCredits`, `BankStatement.totalDebits`, `BankTransaction.amount`, `ReconciliationPeriod.statementBalance`, `ReconciliationPeriod.bookBalance`, `ReconciliationPeriod.difference`, `JournalLine.debit`, `JournalLine.credit`.

#### Scenario: Service files use Decimal math

- GIVEN service files that compute with monetary fields
- WHEN Float arithmetic is replaced with `Prisma.Decimal` operations
- THEN `tsc --noEmit` SHALL pass
- AND all 33 test files SHALL pass

#### Scenario: Data backup before migration

- GIVEN 302 existing bank transactions in production
- BEFORE the schema migration
- WHEN a data export script runs
- THEN all 302 transactions MUST be exported as JSON backup

#### Scenario: No Math.round float-drift workarounds

- GIVEN the codebase previously used `Math.round(x * 100) / 100` for monetary rounding
- AFTER all Decimal migrations are complete
- WHEN searching for `Math.round` in monetary contexts
- THEN no such float-drift workarounds SHALL remain

(Scope: rounding used for monetary precision in reports, aggregations, and journal validation. `Math.round` for non-monetary purposes — confidence scores, percentages, pixel coordinates — MAY remain.)

#### Scenario: Monetary values have exactly 2 decimal places

- GIVEN Decimal(18,2) columns in the database
- WHEN any monetary value is stored or retrieved
- THEN it MUST have exactly 2 decimal places with no floating-point drift

---

## PR 3 — Postgres Migration + Session Hashing

### ADDED Requirements

#### Requirement: Prisma provider MUST be postgresql

The Prisma datasource provider is `postgresql`.

#### Scenario: Provider switch

- GIVEN `prisma/schema.prisma` with `provider = "postgresql"`
- WHEN the provider is validated
- THEN `prisma migrate dev` MUST generate an initial migration
- AND PRAGMAs in `src/lib/db.ts` MUST be removed

#### Scenario: serverExternalPackages updated

- GIVEN `next.config.mjs` lists `serverExternalPackages`
- WHEN the Prisma provider changes
- THEN the config SHALL be updated if needed

#### Requirement: Session tokens MUST be stored hashed with SHA-256

`src/lib/sessions.ts` SHALL hash session tokens with SHA-256 before writing to DB. Lookup SHALL query by hash, not by plaintext token.

#### Scenario: Session creation hashes token

- GIVEN a user logs in successfully
- WHEN `createSession(userId)` is called
- THEN the raw token MUST be returned to the client
- AND `SHA-256(rawToken)` MUST be stored in the DB `token` column

#### Scenario: Session lookup queries by hash

- GIVEN a request with a session cookie
- WHEN `getSessionUserId(request)` is called
- THEN the token SHALL be extracted from cookie/header
- AND the DB SHALL be queried using `SHA-256(token)`
- AND the matching session SHALL be returned

#### Scenario: Session destroy uses hash

- GIVEN a session token from cookie/header
- WHEN `destroySession(token)` is called
- THEN the DB SHALL be queried by `SHA-256(token)`
- AND the matching session SHALL be deleted

#### Scenario: Existing sessions invalidated

- GIVEN existing sessions stored as plaintext tokens
- WHEN PR 3 is deployed
- THEN all existing sessions MUST be invalidated
- AND users MUST re-login to obtain a new hashed session

#### Scenario: Login flow end-to-end

- GIVEN valid credentials
- WHEN the login endpoint is called
- THEN a session MUST be created with hashed token
- AND subsequent requests with the returned token SHALL be authenticated
- AND `tsc --noEmit` SHALL pass
- AND all 33 test files SHALL pass
