-- Portable owner-verified bootstrap recovery.
-- Not executed against any real database by this change: the application reads
-- and writes these tables through parameterized raw SQL so the recovery path
-- does not depend on client regeneration. `prisma generate` / `migrate deploy`
-- remain operator actions.

CREATE TABLE "BootstrapRecoveryChallenge" (
    "fileDigest" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tokenDigest" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BootstrapRecoveryChallenge_pkey" PRIMARY KEY ("fileDigest")
);

CREATE INDEX "BootstrapRecoveryChallenge_expiresAt_idx" ON "BootstrapRecoveryChallenge"("expiresAt");

CREATE TABLE "BootstrapRecoveryProvenance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "sourceDigest" TEXT NOT NULL,
    "credentialDigest" TEXT NOT NULL,
    "sourceSealAlgorithm" TEXT NOT NULL,
    "provenance" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BootstrapRecoveryProvenance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BootstrapRecoveryProvenance_companyId_idx" ON "BootstrapRecoveryProvenance"("companyId");
CREATE INDEX "BootstrapRecoveryProvenance_createdAt_idx" ON "BootstrapRecoveryProvenance"("createdAt");

-- Single-slot cross-request lease: serializes the whole portable recovery
-- workflow (two different files must never prepare/restore concurrently).
CREATE TABLE "BootstrapRecoveryLock" (
    "id" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "BootstrapRecoveryLock_pkey" PRIMARY KEY ("id")
);
