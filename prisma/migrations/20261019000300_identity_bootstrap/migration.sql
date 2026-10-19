-- T4: Phase B protected one-time bootstrap of the first super_admin. Dormant until production approval.
CREATE TABLE IF NOT EXISTS "IdentityBootstrap" (
  "id" UUID PRIMARY KEY,
  "tokenDigest" TEXT NOT NULL CHECK ("tokenDigest" ~ '^[a-f0-9]{64}$'),
  "consumedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "IdentityBootstrap_consumedAt_idx" ON "IdentityBootstrap"("consumedAt");
