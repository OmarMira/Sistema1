# Design: Architectural Hardening

## Technical Approach

Three independent PRs applied sequentially, each independently deployable:
1. **PR 1** — Enable `npx tsc --noEmit`, fix all errors in dependency order
2. **PR 2** — Replace 12 Prisma `Float` fields with `Decimal`, update 15 service files + tests
3. **PR 3** — Switch Prisma provider to `postgresql`, hash session tokens with SHA-256

No domain capability changes — pure infrastructure and type hardening.

---

## Architecture Decisions

### Decision: PR order — type safety before data migration

| Option | Tradeoff |
|--------|----------|
| Float→Decimal first | tsc errors on `Prisma.Decimal` vs `number` mismatches would be harder to isolate |
| TS enforcement first (chosen) | `npx tsc --noEmit` validates each Decimal change immediately in PR 2 |
| **Decision**: PR 1 → PR 2 → PR 3 | Clear dependency chain: types → data → provider |

### Decision: Decimal precision model

| Option | Tradeoff |
|--------|----------|
| `Decimal` only (no `@db`) | Works on SQLite (PR 2); PR 3 adds `@db.Decimal(18,2)` for Postgres |
| Both at once in PR 2 | Prisma rejects `@db.Decimal` on SQLite provider at validation time |
| **Decision**: PR 2 = `Decimal` (bare), PR 3 = add `@db.Decimal(18,2)` | PR 2 migration clean on SQLite |

### Decision: Session hashing algorithm

| Option | Tradeoff |
|--------|----------|
| bcrypt | CPU-heavy per lookup, no benefit over SHA-256 for opaque tokens |
| scrypt | Good but overkill — tokens are CSPRNG UUIDs, not passwords |
| **Decision**: SHA-256 | Fast, deterministic, no salt needed (tokens are already high-entropy) |

---

## Data Flow

### PR 2 — Float→Decimal data migration

```
Production DB (SQLite)
       │
       ▼  Before schema change
Export script ──→ dump.json (all 12 Float fields as string numbers)
       │
       ▼  After schema change
Import script ←── dump.json (Prisma Decimal accepts string|number)
       │
       ▼
Updated DB (SQLite, Decimal columns as TEXT)
```

### PR 3 — Session hashing

```
Client sends cookie/Bearer
       │
       ▼  getSessionToken() — unchanged
Token (plaintext UUID)
       │
       ▼  hashToken(token)
SHA-256 hex digest
       │
       ▼  lookup / delete by hash
Prisma: where { token: hashed }
```

---

## File Changes

### PR 1 — TypeScript Enforcement

| File | Action | Description |
|------|--------|-------------|
| `next.config.mjs` | Create | Add `typescript: { ignoreBuildErrors: false }` (explicit safe default) |
| `tsconfig.json` | Create (if missing) | Set `strict: true`, `noUncheckedIndexedAccess: true` |
| Various `src/**/*.ts` | Modify | Fix errors surfaced by `npx tsc --noEmit` |

**Expected error categories** (fix in dependency order):
1. **Type misuse** — `any` casts, missing return types, implicit `undefined`
2. **Null safety** — `object is possibly 'null'`, `object is possibly 'undefined'`
3. **Unused variables** — `_unused` or remove
4. **Logic errors** — unreachable code, type narrowing gaps
5. **JSX** — incorrect prop types, missing children

### PR 2 — Float → Decimal (12 fields, 5 models)

**Schema changes** (`prisma/schema.prisma`):

| Model | Field | Old Type | New Type (PR 2) | PR 3 Add |
|-------|-------|----------|-----------------|----------|
| `BankAccount` | `balance` | `Float` | `Decimal` | `@db.Decimal(18, 2)` |
| `BankAccount` | `initialBalance` | `Float` | `Decimal` | `@db.Decimal(18, 2)` |
| `BankStatement` | `openingBalance` | `Float` | `Decimal` | `@db.Decimal(18, 2)` |
| `BankStatement` | `closingBalance` | `Float` | `Decimal` | `@db.Decimal(18, 2)` |
| `BankStatement` | `totalCredits` | `Float` | `Decimal` | `@db.Decimal(18, 2)` |
| `BankStatement` | `totalDebits` | `Float` | `Decimal` | `@db.Decimal(18, 2)` |
| `BankTransaction` | `amount` | `Float` | `Decimal` | `@db.Decimal(18, 2)` |
| `ReconciliationPeriod` | `statementBalance` | `Float` | `Decimal` | `@db.Decimal(18, 2)` |
| `ReconciliationPeriod` | `bookBalance` | `Float` | `Decimal` | `@db.Decimal(18, 2)` |
| `ReconciliationPeriod` | `difference` | `Float` | `Decimal` | `@db.Decimal(18, 2)` |
| `JournalLine` | `debit` | `Float` | `Decimal` | `@db.Decimal(18, 2)` |
| `JournalLine` | `credit` | `Float` | `Decimal` | `@db.Decimal(18, 2)` |

**Data migration** — before schema change, run a script that:
1. Dumps all 302 `BankTransaction` records + related `BankAccount`, `BankStatement`, `ReconciliationPeriod`, `JournalLine` as JSON
2. Casts all Float values to `Number(amount).toFixed(2)` strings → Prisma `Decimal` accepts them
3. After schema change, re-import

**Service file transformations**:

| File | Path (actual) | Change pattern |
|------|--------------|----------------|
| `import.service.ts` | `src/lib/services/import.service.ts` | `openingBalance`, `closingBalance` params → `Decimal`; `totalCredits += amount` → `.plus()`; `recalculateBalances` → Decimal assignment |
| `closing-engine.ts` | `src/lib/services/closing-engine.ts` | `_sum.debit` / `_sum.credit` → `Decimal`, `diff` arithmetic → Decimal, `Math.abs(diff) > 0.01` → `.abs().gt(0.01)` |
| `reconciliation.service.ts` | `src/lib/services/reconciliation.service.ts` | `Math.abs(bankTx.amount)` → `bankTx.amount.abs()`; `splitSum` → Decimal sum; `> 0.01` → `.gt(0.01)` |
| `journal.service.ts` | `src/lib/services/journal.service.ts` | `reduce(sum + l.debit)` → Decimal sum; `Math.round(x*100)` → `.mul(100).floor()` equality |
| `onboarding.service.ts` | `src/lib/services/onboarding.service.ts` | `initialCashBalance?: number` → `Decimal`; `debit: initialCashBalance` → Decimal |
| `flow-aggregator.ts` | `src/lib/accounting/flow-aggregator.ts` | `debit +=` → `debit = debit.plus()`; `Math.round(x*100)/100` → `.toDecimalPlaces(2)` |
| `insight-engine.ts` | `src/lib/assistant/insight-engine.ts` | `net = debit - credit` → Decimal; `Math.round(...*100)/100` → `.toDecimalPlaces(2)` |
| `budget/engine.ts` | `src/lib/budget/engine.ts` | `_sum.debit` / `_sum.credit` → Decimal; `variancePercent` → Decimal ops |
| `predictive-engine.ts` | `src/lib/reconciliation/predictive-engine.ts` | `tx.amount - entryAmount` → Decimal; `Math.abs(x)` → `.abs()` |
| `ofx-parser.ts` | `src/lib/ofx-parser.ts` | `ParsedTransaction.amount: number` → `Decimal`; `parseFloat` → `new Decimal()` |
| `pdf-parser.ts` | `src/lib/pdf-parser.ts` | Same pattern — `ParsedTransaction.amount`, `openingBalance`, `closingBalance` → `Decimal` |
| `entity-detector.ts` | `src/lib/services/entity-detector.ts` | `tx.amount` comparison/sign → `.toNumber()` for logic (no monetary math) |
| `rule-matching-engine.ts` | `src/lib/services/rule-matching-engine.ts` | `Number(txValue)` → `txValue.toNumber()` for comparison operators |
| `import-hash.ts` | `src/lib/accounting/import-hash.ts` | `HashPayload.amount: number` → `Decimal`; `.toFixed(2)` → `.toFixed(2)` still works |

**Test file changes** (`tests/helpers/factories.ts` → all numeric literals `1000.0` stay as-is, Prisma coerces `number` → `Decimal`):

| Test file | Change |
|-----------|--------|
| `tests/services/import.service.test.ts` | `balance: 0` stays (Prisma coerces), `amount: 500.0` stays |
| `tests/services/reconciliation.service.test.ts` | `amount: 500.0` stays; `l.debit`/`l.credit` assertions → `toNumber()` |
| `tests/services/journal.service.test.ts` | `debit: 1000.0` stays (Prisma coerces) |
| `tests/services/closing-engine.test.ts` | `_sum: { debit: t.debit, credit: t.credit }` — mock returns stay `number` |
| `tests/services/budget-engine.test.ts` | Same — mock `_sum.debit` stays number |
| `tests/services/onboarding.test.ts` | `1000` stays (Prisma coerces) |
| `tests/ofx-parser.test.ts` | `amount: '500.00'` → parsed as `new Decimal('500.00')` |
| `tests/pdf-parser-fail-graceful.test.ts` | No Float assertions — likely unchanged |

**Live simulation effect** (`src/lib/services/conversational-service.ts`): No amount math in this file — works with `description`, `pattern`, `userInput`. **No changes needed.**

### PR 3 — Postgres + Session Hashing

**Schema changes**:

| Change | Detail |
|--------|--------|
| `datasource db.provider` | `sqlite` → `postgresql` |
| `datasource db.url` | `env("DATABASE_URL")` — no change |
| 12 Decimal fields | Add `@db.Decimal(18, 2)` |
| Remove SQLite PRAGMAs | Delete `PRAGMA journal_mode=WAL;` and `PRAGMA synchronous=NORMAL;` from `src/lib/db.ts` (lines 36–54) |
| Index differences | Postgres has no `@@index([token])` on unique fields — remove `@@index([token])` from `Session` model (redundant with `@unique`) |

**Session hashing** (`src/lib/sessions.ts`):

```typescript
// Add at top
import { createHash } from 'crypto';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// createSession — hash before store
token: hashToken(token)  // was: token

// getSessionUserId — hash before lookup
const token = hashToken(getSessionToken(request));  // was: raw token

// destroySession — hash before delete
where: { token: hashToken(token) }  // was: raw token
```

**Backward compatibility**: All existing sessions store plaintext tokens. After deploy, delete all rows with non-hex tokens (64-char SHA-256 hex vs 36-char UUID). This forces re-login — acceptable per proposal communication plan.

---

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Service Decimal math (sum, diff, abs, round) | Existing tests + `expect(result).toBeInstanceOf(Prisma.Decimal)` |
| Integration | Full Float→Decimal data round-trip | Dump → schema change → re-import → verify amounts match |
| Integration | Session hash create + lookup | `createSession` → `getSessionUserId` with same cookie → returns userId |
| E2E | Import flow after migration | Import OFX/CSV → Decimal stored → reconciled → JournalLine balances |

---

## Migration / Rollout

1. **PR 1**: Deploy, run `npx tsc --noEmit` in CI. No data migration.
2. **PR 2**: Run export script → deploy schema + services → run import script. Validate 302 tx amounts match.
3. **PR 3**: Set `DATABASE_URL` to Postgres → `npx prisma migrate deploy`. Delete old plaintext sessions. Force re-login (communicated ahead).

---

## Open Questions

- [ ] What is the actual `next.config.mjs` setup? File does not exist in working tree — may need creation rather than modification. Confirm whether `package.json` and `tsconfig.json` are also missing from the worktree (observed: both absent).
