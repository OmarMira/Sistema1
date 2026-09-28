-- CreateTable
CREATE TABLE "CsvLayoutProfile" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "delimiter" TEXT NOT NULL,
    "dateColumnIndex" INTEGER NOT NULL,
    "descriptionColumnIndex" INTEGER NOT NULL,
    "amountColumnIndex" INTEGER NOT NULL,
    "referenceColumnIndex" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CsvLayoutProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CsvLayoutProfile_companyId_fingerprint_key" ON "CsvLayoutProfile"("companyId", "fingerprint");

-- AddForeignKey
ALTER TABLE "CsvLayoutProfile" ADD CONSTRAINT "CsvLayoutProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
