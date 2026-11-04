-- CreateTable
CREATE TABLE "JournalCorrection" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "originalEntryId" TEXT NOT NULL,
    "counterEntryId" TEXT NOT NULL,
    "replacementEntryId" TEXT NOT NULL,
    "reason" TEXT,
    "correctedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JournalCorrection_originalEntryId_idx" ON "JournalCorrection"("originalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalCorrection_companyId_originalEntryId_key" ON "JournalCorrection"("companyId", "originalEntryId");

-- AddForeignKey
ALTER TABLE "JournalCorrection" ADD CONSTRAINT "JournalCorrection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalCorrection" ADD CONSTRAINT "JournalCorrection_originalEntryId_fkey" FOREIGN KEY ("originalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalCorrection" ADD CONSTRAINT "JournalCorrection_counterEntryId_fkey" FOREIGN KEY ("counterEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalCorrection" ADD CONSTRAINT "JournalCorrection_replacementEntryId_fkey" FOREIGN KEY ("replacementEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

