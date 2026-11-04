-- S19(d): additive index for session expiry.
-- Session sweeps and "expired" reads filter on the raw expiresAt column; the
-- existing indexes are keyed by userId and cannot serve a global expiry scan.
-- Additive only: no data changes, no behavior changes.
CREATE INDEX IF NOT EXISTS "Session_expiresAt_idx" ON "Session"("expiresAt");

-- S19(e): RuleApplyRecord.idempotencyKey uniqueness becomes per-company.
-- The original index (migration 20260804124148_add_rule_apply_record) made the
-- key unique across the whole table, so the same caller-supplied key in two
-- different tenants collided globally. Idempotency is a tenant concern: the
-- composite (companyId, idempotencyKey) index keeps repeats inside one company
-- rejected while letting unrelated tenants reuse a key.
-- Index names match the Prisma schema (@@unique([companyId, idempotencyKey])).
DROP INDEX IF EXISTS "RuleApplyRecord_idempotencyKey_key";
CREATE UNIQUE INDEX IF NOT EXISTS "RuleApplyRecord_companyId_idempotencyKey_key"
  ON "RuleApplyRecord"("companyId", "idempotencyKey");

-- S19(c): audit evidence must survive its tenant.
-- "AuditLog"."companyId" was a foreign key to "Company" with ON DELETE SET NULL.
-- Deleting a company therefore nulled the column on the surviving rows — and
-- companyId is part of the audit hash payload, so the stored hashes would no
-- longer recompute (verifyAuditChain reports HASH_MISMATCH) and the global
-- chain would be destroyed. Audit rows are evidence: they keep their scope.
-- The column stays (data unchanged); only the referential action is removed,
-- exactly like "RuleExecutionAudit", which is likewise cleaned by tenant scope
-- in application code instead of a cascade.
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_companyId_fkey";
