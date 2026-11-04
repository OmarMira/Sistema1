-- S19(f): denormalized "BankTransaction"."companyId" (defense in depth).
--
-- Every transaction already belongs to a company transitively
-- (BankTransaction → BankStatement → BankAccount → Company). Carrying the
-- tenant key on the row removes that join from hot paths (review queue,
-- dashboards) and makes tenant filters explicit at the table that holds the
-- data. Hot queries are NOT rewritten in this unit: the column is additive and
-- never an authority — statement → account stays the source of truth.
--
-- The review-queue index from S19(d) lives here because it needs this column.
-- Additive only; the backfill is idempotent (WHERE "companyId" IS NULL).

-- 1. Column (nullable: rows written by older builds predate the backfill).
ALTER TABLE "BankTransaction" ADD COLUMN IF NOT EXISTS "companyId" TEXT;

-- 2. Backfill through statement → account.
UPDATE "BankTransaction" bt
SET "companyId" = ba."companyId"
FROM "BankStatement" bs
JOIN "BankAccount" ba ON bs."bankAccountId" = ba."id"
WHERE bt."statementId" = bs."id"
  AND bt."companyId" IS NULL;

-- 3. Indexes: tenant scope + the review-queue path (tenant, GL account, date).
CREATE INDEX IF NOT EXISTS "BankTransaction_companyId_idx" ON "BankTransaction"("companyId");
CREATE INDEX IF NOT EXISTS "BankTransaction_companyId_glAccountId_date_idx"
  ON "BankTransaction"("companyId", "glAccountId", "date");
