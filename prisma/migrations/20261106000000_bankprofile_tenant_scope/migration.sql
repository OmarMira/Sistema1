-- S1 (Wave 5): BankProfile rows become company-scoped.
--
-- Before this migration "BankProfile"."bankId" was globally unique
-- ("BankProfile_bankId_key", created by 0_init). Any tenant whose uploaded PDF
-- reached the LLM auto-create/heal path therefore created or overwrote the one
-- profile every other tenant parsed with.
--
-- After this migration a profile either belongs to one company
-- ("companyId" NOT NULL) or is a GLOBAL read-only seed ("companyId" NULL) that
-- every tenant may read but no write path ever targets. Lookups resolve
-- company-scoped first and fall back to the global seed.
--
-- Every statement is guarded: tests run `prisma db push` (tests/global-setup.ts)
-- while deploys run `prisma migrate deploy`, so the same database can arrive here
-- with the column, the FK or the indexes already present.

-- 1. Additive tenant column. Existing rows are intentionally left NULL: under the
--    new model they become global read-only seeds (the previous shared behaviour),
--    which is exactly the state every tenant could already rely on.
ALTER TABLE "BankProfile" ADD COLUMN IF NOT EXISTS "companyId" TEXT;

-- 2. Tenant relation. Company deletion removes that company's learned profiles;
--    global seeds (companyId NULL) are untouched.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BankProfile_companyId_fkey'
  ) THEN
    ALTER TABLE "BankProfile"
      ADD CONSTRAINT "BankProfile_companyId_fkey"
      FOREIGN KEY ("companyId") REFERENCES "Company"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 3. Swap the global unique for the per-tenant one.
DROP INDEX IF EXISTS "BankProfile_bankId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "BankProfile_bankId_companyId_key"
  ON "BankProfile"("bankId", "companyId");

-- 4. Supporting index for company-scoped reads.
CREATE INDEX IF NOT EXISTS "BankProfile_companyId_idx" ON "BankProfile"("companyId");
