---
Task ID: 1
Agent: Main Agent
Task: Implement all missing bank reconciliation features

Work Log:
- Added ReconciliationPeriod model to Prisma schema with fields: statementBalance, bookBalance, difference, status (open/completed/cancelled), transactionCount, notes
- Added reconciledAt and reconciliationPeriodId fields to BankTransaction model
- Pushed schema to database with db:push
- Rewrote GET /api/reconciliation with filters: status (all/unreconciled/reconciled), search, startDate, endDate, statementId
- Returns statements list, openPeriod, recentPeriods in response
- Enhanced POST /api/reconciliation to support createJournalEntries and periodId parameters
- Created POST /api/reconciliation/unreconcile endpoint for undo reconciliation
- Created POST /api/reconciliation/adjustment endpoint for creating adjusting journal entries
- Created POST/GET /api/reconciliation/periods endpoint for period management (start/complete/cancel) and history
- Enhanced POST /api/reconciliation/auto with amount-based matching against journal entries (matchByAmount)
- Added duplicate detection to /api/import (date+amount+description key matching, skips existing duplicates)
- Added 40+ new i18n keys in both EN and ES
- Complete rewrite of ReconciliationPage.tsx with all new features

Stage Summary:
- All 12 missing reconciliation features implemented
- 0 lint errors
- Dev server compiles successfully (GET / 200)
- New API routes: /unreconcile, /adjustment, /periods
- New DB model: ReconciliationPeriod
- New DB fields: BankTransaction.reconciledAt, BankTransaction.reconciliationPeriodId
