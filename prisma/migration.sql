-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TransactionIntent" AS ENUM ('LOAN_PAYMENT', 'RENT_PAYMENT', 'OPERATING_EXPENSE', 'OWNER_CONTRIBUTION', 'CUSTOMER_PAYMENT', 'TRANSFER', 'TAX_PAYMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('PERSON', 'COMPANY', 'FINANCIAL_PRODUCT', 'PLATFORM', 'ASSET');

-- CreateEnum
CREATE TYPE "DecisionReason" AS ENUM ('COMPANY_KNOWLEDGE_CONFIRMED', 'COMPANY_KNOWLEDGE_UPDATED', 'COMPANY_KNOWLEDGE_MERGED', 'ENTITY_CONTEXT_MATCH', 'BANK_RULE_MATCH', 'LLM_SUGGESTION', 'MANUAL_OVERRIDE', 'FALLBACK_DEFAULT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'company_admin',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "phone" TEXT NOT NULL DEFAULT '',
    "streetLine1" TEXT NOT NULL DEFAULT '',
    "streetLine2" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "zipCode" TEXT NOT NULL DEFAULT '',
    "avatar" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "entityType" TEXT NOT NULL DEFAULT 'BUSINESS',
    "taxId" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "logo" TEXT,
    "streetLine1" TEXT NOT NULL DEFAULT '',
    "streetLine2" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "zipCode" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isOnboardingComplete" BOOLEAN NOT NULL DEFAULT false,
    "entityFirstMode" BOOLEAN NOT NULL DEFAULT false,
    "autoRoleAssignment" BOOLEAN NOT NULL DEFAULT false,
    "maxApplyTransactions" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyMember" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'company_admin',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "normalBalance" TEXT NOT NULL,
    "parentId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "GlAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNo" TEXT,
    "routingNo" TEXT,
    "glAccountId" TEXT NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "initialBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "openingBalance" DECIMAL(18,2) NOT NULL,
    "closingBalance" DECIMAL(18,2) NOT NULL,
    "totalCredits" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalDebits" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "format" TEXT NOT NULL,
    "fileName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reference" TEXT,
    "isReconciled" BOOLEAN NOT NULL DEFAULT false,
    "isIgnored" BOOLEAN NOT NULL DEFAULT false,
    "glAccountId" TEXT,
    "matchedRuleId" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "reconciliationPeriodId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "importHash" TEXT,
    "journalEntryId" TEXT,
    "journalLineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationPeriod" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "statementBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "bookBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "difference" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "transactionCount" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "ReconciliationPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankRule" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "conditionType" TEXT NOT NULL,
    "conditionValue" TEXT NOT NULL,
    "transactionDirection" TEXT NOT NULL DEFAULT 'any',
    "glAccountId" TEXT,
    "conditions" JSONB,
    "debitGlAccountId" TEXT,
    "creditGlAccountId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 10,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "entityContextId" TEXT,
    "isManuallyEdited" BOOLEAN NOT NULL DEFAULT false,
    "intent" "TransactionIntent",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "hash" TEXT,
    "previousHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "glAccountId" TEXT NOT NULL,
    "description" TEXT,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalPeriod" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FiscalPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "details" TEXT,
    "hash" TEXT,
    "previousHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntityContext" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "roles" TEXT,
    "userDescription" TEXT,
    "transactionDirection" TEXT,
    "glAccountId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'user',
    "autoAssignedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemMemory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "keywords" TEXT NOT NULL,
    "importance" INTEGER NOT NULL DEFAULT 5,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessedAt" TIMESTAMP(3),
    "embedding" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankProfile" (
    "id" TEXT NOT NULL,
    "bankId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "fingerprints" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "config" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "windowMs" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetectionConfig" (
    "companyId" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION,
    "clusterMode" TEXT,
    "minOccurrences" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "DetectionConfig_pkey" PRIMARY KEY ("companyId")
);

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
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyMember_userId_companyId_key" ON "CompanyMember"("userId", "companyId");

-- CreateIndex
CREATE INDEX "GlAccount_companyId_parentId_idx" ON "GlAccount"("companyId", "parentId");

-- CreateIndex
CREATE INDEX "GlAccount_companyId_accountType_idx" ON "GlAccount"("companyId", "accountType");

-- CreateIndex
CREATE UNIQUE INDEX "GlAccount_companyId_code_key" ON "GlAccount"("companyId", "code");

-- CreateIndex
CREATE INDEX "BankAccount_companyId_idx" ON "BankAccount"("companyId");

-- CreateIndex
CREATE INDEX "BankAccount_glAccountId_idx" ON "BankAccount"("glAccountId");

-- CreateIndex
CREATE INDEX "BankAccount_companyId_accountNo_idx" ON "BankAccount"("companyId", "accountNo");

-- CreateIndex
CREATE INDEX "BankStatement_bankAccountId_endDate_idx" ON "BankStatement"("bankAccountId", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatement_bankAccountId_startDate_endDate_key" ON "BankStatement"("bankAccountId", "startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_importHash_key" ON "BankTransaction"("importHash");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_journalEntryId_key" ON "BankTransaction"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_journalLineId_key" ON "BankTransaction"("journalLineId");

-- CreateIndex
CREATE INDEX "BankTransaction_statementId_idx" ON "BankTransaction"("statementId");

-- CreateIndex
CREATE INDEX "BankTransaction_glAccountId_idx" ON "BankTransaction"("glAccountId");

-- CreateIndex
CREATE INDEX "BankTransaction_isReconciled_idx" ON "BankTransaction"("isReconciled");

-- CreateIndex
CREATE INDEX "BankTransaction_isIgnored_idx" ON "BankTransaction"("isIgnored");

-- CreateIndex
CREATE INDEX "BankTransaction_status_idx" ON "BankTransaction"("status");

-- CreateIndex
CREATE INDEX "BankTransaction_statementId_isReconciled_date_idx" ON "BankTransaction"("statementId", "isReconciled", "date");

-- CreateIndex
CREATE INDEX "BankTransaction_reference_idx" ON "BankTransaction"("reference");

-- CreateIndex
CREATE INDEX "BankTransaction_statementId_date_idx" ON "BankTransaction"("statementId", "date");

-- CreateIndex
CREATE INDEX "BankTransaction_importHash_idx" ON "BankTransaction"("importHash");

-- CreateIndex
CREATE INDEX "BankTransaction_isReconciled_journalEntryId_date_idx" ON "BankTransaction"("isReconciled", "journalEntryId", "date");

-- CreateIndex
CREATE INDEX "ReconciliationPeriod_companyId_bankAccountId_idx" ON "ReconciliationPeriod"("companyId", "bankAccountId");

-- CreateIndex
CREATE INDEX "ReconciliationPeriod_status_idx" ON "ReconciliationPeriod"("status");

-- CreateIndex
CREATE INDEX "BankRule_companyId_isActive_priority_idx" ON "BankRule"("companyId", "isActive", "priority");

-- CreateIndex
CREATE INDEX "JournalEntry_companyId_date_idx" ON "JournalEntry"("companyId", "date");

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "JournalLine"("entryId");

-- CreateIndex
CREATE INDEX "JournalLine_glAccountId_idx" ON "JournalLine"("glAccountId");

-- CreateIndex
CREATE INDEX "JournalLine_glAccountId_entryId_idx" ON "JournalLine"("glAccountId", "entryId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalPeriod_companyId_name_key" ON "FiscalPeriod"("companyId", "name");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_idx" ON "AuditLog"("companyId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_createdAt_idx" ON "AuditLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_token_idx" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "EntityContext_companyId_idx" ON "EntityContext"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityContext_companyId_pattern_key" ON "EntityContext"("companyId", "pattern");

-- CreateIndex
CREATE INDEX "SystemMemory_companyId_idx" ON "SystemMemory"("companyId");

-- CreateIndex
CREATE INDEX "SystemMemory_type_idx" ON "SystemMemory"("type");

-- CreateIndex
CREATE INDEX "SystemMemory_importance_idx" ON "SystemMemory"("importance");

-- CreateIndex
CREATE UNIQUE INDEX "BankProfile_bankId_key" ON "BankProfile"("bankId");

-- CreateIndex
CREATE INDEX "BankProfile_isActive_idx" ON "BankProfile"("isActive");

-- CreateIndex
CREATE INDEX "BankProfile_requiresReview_idx" ON "BankProfile"("requiresReview");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimit_key_key" ON "RateLimit"("key");

-- CreateIndex
CREATE INDEX "RateLimit_key_idx" ON "RateLimit"("key");

-- CreateIndex
CREATE UNIQUE INDEX "SystemConfig_key_key" ON "SystemConfig"("key");

-- CreateIndex
CREATE INDEX "SystemConfig_key_idx" ON "SystemConfig"("key");

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
ALTER TABLE "CompanyMember" ADD CONSTRAINT "CompanyMember_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMember" ADD CONSTRAINT "CompanyMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlAccount" ADD CONSTRAINT "GlAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlAccount" ADD CONSTRAINT "GlAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "GlAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_journalLineId_fkey" FOREIGN KEY ("journalLineId") REFERENCES "JournalLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_reconciliationPeriodId_fkey" FOREIGN KEY ("reconciliationPeriodId") REFERENCES "ReconciliationPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_matchedRuleId_fkey" FOREIGN KEY ("matchedRuleId") REFERENCES "BankRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "BankStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationPeriod" ADD CONSTRAINT "ReconciliationPeriod_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationPeriod" ADD CONSTRAINT "ReconciliationPeriod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationPeriod" ADD CONSTRAINT "ReconciliationPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankRule" ADD CONSTRAINT "BankRule_creditGlAccountId_fkey" FOREIGN KEY ("creditGlAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankRule" ADD CONSTRAINT "BankRule_debitGlAccountId_fkey" FOREIGN KEY ("debitGlAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankRule" ADD CONSTRAINT "BankRule_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankRule" ADD CONSTRAINT "BankRule_entityContextId_fkey" FOREIGN KEY ("entityContextId") REFERENCES "EntityContext"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankRule" ADD CONSTRAINT "BankRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "GlAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalPeriod" ADD CONSTRAINT "FiscalPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityContext" ADD CONSTRAINT "EntityContext_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntityContext" ADD CONSTRAINT "EntityContext_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemMemory" ADD CONSTRAINT "SystemMemory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetectionConfig" ADD CONSTRAINT "DetectionConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyKnowledge" ADD CONSTRAINT "CompanyKnowledge_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyKnowledge" ADD CONSTRAINT "CompanyKnowledge_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "CompanyKnowledge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingApproval" ADD CONSTRAINT "PendingApproval_knowledgeId_fkey" FOREIGN KEY ("knowledgeId") REFERENCES "CompanyKnowledge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeAudit" ADD CONSTRAINT "KnowledgeAudit_knowledgeId_fkey" FOREIGN KEY ("knowledgeId") REFERENCES "CompanyKnowledge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

