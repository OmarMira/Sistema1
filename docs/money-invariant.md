# Money invariant — how money is handled in AccountExpress

**Invariant: ALL money arithmetic MUST go through `src/lib/money.ts`. Raw `+`/`-`/`*` on money fields is forbidden.**

## The three layers

1. **Database**: every monetary column is `Decimal(18,2)` in PostgreSQL — exact storage. Never change this to float/double.
2. **Domain (services/routes)**: money values are converted to **integer cents** via `toCents()`, accumulated with `sumCents()`, compared with `compareCents()`, and converted back once with `fromCents()` at the write/response edge. Rounding is ROUND_HALF_UP (half-away-from-zero), applied once.
3. **API/UI**: money fields arrive as JS `number`. This is exact at cent level for any magnitude whose cent representation fits in 2^53-1 cents (≈ ±$90.07 trillion) — the `db.ts` result layer and `assertSafeCents()` throw a loud `RangeError` beyond that instead of drifting silently.

## Rules for new code

- Summing money? `sumCents(...rows.map(r => toCents(r.amount)))`, then `fromCents(total)` once.
- Comparing balances? `compareCents(a, b) === 0`.
- Rounding? `toCents()` already applies ROUND_HALF_UP. Never `toFixed`, never `Math.round(x * 100)` (binary pitfall: `Math.round(1.005 * 100) === 100`, exact half-up gives 101).
- Averages are quotients, not cents: guard with `assertSafeCents(toCents(v))` but do not round the reported value.
- Aggregates (`aggregate`/`groupBy`) bypass the `db.ts` result layer — normalize their `_sum` buckets through `toMoneyNumber()` yourself.

## Background

Floating-point drift in JavaScript (`0.1 + 0.2 !== 0.3`, 1000×$0.10 = 99.9999999999986) is the industry-condemned failure mode for accounting software. The `db.ts` result layer and the money module eliminate it: valid `Decimal(18,2)` data converts exactly, impossible magnitudes fail loudly. Established in the decimal-money-boundary feature (odd/tasks/decimal-money-boundary.md, commits a19eed3 + 410856c).
