import { PrismaClient } from '@prisma/client';
import readline from 'readline';

const url = process.env.DATABASE_URL ?? '';
const force = process.argv.includes('--force');

if (!url.includes('test') && !force) {
  console.error('❌ ABORTADO: DATABASE_URL no contiene "test".');
  console.error('   Para borrar en producción, agregá --force:');
  console.error('   node scripts/delete-company.mjs <company-id> --force');
  console.error(`   URL actual: ${url.slice(0, 60)}...`);
  process.exit(1);
}

const db = new PrismaClient();

const COMPANY_ID = process.argv[2];
if (!COMPANY_ID) {
  console.error('Uso: node scripts/delete-company.mjs <company-id> [--force]');
  process.exit(1);
}

// Confirm before deleting
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await new Promise((resolve) => {
  rl.question(`⚠️  ¿Borrar TODA la empresa ${COMPANY_ID}? (escribe "SI" para confirmar): `, resolve);
});
rl.close();

if (answer !== 'SI') {
  console.log('Cancelado.');
  process.exit(0);
}

console.log(`🗑️  Borrando empresa: ${COMPANY_ID}`);
try {
  // 1. Asientos contables
  const entries = await db.journalEntry.deleteMany({ where: { companyId: COMPANY_ID } });
  console.log(`  JournalEntries: ${entries.count}`);

  // 2. Movimientos bancarios
  const txns = await db.bankTransaction.deleteMany({ where: { companyId: COMPANY_ID } });
  console.log(`  BankTransactions: ${txns.count}`);

  // 3. Bank rules
  const rules = await db.bankRule.deleteMany({ where: { companyId: COMPANY_ID } });
  console.log(`  BankRules: ${rules.count}`);

  // 4. Bank statements
  const stmts = await db.bankStatement.deleteMany({ where: { companyId: COMPANY_ID } });
  console.log(`  BankStatements: ${stmts.count}`);

  // 5. Bank accounts
  const accts = await db.bankAccount.deleteMany({ where: { companyId: COMPANY_ID } });
  console.log(`  BankAccounts: ${accts.count}`);

  // 6. Entity contexts
  const ctxs = await db.entityContext.deleteMany({ where: { companyId: COMPANY_ID } });
  console.log(`  EntityContexts: ${ctxs.count}`);

  // 7. Fiscal periods
  const fps = await db.fiscalPeriod.deleteMany({ where: { companyId: COMPANY_ID } });
  console.log(`  FiscalPeriods: ${fps.count}`);

  // 8. Accounts plan
  const gls = await db.glAccount.deleteMany({ where: { companyId: COMPANY_ID } });
  console.log(`  GlAccounts: ${gls.count}`);

  // 9. Reconciliation periods
  const rps = await db.reconciliationPeriod.deleteMany({ where: { companyId: COMPANY_ID } });
  console.log(`  ReconciliationPeriods: ${rps.count}`);

  // 10. Company members
  const members = await db.companyMember.deleteMany({ where: { companyId: COMPANY_ID } });
  console.log(`  CompanyMembers: ${members.count}`);

  // 11. Audit logs
  const logs = await db.auditLog.deleteMany({ where: { companyId: COMPANY_ID } });
  console.log(`  AuditLogs: ${logs.count}`);

  // 12. System memories
  const mems = await db.systemMemory.deleteMany({ where: { companyId: COMPANY_ID } });
  console.log(`  SystemMemories: ${mems.count}`);

  // 13. FINAL: la empresa
  const company = await db.company.delete({ where: { id: COMPANY_ID } });
  console.log(`✅ Empresa borrada: ${company.legalName} (${company.id})`);
} catch (e) {
  console.error('❌ Error:', e);
} finally {
  await db.$disconnect();
}
