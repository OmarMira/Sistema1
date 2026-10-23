# Banking verification and delivery units

This record covers the local banking changes after published baseline `98a0bb3bc5576f0a24a718779c20373c6e0f0b64`. The authorized destination is `https://github.com/OmarMira/Sistema1.git`, branch `fix/confirmed-registration-from-b30`. It does not authorize a pull request, merge, force push, installation, or accounting-data mutation.

## Coherent commit boundaries

The existing delivery strategy is `feature-branch-chain`: retain separate reviewable work units on the feature branch. This publication does not create PRs or combine the accumulated branch into a native-review candidate.

| Commit | Complete work unit |
| --- | --- |
| `f1a8392d4c776cac1f9af0692638e65f73b2a09d` | Audited abandonment of the historical registration review, explicitly not code approval |
| `1c82c1c9bef297d3f2f73385a0eff98feabd08e0` | Existing consolidation history and generated Next.js agent guidance; no filesystem deletion performed by this commit |
| `0eb1d79c869e5b82c11ce174dd1bbc5d4c0b3d5d` | Reconciliation periods, source balances, cutoffs and preparation explanations, with tests and documentation |
| `50569a14c873267b5834bb7f4de40cf84bd0e094` | Tenant-scoped read-only bank query endpoint, its isolated API tests/configuration and API documentation |
| `d18d6aa48e19bdd72db2728dd9980b7e39dc1d65` | Real bank flows and source balances, ten informative charts, shared Panel styling, content-sized year control, UI tests and usage documentation |

Reconciliation and API units each contain 366 authored diff lines. The dashboard unit is larger (2,426 additions plus deletions): it replaces the coupled old screen and keeps its data model, charts, translations, tests and usage documentation together. Splitting that unit by file type would leave incomplete imports or an unusable intermediate screen; no tests or readable code were omitted to meet a line target. The commit containing this record only closes documentation and records historical commit identities.

## Observed checks

- Final isolated bank suite: **28/28** (10 UI, 4 mocked API, 14 existing pure monthly tests).
- Final isolated reconciliation suite: **11/11**. Total: **39/39**.
- The two new style/year rules were observed RED, then GREEN. TypeScript, scoped ESLint and diff whitespace checks passed. A prior broader reconciliation lint run retains its known non-failing TanStack Virtual/compiler warning; Vite future-loader and line-ending warnings are not hidden.
- Separate independent verification of bank source scope, paging, account/company entitlement and original chart behavior passed S1–S4, with 4/4 API tests. The subsequent style-only correction did not change that endpoint, its guards, the bank model or CSV algorithms.
- Real isolated Chrome, at 1440 px dark desktop and 390 px light mobile, rendered all ten SVG charts. All 25 card surfaces matched the unmodified shared Panel `Card` in computed background, foreground, border and corner radius. The year control measured **77.16 px** at both sizes, without stretching to account width.
- Browser checks covered all five reference amounts, no horizontal page overflow, an empty reconciliation selection, reset, English copy and no unhandled runtime exceptions. Captures were inspected, not just a success flag.
- The archived published baseline and candidate CSV download probes each passed; movement and monthly-summary filenames, MIME and exact bytes matched for the representative already-correct classified/full-month case. The intended unassigned-label/source-scope corrections are documented separately. The final theme correction left those export algorithms and handlers unchanged.

## Proof boundaries and retained failures

Browser traffic was simulated against the actual components and styles in a new Chrome profile. No private browser session or operative database was used for that check; it is not a deployed authenticated end-to-end test or production build.

A separate guarded read-only PostgreSQL comparison established 12 statements and 302 movements for the available 2025 bank period: opening 32,615.55; inflows 104,740.23; outflows 127,703.08; net change -22,962.85; closing 9,652.70. No entries, dates, rules or bank records were changed.

Earlier harness failures and the first independent worker timeout remain recorded as failures; they are not approvals. The explicitly authorized revised candidate subsequently passed independent and browser checks. No failed worker was represented as a result it never produced.

The committed dashboard work unit was assessed against its immediate API parent: native risk **medium**, `reviewDue: false`, self-verification required and observed. Earlier untracked-scope assessments were unavailable and never counted as approval. No native review transaction was started, and no native code-approval receipt is claimed.

Private backups, environment files, dependency trees, browser profiles and local proof caches are intentionally excluded from Git. Remote publication is verified separately by the exact branch SHA; a document cannot contain its own commit hash.
