-- ============================================================
-- CLEANUP SCRIPT: Remove test data from accountexpress
-- Preserves: LQ & OM LLC + admin@accountexpress.com
-- ============================================================
-- SAFETY: Run as DRY RUN first (ROLLBACK at end)
-- Then re-run with COMMIT after verification
-- ============================================================

BEGIN;

-- ─── IDs to preserve ────────────────────────────────────────────────────────
\set real_company_id 'cmrb8nknr0003c7yk43n64eb1'
\set real_user_id 'cmrb8nknf0002c7ykod7nbap8'

-- ─── DRY RUN: Show what will be deleted ─────────────────────────────────────

-- Companies to delete
SELECT 'COMPANIES TO DELETE' as section, COUNT(*) as count FROM "Company" WHERE id != :'real_company_id';
SELECT id, "legalName" FROM "Company" WHERE id != :'real_company_id' LIMIT 10;

-- Users to delete
SELECT 'USERS TO DELETE' as section, COUNT(*) as count FROM "User" WHERE id != :'real_user_id';
SELECT id, email FROM "User" WHERE id != :'real_user_id';

-- Impact per table
SELECT 'SESSIONS TO DELETE' as section, COUNT(*) FROM "Session" WHERE "userId" != :'real_user_id';
SELECT 'COMPANY_MEMBERS TO DELETE' as section, COUNT(*) FROM "CompanyMember" WHERE "companyId" != :'real_company_id';
SELECT 'GL_ACCOUNTS TO DELETE' as section, COUNT(*) FROM "GlAccount" WHERE "companyId" != :'real_company_id';
SELECT 'BANK_ACCOUNTS TO DELETE' as section, COUNT(*) FROM "BankAccount" WHERE "companyId" != :'real_company_id';
SELECT 'BANK_STATEMENTS TO DELETE' as section, COUNT(*) FROM "BankStatement" WHERE "companyId" != :'real_company_id';
SELECT 'BANK_TRANSACTIONS TO DELETE' as section, COUNT(*) FROM "BankTransaction" bt JOIN "BankStatement" bs ON bt."statementId" = bs.id WHERE bs."companyId" != :'real_company_id';
SELECT 'ENTITY_CONTEXTS TO DELETE' as section, COUNT(*) FROM "EntityContext" WHERE "companyId" != :'real_company_id';
SELECT 'BANK_RULES TO DELETE' as section, COUNT(*) FROM "BankRule" WHERE "companyId" != :'real_company_id';
SELECT 'FISCAL_PERIODS TO DELETE' as section, COUNT(*) FROM "FiscalPeriod" WHERE "companyId" != :'real_company_id';
SELECT 'JOURNAL_ENTRIES TO DELETE' as section, COUNT(*) FROM "JournalEntry" WHERE "companyId" != :'real_company_id';
SELECT 'JOURNAL_LINES TO DELETE' as section, COUNT(*) FROM "JournalLine" jl JOIN "JournalEntry" je ON jl."entryId" = je.id WHERE je."companyId" != :'real_company_id';
SELECT 'AUDIT_LOGS TO DELETE' as section, COUNT(*) FROM "AuditLog" WHERE "companyId" != :'real_company_id';

-- ROLLBACK for dry run
ROLLBACK;

-- ============================================================
-- AFTER DRY RUN VERIFICATION, UNCOMMENT BELOW:
-- ============================================================

-- BEGIN;
--
-- -- Delete in dependency order (children before parents)
--
-- -- 1. BankTransaction (children of BankStatement)
-- DELETE FROM "BankTransaction" WHERE "statementId" IN (
--   SELECT id FROM "BankStatement" WHERE "companyId" != :'real_company_id'
-- );
--
-- -- 2. JournalLine (children of JournalEntry and GlAccount)
-- DELETE FROM "JournalLine" WHERE "entryId" IN (
--   SELECT id FROM "JournalEntry" WHERE "companyId" != :'real_company_id'
-- );
--
-- -- 3. ReconciliationPeriod (children of BankAccount)
-- DELETE FROM "ReconciliationPeriod" WHERE "bankAccountId" IN (
--   SELECT id FROM "BankAccount" WHERE "companyId" != :'real_company_id'
-- );
--
-- -- 4. BankStatement (children of BankAccount)
-- DELETE FROM "BankStatement" WHERE "bankAccountId" IN (
--   SELECT id FROM "BankAccount" WHERE "companyId" != :'real_company_id'
-- );
--
-- -- 5. KnowledgeAudit (before CompanyKnowledge)
-- DELETE FROM "KnowledgeAudit" WHERE "knowledgeId" IN (
--   SELECT id FROM "CompanyKnowledge" WHERE "companyId" != :'real_company_id'
-- );
--
-- -- 6. CompanyKnowledge
-- DELETE FROM "CompanyKnowledge" WHERE "companyId" != :'real_company_id';
--
-- -- 7. AuditLog
-- DELETE FROM "AuditLog" WHERE "companyId" != :'real_company_id';
--
-- -- 8. BankRule (after GlAccount, EntityContext)
-- DELETE FROM "BankRule" WHERE "companyId" != :'real_company_id';
--
-- -- 9. EntityContext (after GlAccount)
-- DELETE FROM "EntityContext" WHERE "companyId" != :'real_company_id';
--
-- -- 10. BankAccount (after BankStatement, ReconciliationPeriod)
-- DELETE FROM "BankAccount" WHERE "companyId" != :'real_company_id';
--
-- -- 11. JournalEntry (after JournalLine)
-- DELETE FROM "JournalEntry" WHERE "companyId" != :'real_company_id';
--
-- -- 12. GlAccount (after JournalLine, BankAccount)
-- DELETE FROM "GlAccount" WHERE "companyId" != :'real_company_id';
--
-- -- 13. FiscalPeriod
-- DELETE FROM "FiscalPeriod" WHERE "companyId" != :'real_company_id';
--
-- -- 14. DetectionConfig
-- DELETE FROM "DetectionConfig" WHERE "companyId" != :'real_company_id';
--
-- -- 15. SystemMemory
-- DELETE FROM "SystemMemory" WHERE "companyId" != :'real_company_id';
--
-- -- 16. Session (test user sessions)
-- DELETE FROM "Session" WHERE "userId" != :'real_user_id';
--
-- -- 17. CompanyMember (test companies)
-- DELETE FROM "CompanyMember" WHERE "companyId" != :'real_company_id';
--
-- -- 18. RateLimit (test companies)
-- DELETE FROM "RateLimit" WHERE "companyId" IS NOT NULL AND "companyId" != :'real_company_id';
--
-- -- 19. PendingApproval (test companies)
-- DELETE FROM "PendingApproval" WHERE "companyId" IS NOT NULL AND "companyId" != :'real_company_id';
--
-- -- 20. User (test users)
-- DELETE FROM "User" WHERE id != :'real_user_id';
--
-- -- 21. Company (last - after all children deleted)
-- DELETE FROM "Company" WHERE id != :'real_company_id';
--
-- -- Preserve SystemConfig (AI config - global)
-- -- Preserve BankProfile (global bank profiles)
--
-- COMMIT;
