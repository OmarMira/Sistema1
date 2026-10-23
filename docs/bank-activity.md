# Read actual bank activity without changing accounting records

**Actividad bancaria / Bank activity** shows imported bank movements, separately from saved classification and reconciliation work. It never creates journals, applies bank rules, changes dates, reconciles rows, or adjusts balances.

## Read the page in this order

1. Select the company, bank account and movement year. The default year comes from available statement dates, not the import date or today's year.
2. Read **Statement balances** and their dates. Opening comes from the first available statement; closing comes from the latest available statement. Neither is editable on this page.
3. Read **Money in**, **Money out**, and their difference. These are bank flows, not accounting revenue, deductible expenses, or business profit.
4. Use dates, months, saved classifications or reconciliation status to investigate a subset. Reset restores all available movements for this account/year.
5. Expand classification details or the movement list when you need the underlying amounts and bank descriptions.

## What the numbers mean

| Display | Meaning |
| --- | --- |
| Imported count | All loaded movements for the selected account and year, not all company accounts |
| Included count | Movements satisfying the current filters |
| Money in / out | All included credits / debits, regardless of classification or reconciliation |
| Unassigned | No saved account classification; the movement still contributes to bank totals |
| Pending reconciliation | A review state, not evidence of missing bank activity or an error |
| Source balances | Original statement amounts and dates; never recalculated from a category/status subset |
| Monthly bank balance | The closing amount from that month's last available statement, with its actual date |
| Fees | Only separately identified when a bank-fee classification has been saved; absence of classification is not a verified zero |

Bank fees, when present, are already included in money out. Do not add them again. Ignored movements still appear in this bank-facts view and are counted separately: omitting them in another accounting process does not erase their bank effect. Rule suggestions are not treated as saved classifications.

## Consistent system appearance

The page and chart surfaces use the same shared `Card`/`CardContent` components and semantic theme colors as the main Panel, in both light and dark modes. Bank activity does not define a separate page palette. The movement-year selector sizes to its four-digit text and dropdown affordance instead of expanding to fill an account-sized column; its label and year-selection behavior are unchanged.

## Charts and indicators

The page retains ten interactive charts: monthly inflows/outflows, original statement closings, outgoing and incoming classifications, net flow, the largest outgoing classification, the three largest outgoing and incoming classifications, average daily balances, and reconciled/pending movement counts. Each has a plain-language description and tooltips; the monthly table and classification detail preserve readable amounts without relying on colors.

Flow, category and review charts follow the current filters. Statement closings and daily averages always use complete source data, never a category/status subtotal. Missing source closings remain gaps, not zero; averages require verified balances and complete month boundaries. Top classifications mean the largest saved categories, not inferred recurring expenses or guessed payment platforms. Unassigned movements remain visible in every applicable chart.

Additional indicators show included movement count, incoming/outgoing counts, reconciliation percentage, and the largest incoming/outgoing movement. They describe this query, not profitability. An empty selection hides financial charts and shows the explicit no-match explanation while retaining original statement balances. There is no invented minimum balance, tax conclusion, investment recommendation, or claim that bank flows are business profit.

## Missing, partial or inconsistent information

- No matching movements produces an explicit empty-selection message, not a claim of zero annual activity.
- Invalid date order produces a validation message.
- No imports and failed loading have different messages. A failed page or inconsistent pagination never publishes partial totals.
- Each HTTP response is bounded to 500 movements; the client follows the cursor until every advertised movement is loaded. Duplicate rows, repeated cursors or changed counts fail closed instead of displaying a partial bank total.
- The server scopes account, statements, counts and movements to the authorized company. Accounts and currencies are never silently combined. The existing accounting dashboard endpoint is unchanged.
- Statement continuity and opening + signed movements = closing are checked using integer cents. Missing months, overlapping statements, cross-year opening ambiguity or mismatching figures produce a notice; original amounts remain visible and no balancing entry is created.
- A statement crossing the selected year's boundary cannot establish that year's opening from its opening amount alone. The page does not invent one.
- There is no built-in safety-balance threshold or business/investment recommendation based on incomplete classifications.

## CSV files

**Export movements CSV** exports exactly the included movements. For compatibility the filename remains `transacciones_clasificadas.csv`, but the file includes unassigned movements too. The existing columns remain `fecha,descripcion,monto,tipo,cuenta_contable,conciliado,categoria,mes`; `monto` is a positive magnitude and `tipo` defines direction. Unclassified category cells now truthfully say `Sin asignar` instead of calling every unknown movement an expense.

**Export monthly summary CSV** uses the entire loaded account/year, regardless of filters, and is disabled when statement balances cannot be verified. Existing column order and filename remain. An unavailable average is left blank rather than invented; a source-derived balance must not be confused with a filtered cash-flow subtotal. Both files are supporting working information for a human reviewer, not official tax filings.

## Safe verification

```sh
node node_modules/vitest/vitest.mjs run --config vitest.bank-activity.config.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

The dedicated config disables `.env` loading, setup and global setup. UI HTTP and API database calls are mocked; the existing monthly aggregation tests are pure. Do not replace it with the default Vitest config: that configuration can initialize an actual database. DOM checks are not a real-browser visual inspection or a production build.

See the [read-only API contract](bank-activity-api.md) and [observed verification, proof limits and delivery units](bank-activity-verification.md).
