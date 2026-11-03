-- S17c: additive index for the audit hash-chain tail scan.
-- createChainedAuditLog (src/lib/audit.ts) finds the chain tail with a
-- NOT EXISTS membership test on "AuditLog"."previousHash"
-- (SELECT 1 FROM "AuditLog" s WHERE s."previousHash" = a."hash"), which cannot
-- use the existing company/createdAt indexes.
-- Additive only: no data changes, no behavior changes.
CREATE INDEX "AuditLog_previousHash_idx" ON "AuditLog"("previousHash");
