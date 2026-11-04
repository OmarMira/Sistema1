-- S5 (Wave 5): JournalLine amount invariants enforced by the DATABASE.
--
-- The accounting invariants for a journal line were only enforced in the HTTP
-- validation layer (src/lib/validations/journal.ts: non-negative debit/credit)
-- and "not positive on both sides" was not enforced anywhere. Any other write
-- path (services, reconciliation, imports, manual SQL) could therefore store a
-- line that is both a debit and a credit, or a negative amount — silently
-- breaking the ledger's arithmetic assumptions.
--
-- Prisma cannot model CHECK constraints, so this file is their only definition
-- and prisma/schema.prisma must NOT mirror them (a `db push` would fight them).
--
-- Every constraint is guarded with a pg_constraint lookup and added with
-- `IF NOT EXISTS` semantics: test runs apply `prisma db push`
-- (tests/global-setup.ts) while deploys run `prisma migrate deploy`, so the same
-- database can arrive here with the constraints already present.
--
-- Added as a single DO block so the whole migration is ONE statement: the test
-- that proves the constraints exist (tests/wave5/fiscal-overlap-race.test.ts)
-- applies this exact file through $executeRawUnsafe after a `db push` that
-- cannot create CHECKs, and the driver refuses multi-statement scripts.

DO $$
BEGIN
  -- 1. A line is never positive on both sides: debit XOR credit.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JournalLine_not_both_positive'
  ) THEN
    ALTER TABLE "JournalLine"
      ADD CONSTRAINT "JournalLine_not_both_positive"
      CHECK ("debit" = 0 OR "credit" = 0);
  END IF;

  -- 2. A debit is never negative.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JournalLine_debit_non_negative'
  ) THEN
    ALTER TABLE "JournalLine"
      ADD CONSTRAINT "JournalLine_debit_non_negative"
      CHECK ("debit" >= 0);
  END IF;

  -- 3. A credit is never negative.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JournalLine_credit_non_negative'
  ) THEN
    ALTER TABLE "JournalLine"
      ADD CONSTRAINT "JournalLine_credit_non_negative"
      CHECK ("credit" >= 0);
  END IF;
END $$;
