-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('active', 'forgotten');

-- CreateEnum
CREATE TYPE "ConfidenceLevel" AS ENUM ('certain', 'tentative', 'uncertain');

-- CreateTable
CREATE TABLE "MemoryItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "confidence" "ConfidenceLevel" NOT NULL DEFAULT 'tentative',
    "status" "MemoryStatus" NOT NULL DEFAULT 'active',
    "forgetReason" TEXT,
    "sourceAuthor" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceObservedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryVersion" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Relationship" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Relationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contradiction" (
    "id" TEXT NOT NULL,
    "itemAId" TEXT NOT NULL,
    "itemBId" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Contradiction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvolutionLink" (
    "id" TEXT NOT NULL,
    "supersededId" TEXT NOT NULL,
    "supersededById" TEXT NOT NULL,
    "linkType" TEXT NOT NULL DEFAULT 'supersedes',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvolutionLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraceabilityLog" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "details" JSONB NOT NULL,

    CONSTRAINT "TraceabilityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfidenceLog" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "previousLevel" "ConfidenceLevel" NOT NULL,
    "newLevel" "ConfidenceLevel" NOT NULL,
    "reason" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfidenceLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemoryItem_companyId_idx" ON "MemoryItem"("companyId");

-- CreateIndex
CREATE INDEX "MemoryItem_type_idx" ON "MemoryItem"("type");

-- CreateIndex
CREATE INDEX "MemoryItem_status_idx" ON "MemoryItem"("status");

-- CreateIndex
CREATE INDEX "MemoryItem_companyId_type_idx" ON "MemoryItem"("companyId", "type");

-- CreateIndex
CREATE INDEX "MemoryItem_companyId_status_idx" ON "MemoryItem"("companyId", "status");

-- CreateIndex
CREATE INDEX "MemoryVersion_itemId_idx" ON "MemoryVersion"("itemId");

-- CreateIndex
CREATE INDEX "MemoryVersion_itemId_versionNumber_idx" ON "MemoryVersion"("itemId", "versionNumber");

-- CreateIndex
CREATE INDEX "Relationship_sourceId_idx" ON "Relationship"("sourceId");

-- CreateIndex
CREATE INDEX "Relationship_targetId_idx" ON "Relationship"("targetId");

-- CreateIndex
CREATE INDEX "Relationship_sourceId_targetId_idx" ON "Relationship"("sourceId", "targetId");

-- CreateIndex
CREATE INDEX "Contradiction_itemAId_idx" ON "Contradiction"("itemAId");

-- CreateIndex
CREATE INDEX "Contradiction_itemBId_idx" ON "Contradiction"("itemBId");

-- CreateIndex
CREATE INDEX "Contradiction_resolved_idx" ON "Contradiction"("resolved");

-- CreateIndex
CREATE INDEX "EvolutionLink_supersededId_idx" ON "EvolutionLink"("supersededId");

-- CreateIndex
CREATE INDEX "EvolutionLink_supersededById_idx" ON "EvolutionLink"("supersededById");

-- CreateIndex
CREATE INDEX "TraceabilityLog_itemId_idx" ON "TraceabilityLog"("itemId");

-- CreateIndex
CREATE INDEX "TraceabilityLog_itemId_timestamp_idx" ON "TraceabilityLog"("itemId", "timestamp");

-- CreateIndex
CREATE INDEX "ConfidenceLog_itemId_idx" ON "ConfidenceLog"("itemId");

-- CreateIndex
CREATE INDEX "ConfidenceLog_itemId_changedAt_idx" ON "ConfidenceLog"("itemId", "changedAt");

-- AddForeignKey
ALTER TABLE "MemoryItem" ADD CONSTRAINT "MemoryItem_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryVersion" ADD CONSTRAINT "MemoryVersion_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Relationship" ADD CONSTRAINT "Relationship_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Relationship" ADD CONSTRAINT "Relationship_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contradiction" ADD CONSTRAINT "Contradiction_itemAId_fkey" FOREIGN KEY ("itemAId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contradiction" ADD CONSTRAINT "Contradiction_itemBId_fkey" FOREIGN KEY ("itemBId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvolutionLink" ADD CONSTRAINT "EvolutionLink_supersededId_fkey" FOREIGN KEY ("supersededId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvolutionLink" ADD CONSTRAINT "EvolutionLink_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraceabilityLog" ADD CONSTRAINT "TraceabilityLog_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfidenceLog" ADD CONSTRAINT "ConfidenceLog_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "MemoryItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
