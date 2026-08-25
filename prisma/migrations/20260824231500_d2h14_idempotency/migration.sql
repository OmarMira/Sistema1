-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "idempotencyRequestHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_companyId_idempotencyKey_key" ON "JournalEntry"("companyId", "idempotencyKey");
