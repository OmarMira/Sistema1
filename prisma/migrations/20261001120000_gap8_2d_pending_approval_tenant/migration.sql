-- §GAP8-2D: explicit tenant scope for PendingApproval (human-gate memory).
-- 1) Add the column nullable so legacy rows can be backfilled first.
-- 2) Deterministic backfill: CompanyKnowledge FK relation first (covers
--    action='update'), then payload->>'companyId' (covers action='create'
--    and 'ai_classification_proposal'). No tenant is ever invented.
-- 3) SET NOT NULL aborts this migration explicitly if any legacy row is
--    underivable — no rows are deleted to make the migration pass.
-- 4) Index for tenant-scoped queries.
-- No FK to Company: legacy payload.companyId can reference already-deleted
-- companies; removing those rows is prohibited here. The admin company
-- delete path now cleans PendingApproval by companyId directly.

-- AlterTable
ALTER TABLE "PendingApproval" ADD COLUMN "companyId" TEXT;

-- Backfill
UPDATE "PendingApproval" pa
SET "companyId" = COALESCE(
  (SELECT ck."companyId" FROM "CompanyKnowledge" ck WHERE ck.id = pa."knowledgeId"),
  pa."payload" ->> 'companyId'
);

-- Explicit failure on any underivable legacy row
ALTER TABLE "PendingApproval" ALTER COLUMN "companyId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "PendingApproval_companyId_idx" ON "PendingApproval"("companyId");
