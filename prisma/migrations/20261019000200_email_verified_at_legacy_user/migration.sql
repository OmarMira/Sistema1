-- T3: Phase B emailVerifiedAt + legacyUser transition. Dormant until T7 verification and production approval.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMPTZ(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "legacyUser" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "User_emailVerifiedAt_idx" ON "User"("emailVerifiedAt");
CREATE INDEX IF NOT EXISTS "User_legacyUser_idx" ON "User"("legacyUser");
