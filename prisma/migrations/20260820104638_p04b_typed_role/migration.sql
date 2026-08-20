-- P04-B typed-role migration
-- Atomicity: Prisma 6.x does NOT wrap migrations in a transaction on PostgreSQL
-- by default (Prisma blog 2022-02-03). Explicit BEGIN/COMMIT provide the
-- required atomicity. All statements are transaction-safe on PG 17.4:
-- no ALTER TYPE ... ADD VALUE, no CREATE INDEX CONCURRENTLY, no CREATE DATABASE.
--
-- Original defaults captured from git history (0_init), pre-migration:
--   User.role          = 'company_admin'::text
--   CompanyMember.role = 'company_admin'::text

BEGIN;

CREATE TYPE "PlatformRole" AS ENUM ('user', 'super_admin');
CREATE TYPE "CompanyRole" AS ENUM ('company_admin', 'employee', 'viewer');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "User"          WHERE "role" NOT IN ('user','super_admin','company_admin','employee','viewer')) THEN
    RAISE EXCEPTION 'P04_UNKNOWN_ROLE_DATA';
  END IF;
  IF EXISTS (SELECT 1 FROM "CompanyMember" WHERE "role" NOT IN ('company_admin','employee','viewer','super_admin')) THEN
    RAISE EXCEPTION 'P04_UNKNOWN_ROLE_DATA';
  END IF;
END $$;

UPDATE "User"          SET "role" = 'user'          WHERE "role" IN ('company_admin', 'employee', 'viewer');
UPDATE "CompanyMember" SET "role" = 'company_admin' WHERE "role" = 'super_admin';

ALTER TABLE "User"          ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "CompanyMember" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User"          ALTER COLUMN "role" TYPE "PlatformRole" USING ("role"::text::"PlatformRole");
ALTER TABLE "CompanyMember" ALTER COLUMN "role" TYPE "CompanyRole"   USING ("role"::text::"CompanyRole");
ALTER TABLE "User"          ALTER COLUMN "role" SET DEFAULT 'user'::"PlatformRole";
ALTER TABLE "CompanyMember" ALTER COLUMN "role" SET DEFAULT 'company_admin'::"CompanyRole";

COMMIT;