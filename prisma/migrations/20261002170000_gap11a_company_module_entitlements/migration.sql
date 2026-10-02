-- CreateTable
CREATE TABLE "CompanyModuleEntitlement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "moduleKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "activatedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyModuleEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyModuleEntitlement_companyId_moduleKey_key" ON "CompanyModuleEntitlement"("companyId", "moduleKey");

-- CreateIndex
CREATE INDEX "CompanyModuleEntitlement_companyId_idx" ON "CompanyModuleEntitlement"("companyId");

-- AddForeignKey
ALTER TABLE "CompanyModuleEntitlement" ADD CONSTRAINT "CompanyModuleEntitlement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
