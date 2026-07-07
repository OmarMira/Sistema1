import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';

export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { searchParams } = new URL(request.url);

  const accountsCount = await db.glAccount.count({ where: { companyId } });
  const banksCount = await db.bankAccount.count({ where: { companyId } });
  const importCount = await db.bankTransaction.count({ where: { statement: { companyId } } });
  const rulesCount = await db.bankRule.count({ where: { companyId } });
  const reconciliationCount = await db.bankTransaction.count({
    where: { statement: { companyId }, isReconciled: true },
  });
  const journalCount = await db.journalEntry.count({ where: { companyId } });

  return NextResponse.json({
    accounts: { completed: accountsCount > 0, count: accountsCount },
    banks: { completed: banksCount > 0, count: banksCount },
    import: { completed: importCount > 0, count: importCount },
    rules: { completed: rulesCount > 0, count: rulesCount },
    reconciliation: { completed: reconciliationCount > 0, count: reconciliationCount },
    journal: { completed: journalCount > 0, count: journalCount },
    reports: { completed: journalCount > 0, count: journalCount },
  });
});
