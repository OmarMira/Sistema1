-- ============================================================
-- CLEANUP EXECUTION: Remove test data from accountexpress
-- Preserves: LQ & OM LLC + admin@accountexpress.com
-- Backup verified at: db/backups/backup-before-test-cleanup.dump
-- ============================================================

BEGIN;

-- IDs to preserve
\set real_company_id 'cmrb8nknr0003c7yk43n64eb1'
\set real_user_id 'cmrb8nknf0002c7ykod7nbap8'

-- Delete in dependency order (children before parents)

-- 1. BankTransaction (children of BankStatement)
DELETE FROM "BankTransaction" WHERE "statementId" IN (
  SELECT id FROM "BankStatement" WHERE "companyId" != :'real_company_id'
);

-- 2. JournalLine (children of JournalEntry and GlAccount)
DELETE FROM "JournalLine" WHERE "entryId" IN (
  SELECT id FROM "JournalEntry" WHERE "companyId" != :'real_company_id'
);

-- 3. ReconciliationPeriod (children of BankAccount)
DELETE FROM "ReconciliationPeriod" WHERE "bankAccountId" IN (
  SELECT id FROM "BankAccount" WHERE "companyId" != :'real_company_id'
);

-- 4. BankStatement (children of BankAccount)
DELETE FROM "BankStatement" WHERE "bankAccountId" IN (
  SELECT id FROM "BankAccount" WHERE "companyId" != :'real_company_id'
);

-- 5. KnowledgeAudit (before CompanyKnowledge)
DELETE FROM "KnowledgeAudit" WHERE "knowledgeId" IN (
  SELECT id FROM "CompanyKnowledge" WHERE "companyId" != :'real_company_id'
);

-- 6. CompanyKnowledge
DELETE FROM "CompanyKnowledge" WHERE "companyId" != :'real_company_id';

-- 7. AuditLog (test companies + test users)
DELETE FROM "AuditLog" WHERE "companyId" != :'real_company_id'
  AND ("userId" IS NULL OR "userId" != :'real_user_id');

-- 8. BankRule
DELETE FROM "BankRule" WHERE "companyId" != :'real_company_id';

-- 9. EntityContext
DELETE FROM "EntityContext" WHERE "companyId" != :'real_company_id';

-- 10. BankAccount
DELETE FROM "BankAccount" WHERE "companyId" != :'real_company_id';

-- 11. JournalEntry
DELETE FROM "JournalEntry" WHERE "companyId" != :'real_company_id';

-- 12. GlAccount
DELETE FROM "GlAccount" WHERE "companyId" != :'real_company_id';

-- 13. FiscalPeriod
DELETE FROM "FiscalPeriod" WHERE "companyId" != :'real_company_id';

-- 14. DetectionConfig
DELETE FROM "DetectionConfig" WHERE "companyId" != :'real_company_id';

-- 15. SystemMemory
DELETE FROM "SystemMemory" WHERE "companyId" != :'real_company_id';

-- 16. Session (test user sessions)
DELETE FROM "Session" WHERE "userId" != :'real_user_id';

-- 18. CompanyMember (test companies)
DELETE FROM "CompanyMember" WHERE "companyId" != :'real_company_id';

-- 19. User (test users)
DELETE FROM "User" WHERE id != :'real_user_id';

-- 20. Company (last)
DELETE FROM "Company" WHERE id != :'real_company_id';

-- Note: RateLimit has no companyId (keyed by string key)
-- Note: PendingApproval references CompanyKnowledge (cascade-deleted)
-- Preserve SystemConfig (AI config - global)
-- Preserve BankProfile (global bank profiles)

COMMIT;
