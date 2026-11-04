-- Wave 6 / S3 — String -> Prisma enum for six low-cardinality columns.
--
-- Additive only: no row is rewritten, no column is dropped, no index is
-- redefined. Every enum label below is the exact string the column already
-- stores, verified against the write sites and the reference config:
--   * Company.entityType          -> 'INDIVIDUAL' | 'BUSINESS'
--                                    (zod enum in src/lib/validations/auth.ts)
--   * GlAccount.accountType       -> rules/account-types.json keys
--   * GlAccount.normalBalance     -> 'debit' | 'credit'
--                                    (chart of accounts + POST /api/accounts)
--   * BankTransaction.status      -> default 'posted'; 'pending_review' and
--                                    'suspense' are written by the import and
--                                    reconciliation-review paths, and
--                                    'unreviewed' / 'reconciled' / 'ignored' are
--                                    kept for legacy rows and the queue UI
--   * JournalEntry.status         -> 'draft' default; 'posted' / 'void' /
--                                    'pending_review' are written in code
--   * ReconciliationPeriod.status -> 'open' default; 'completed' / 'cancelled'
-- Because the label set is exactly the historical value set, the USING casts
-- below are total over existing data: this migration needs no data backfill and
-- cannot rewrite or lose a row. It fails closed (and rolls back) on a database
-- that holds a value outside the set, which is the point — the type is the
-- authority from now on.
--
-- API contract: Prisma serialises an enum to its string value, so every JSON
-- payload sent and received keeps the same strings it used before this change.

-- CreateEnum
CREATE TYPE "CompanyEntityType" AS ENUM ('INDIVIDUAL', 'BUSINESS');
CREATE TYPE "GlAccountAccountType" AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
CREATE TYPE "GlAccountNormalBalance" AS ENUM ('debit', 'credit');
CREATE TYPE "BankTransactionStatus" AS ENUM ('unreviewed', 'pending_review', 'reconciled', 'ignored', 'posted', 'suspense');
CREATE TYPE "JournalEntryStatus" AS ENUM ('draft', 'posted', 'void', 'pending_review');
CREATE TYPE "ReconciliationPeriodStatus" AS ENUM ('open', 'completed', 'cancelled');

-- AlterTable
-- The text default must be dropped before the type change (PostgreSQL cannot
-- cast a text default to the new enum automatically) and restored afterwards.
ALTER TABLE "Company"
  ALTER COLUMN "entityType" DROP DEFAULT,
  ALTER COLUMN "entityType" TYPE "CompanyEntityType" USING ("entityType"::"CompanyEntityType"),
  ALTER COLUMN "entityType" SET DEFAULT 'BUSINESS';

-- AlterTable
ALTER TABLE "GlAccount"
  ALTER COLUMN "accountType" TYPE "GlAccountAccountType" USING ("accountType"::"GlAccountAccountType"),
  ALTER COLUMN "normalBalance" TYPE "GlAccountNormalBalance" USING ("normalBalance"::"GlAccountNormalBalance");

-- AlterTable
ALTER TABLE "BankTransaction"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "BankTransactionStatus" USING ("status"::"BankTransactionStatus"),
  ALTER COLUMN "status" SET DEFAULT 'posted';

-- AlterTable
ALTER TABLE "JournalEntry"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "JournalEntryStatus" USING ("status"::"JournalEntryStatus"),
  ALTER COLUMN "status" SET DEFAULT 'draft';

-- AlterTable
ALTER TABLE "ReconciliationPeriod"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "ReconciliationPeriodStatus" USING ("status"::"ReconciliationPeriodStatus"),
  ALTER COLUMN "status" SET DEFAULT 'open';
