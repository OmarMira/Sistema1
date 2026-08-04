-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "ruleApplyRecordId" TEXT;

-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "ruleApplyRecordId" TEXT;

-- CreateTable
CREATE TABLE "RuleApplyRecord" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'batch',
    "ruleId" TEXT,
    "userId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'applied',
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuleApplyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RuleApplyRecord_idempotencyKey_key" ON "RuleApplyRecord"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RuleApplyRecord_companyId_idx" ON "RuleApplyRecord"("companyId");

-- CreateIndex
CREATE INDEX "RuleApplyRecord_ruleId_idx" ON "RuleApplyRecord"("ruleId");

-- CreateIndex
CREATE INDEX "RuleApplyRecord_state_idx" ON "RuleApplyRecord"("state");

-- CreateIndex
CREATE INDEX "RuleApplyRecord_companyId_state_idx" ON "RuleApplyRecord"("companyId", "state");

-- CreateIndex
CREATE INDEX "RuleApplyRecord_appliedAt_idx" ON "RuleApplyRecord"("appliedAt");

-- CreateIndex
CREATE INDEX "BankTransaction_ruleApplyRecordId_idx" ON "BankTransaction"("ruleApplyRecordId");

-- CreateIndex
CREATE INDEX "JournalEntry_ruleApplyRecordId_idx" ON "JournalEntry"("ruleApplyRecordId");

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_ruleApplyRecordId_fkey" FOREIGN KEY ("ruleApplyRecordId") REFERENCES "RuleApplyRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_ruleApplyRecordId_fkey" FOREIGN KEY ("ruleApplyRecordId") REFERENCES "RuleApplyRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleApplyRecord" ADD CONSTRAINT "RuleApplyRecord_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleApplyRecord" ADD CONSTRAINT "RuleApplyRecord_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "BankRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleApplyRecord" ADD CONSTRAINT "RuleApplyRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;