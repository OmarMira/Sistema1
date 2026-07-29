-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('PERSON', 'COMPANY', 'FINANCIAL_PRODUCT', 'PLATFORM', 'ASSET');

-- CreateEnum
CREATE TYPE "DecisionReason" AS ENUM ('COMPANY_KNOWLEDGE_CONFIRMED', 'COMPANY_KNOWLEDGE_UPDATED', 'COMPANY_KNOWLEDGE_MERGED', 'ENTITY_CONTEXT_MATCH', 'BANK_RULE_MATCH', 'LLM_SUGGESTION', 'MANUAL_OVERRIDE', 'FALLBACK_DEFAULT');

-- CreateTable
CREATE TABLE "CompanyKnowledge" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "EntityType" NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "aliases" TEXT[],
    "relationship" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "source" TEXT NOT NULL DEFAULT 'company_knowledge',
    "status" TEXT NOT NULL DEFAULT 'active',
    "mergedIntoId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyKnowledge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingApproval" (
    "id" TEXT NOT NULL,
    "knowledgeId" TEXT,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "PendingApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeAudit" (
    "id" TEXT NOT NULL,
    "knowledgeId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "beforeValue" JSONB,
    "afterValue" JSONB,
    "changedByUserId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "KnowledgeAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyKnowledge_companyId_idx" ON "CompanyKnowledge"("companyId");

-- CreateIndex
CREATE INDEX "CompanyKnowledge_type_idx" ON "CompanyKnowledge"("type");

-- CreateIndex
CREATE INDEX "CompanyKnowledge_canonicalName_idx" ON "CompanyKnowledge"("canonicalName");

-- CreateIndex
CREATE INDEX "PendingApproval_knowledgeId_idx" ON "PendingApproval"("knowledgeId");

-- CreateIndex
CREATE INDEX "PendingApproval_status_idx" ON "PendingApproval"("status");

-- CreateIndex
CREATE INDEX "KnowledgeAudit_knowledgeId_idx" ON "KnowledgeAudit"("knowledgeId");

-- CreateIndex
CREATE INDEX "KnowledgeAudit_timestamp_idx" ON "KnowledgeAudit"("timestamp");

-- AddForeignKey
ALTER TABLE "CompanyKnowledge" ADD CONSTRAINT "CompanyKnowledge_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyKnowledge" ADD CONSTRAINT "CompanyKnowledge_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "CompanyKnowledge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingApproval" ADD CONSTRAINT "PendingApproval_knowledgeId_fkey" FOREIGN KEY ("knowledgeId") REFERENCES "CompanyKnowledge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeAudit" ADD CONSTRAINT "KnowledgeAudit_knowledgeId_fkey" FOREIGN KEY ("knowledgeId") REFERENCES "CompanyKnowledge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
