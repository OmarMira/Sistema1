-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."DecisionReason" AS ENUM ('COMPANY_KNOWLEDGE_CONFIRMED', 'COMPANY_KNOWLEDGE_UPDATED', 'COMPANY_KNOWLEDGE_MERGED', 'ENTITY_CONTEXT_MATCH', 'BANK_RULE_MATCH', 'LLM_SUGGESTION', 'MANUAL_OVERRIDE', 'FALLBACK_DEFAULT');

-- CreateEnum
CREATE TYPE "public"."EntityType" AS ENUM ('PERSON', 'COMPANY', 'FINANCIAL_PRODUCT', 'PLATFORM', 'ASSET');

-- CreateEnum
CREATE TYPE "public"."TransactionIntent" AS ENUM ('LOAN_PAYMENT', 'RENT_PAYMENT', 'OPERATING_EXPENSE', 'OWNER_CONTRIBUTION', 'CUSTOMER_PAYMENT', 'TRANSFER', 'TAX_PAYMENT', 'OTHER');

-- CreateTable
CREATE TABLE "public"."AuditLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hash" TEXT,
    "previousHash" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BankAccount" (
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
CREATE TABLE "public"."BankProfile" (
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
CREATE TABLE "public"."BankRule" (
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "entityContextId" TEXT,
    "isManuallyEdited" BOOLEAN NOT NULL DEFAULT false,
    "intent" "public"."TransactionIntent",
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BankRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BankStatement" (
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
CREATE TABLE "public"."BankTransaction" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reference" TEXT,
    "isReconciled" BOOLEAN NOT NULL DEFAULT false,
    "glAccountId" TEXT,
    "matchedRuleId" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "reconciliationPeriodId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "importHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "journalEntryId" TEXT,
    "journalLineId" TEXT,
    "isIgnored" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Company" (
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
    "maxApplyTransactions" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "autoRoleAssignment" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CompanyKnowledge" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "public"."EntityType" NOT NULL,
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
CREATE TABLE "public"."CompanyMember" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'company_admin',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DetectionConfig" (
    "companyId" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION,
    "clusterMode" TEXT,
    "minOccurrences" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "DetectionConfig_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "public"."EntityContext" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "roles" TEXT,
    "userDescription" TEXT,
    "transactionDirection" TEXT,
    "glAccountId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "autoAssignedAt" TIMESTAMP(3),

    CONSTRAINT "EntityContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FiscalPeriod" (
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
CREATE TABLE "public"."GlAccount" (
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
CREATE TABLE "public"."JournalEntry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hash" TEXT,
    "previousHash" TEXT,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "glAccountId" TEXT NOT NULL,
    "description" TEXT,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."KnowledgeAudit" (
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

-- CreateTable
CREATE TABLE "public"."PendingApproval" (
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
CREATE TABLE "public"."RateLimit" (
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
CREATE TABLE "public"."ReconciliationPeriod" (
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
CREATE TABLE "public"."RuleExecutionAudit" (
    "id" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "winnerRuleId" TEXT,
    "candidateCount" INTEGER NOT NULL,
    "trace" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleExecutionAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SystemConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SystemMemory" (
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
CREATE TABLE "public"."User" (
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

-- CreateIndex
CREATE INDEX "AuditLog_companyId_createdAt_idx" ON "public"."AuditLog"("companyId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "AuditLog_companyId_idx" ON "public"."AuditLog"("companyId" ASC);

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "public"."AuditLog"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "public"."AuditLog"("userId" ASC, "createdAt" ASC);

-- CreateIndex
CREATE INDEX "BankAccount_companyId_accountNo_idx" ON "public"."BankAccount"("companyId" ASC, "accountNo" ASC);

-- CreateIndex
CREATE INDEX "BankAccount_companyId_idx" ON "public"."BankAccount"("companyId" ASC);

-- CreateIndex
CREATE INDEX "BankAccount_glAccountId_idx" ON "public"."BankAccount"("glAccountId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "BankProfile_bankId_key" ON "public"."BankProfile"("bankId" ASC);

-- CreateIndex
CREATE INDEX "BankProfile_isActive_idx" ON "public"."BankProfile"("isActive" ASC);

-- CreateIndex
CREATE INDEX "BankProfile_requiresReview_idx" ON "public"."BankProfile"("requiresReview" ASC);

-- CreateIndex
CREATE INDEX "BankRule_companyId_isActive_priority_idx" ON "public"."BankRule"("companyId" ASC, "isActive" ASC, "priority" ASC);

-- CreateIndex
CREATE INDEX "BankStatement_bankAccountId_endDate_idx" ON "public"."BankStatement"("bankAccountId" ASC, "endDate" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "BankStatement_bankAccountId_startDate_endDate_key" ON "public"."BankStatement"("bankAccountId" ASC, "startDate" ASC, "endDate" ASC);

-- CreateIndex
CREATE INDEX "BankTransaction_glAccountId_idx" ON "public"."BankTransaction"("glAccountId" ASC);

-- CreateIndex
CREATE INDEX "BankTransaction_importHash_idx" ON "public"."BankTransaction"("importHash" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_importHash_key" ON "public"."BankTransaction"("importHash" ASC);

-- CreateIndex
CREATE INDEX "BankTransaction_isIgnored_idx" ON "public"."BankTransaction"("isIgnored" ASC);

-- CreateIndex
CREATE INDEX "BankTransaction_isReconciled_idx" ON "public"."BankTransaction"("isReconciled" ASC);

-- CreateIndex
CREATE INDEX "BankTransaction_isReconciled_journalEntryId_date_idx" ON "public"."BankTransaction"("isReconciled" ASC, "journalEntryId" ASC, "date" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_journalEntryId_key" ON "public"."BankTransaction"("journalEntryId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_journalLineId_key" ON "public"."BankTransaction"("journalLineId" ASC);

-- CreateIndex
CREATE INDEX "BankTransaction_reference_idx" ON "public"."BankTransaction"("reference" ASC);

-- CreateIndex
CREATE INDEX "BankTransaction_statementId_date_idx" ON "public"."BankTransaction"("statementId" ASC, "date" ASC);

-- CreateIndex
CREATE INDEX "BankTransaction_statementId_idx" ON "public"."BankTransaction"("statementId" ASC);

-- CreateIndex
CREATE INDEX "BankTransaction_statementId_isReconciled_date_idx" ON "public"."BankTransaction"("statementId" ASC, "isReconciled" ASC, "date" ASC);

-- CreateIndex
CREATE INDEX "BankTransaction_status_idx" ON "public"."BankTransaction"("status" ASC);

-- CreateIndex
CREATE INDEX "CompanyKnowledge_canonicalName_idx" ON "public"."CompanyKnowledge"("canonicalName" ASC);

-- CreateIndex
CREATE INDEX "CompanyKnowledge_companyId_idx" ON "public"."CompanyKnowledge"("companyId" ASC);

-- CreateIndex
CREATE INDEX "CompanyKnowledge_type_idx" ON "public"."CompanyKnowledge"("type" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyMember_userId_companyId_key" ON "public"."CompanyMember"("userId" ASC, "companyId" ASC);

-- CreateIndex
CREATE INDEX "EntityContext_companyId_idx" ON "public"."EntityContext"("companyId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "EntityContext_companyId_pattern_key" ON "public"."EntityContext"("companyId" ASC, "pattern" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "FiscalPeriod_companyId_name_key" ON "public"."FiscalPeriod"("companyId" ASC, "name" ASC);

-- CreateIndex
CREATE INDEX "GlAccount_companyId_accountType_idx" ON "public"."GlAccount"("companyId" ASC, "accountType" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "GlAccount_companyId_code_key" ON "public"."GlAccount"("companyId" ASC, "code" ASC);

-- CreateIndex
CREATE INDEX "GlAccount_companyId_parentId_idx" ON "public"."GlAccount"("companyId" ASC, "parentId" ASC);

-- CreateIndex
CREATE INDEX "JournalEntry_companyId_date_idx" ON "public"."JournalEntry"("companyId" ASC, "date" ASC);

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "public"."JournalLine"("entryId" ASC);

-- CreateIndex
CREATE INDEX "JournalLine_glAccountId_entryId_idx" ON "public"."JournalLine"("glAccountId" ASC, "entryId" ASC);

-- CreateIndex
CREATE INDEX "JournalLine_glAccountId_idx" ON "public"."JournalLine"("glAccountId" ASC);

-- CreateIndex
CREATE INDEX "KnowledgeAudit_knowledgeId_idx" ON "public"."KnowledgeAudit"("knowledgeId" ASC);

-- CreateIndex
CREATE INDEX "KnowledgeAudit_timestamp_idx" ON "public"."KnowledgeAudit"("timestamp" ASC);

-- CreateIndex
CREATE INDEX "PendingApproval_knowledgeId_idx" ON "public"."PendingApproval"("knowledgeId" ASC);

-- CreateIndex
CREATE INDEX "PendingApproval_status_idx" ON "public"."PendingApproval"("status" ASC);

-- CreateIndex
CREATE INDEX "RateLimit_key_idx" ON "public"."RateLimit"("key" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "RateLimit_key_key" ON "public"."RateLimit"("key" ASC);

-- CreateIndex
CREATE INDEX "ReconciliationPeriod_companyId_bankAccountId_idx" ON "public"."ReconciliationPeriod"("companyId" ASC, "bankAccountId" ASC);

-- CreateIndex
CREATE INDEX "ReconciliationPeriod_status_idx" ON "public"."ReconciliationPeriod"("status" ASC);

-- CreateIndex
CREATE INDEX "RuleExecutionAudit_companyId_idx" ON "public"."RuleExecutionAudit"("companyId" ASC);

-- CreateIndex
CREATE INDEX "RuleExecutionAudit_executedAt_idx" ON "public"."RuleExecutionAudit"("executedAt" ASC);

-- CreateIndex
CREATE INDEX "RuleExecutionAudit_transactionId_idx" ON "public"."RuleExecutionAudit"("transactionId" ASC);

-- CreateIndex
CREATE INDEX "Session_token_idx" ON "public"."Session"("token" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "public"."Session"("token" ASC);

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "public"."Session"("userId" ASC, "expiresAt" ASC);

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "public"."Session"("userId" ASC);

-- CreateIndex
CREATE INDEX "SystemConfig_key_idx" ON "public"."SystemConfig"("key" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "SystemConfig_key_key" ON "public"."SystemConfig"("key" ASC);

-- CreateIndex
CREATE INDEX "SystemMemory_companyId_idx" ON "public"."SystemMemory"("companyId" ASC);

-- CreateIndex
CREATE INDEX "SystemMemory_importance_idx" ON "public"."SystemMemory"("importance" ASC);

-- CreateIndex
CREATE INDEX "SystemMemory_type_idx" ON "public"."SystemMemory"("type" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email" ASC);

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankAccount" ADD CONSTRAINT "BankAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankAccount" ADD CONSTRAINT "BankAccount_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "public"."GlAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankRule" ADD CONSTRAINT "BankRule_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankRule" ADD CONSTRAINT "BankRule_creditGlAccountId_fkey" FOREIGN KEY ("creditGlAccountId") REFERENCES "public"."GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankRule" ADD CONSTRAINT "BankRule_debitGlAccountId_fkey" FOREIGN KEY ("debitGlAccountId") REFERENCES "public"."GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankRule" ADD CONSTRAINT "BankRule_entityContextId_fkey" FOREIGN KEY ("entityContextId") REFERENCES "public"."EntityContext"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankRule" ADD CONSTRAINT "BankRule_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "public"."GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankStatement" ADD CONSTRAINT "BankStatement_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "public"."BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankStatement" ADD CONSTRAINT "BankStatement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankTransaction" ADD CONSTRAINT "BankTransaction_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "public"."GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankTransaction" ADD CONSTRAINT "BankTransaction_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "public"."JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankTransaction" ADD CONSTRAINT "BankTransaction_journalLineId_fkey" FOREIGN KEY ("journalLineId") REFERENCES "public"."JournalLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankTransaction" ADD CONSTRAINT "BankTransaction_matchedRuleId_fkey" FOREIGN KEY ("matchedRuleId") REFERENCES "public"."BankRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankTransaction" ADD CONSTRAINT "BankTransaction_reconciliationPeriodId_fkey" FOREIGN KEY ("reconciliationPeriodId") REFERENCES "public"."ReconciliationPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BankTransaction" ADD CONSTRAINT "BankTransaction_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "public"."BankStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CompanyKnowledge" ADD CONSTRAINT "CompanyKnowledge_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CompanyKnowledge" ADD CONSTRAINT "CompanyKnowledge_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "public"."CompanyKnowledge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CompanyMember" ADD CONSTRAINT "CompanyMember_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CompanyMember" ADD CONSTRAINT "CompanyMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DetectionConfig" ADD CONSTRAINT "DetectionConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EntityContext" ADD CONSTRAINT "EntityContext_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EntityContext" ADD CONSTRAINT "EntityContext_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "public"."GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FiscalPeriod" ADD CONSTRAINT "FiscalPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GlAccount" ADD CONSTRAINT "GlAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GlAccount" ADD CONSTRAINT "GlAccount_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JournalEntry" ADD CONSTRAINT "JournalEntry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "public"."JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JournalLine" ADD CONSTRAINT "JournalLine_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "public"."GlAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."KnowledgeAudit" ADD CONSTRAINT "KnowledgeAudit_knowledgeId_fkey" FOREIGN KEY ("knowledgeId") REFERENCES "public"."CompanyKnowledge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PendingApproval" ADD CONSTRAINT "PendingApproval_knowledgeId_fkey" FOREIGN KEY ("knowledgeId") REFERENCES "public"."CompanyKnowledge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReconciliationPeriod" ADD CONSTRAINT "ReconciliationPeriod_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "public"."BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReconciliationPeriod" ADD CONSTRAINT "ReconciliationPeriod_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReconciliationPeriod" ADD CONSTRAINT "ReconciliationPeriod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RuleExecutionAudit" ADD CONSTRAINT "RuleExecutionAudit_winnerRuleId_fkey" FOREIGN KEY ("winnerRuleId") REFERENCES "public"."BankRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SystemMemory" ADD CONSTRAINT "SystemMemory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

