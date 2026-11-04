-- Phase A artifact only. Never apply to operative PostgreSQL without approval.
-- No User/Company/CompanyMember/Session changes and no existing-data backfill.
CREATE TABLE "IdentityPendingRegistration" (
  "id" UUID PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "confirmedAt" TIMESTAMPTZ(3),
  "resends" INTEGER NOT NULL DEFAULT 0 CHECK ("resends" BETWEEN 0 AND 3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "IdentityPendingRegistration_expiresAt_idx" ON "IdentityPendingRegistration"("expiresAt");
CREATE TABLE "IdentityChallenge" (
  "id" UUID PRIMARY KEY,
  "subjectId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL CHECK ("purpose" IN ('VERIFICATION','RECOVERY')),
  "generation" INTEGER NOT NULL CHECK ("generation">0),
  "digest" TEXT NOT NULL CHECK ("digest" ~ '^[a-f0-9]{64}$'),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" BETWEEN 0 AND 5),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("subjectId","purpose")
);
CREATE INDEX "IdentityChallenge_digest_purpose_idx" ON "IdentityChallenge"("digest","purpose");
CREATE INDEX "IdentityChallenge_expiresAt_idx" ON "IdentityChallenge"("expiresAt");
CREATE TABLE "IdentityRateLimit" (
  "subject" TEXT NOT NULL CHECK ("subject" ~ '^[a-f0-9]{64}$'),
  "windowStart" TIMESTAMPTZ(3) NOT NULL,
  "attempts" INTEGER NOT NULL CHECK ("attempts">0),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY ("subject","windowStart")
);
CREATE INDEX "IdentityRateLimit_expiresAt_idx" ON "IdentityRateLimit"("expiresAt");
CREATE TABLE "IdentitySecurityEvent" (
  "id" UUID PRIMARY KEY,
  "action" TEXT NOT NULL CHECK ("action" IN ('verification_issued','verification_rejected','verification_confirmed','recovery_issued','recovery_consumed','delivery_ok','delivery_failed')),
  "subject" TEXT NOT NULL CHECK ("subject" ~ '^[a-f0-9]{64}$'),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "IdentitySecurityEvent_createdAt_idx" ON "IdentitySecurityEvent"("createdAt");
