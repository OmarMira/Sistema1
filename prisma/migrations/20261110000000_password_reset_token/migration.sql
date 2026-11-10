-- Superadministrator password recovery (feat/superadmin-password-recovery).
-- New single-use password reset token table, modelled on IdentityChallenge
-- (prisma/schema.prisma IdentityChallenge) but scoped per User and storing only
-- the SHA-256 token digest. One outstanding token per user: re-issuing from
-- forgot-password deletes the previous row (or relies on the unique userId).
CREATE TABLE "PasswordResetToken" (
  "id" UUID PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL CHECK ("tokenHash" ~ '^[a-f0-9]{64}$'),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("userId")
);
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
CREATE INDEX "PasswordResetToken_tokenHash_idx" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");
