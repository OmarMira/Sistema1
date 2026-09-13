import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';

// ─── GET /api/transactions ─────────────────────────────────────────
// Transactions requiring manual classification (glAccountId = null) for the
// active company. Minimal review queue for the import → correct → learn flow.
export const GET = apiHandler(async (request: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin', 'employee']);

  const { searchParams } = new URL(request.url);
  const classificationStatus = searchParams.get('classificationStatus');

  // Scope: only the review queue this block needs. Explicitly reject other
  // values rather than silently widening the surface.
  if (classificationStatus !== 'uncategorized') {
    return NextResponse.json(
      { error: 'classificationStatus must be "uncategorized"' },
      { status: 400 },
    );
  }

  // Tenant isolation in the query itself — no post-fetch filtering.
    // RECONCILED-UNCLASSIFIED-001: the review queue is defined by
    // glAccountId = null, regardless of reconciliation state. A transaction
    // reconciled WITHOUT a GL account never touched the books and must stay
    // reachable for classification (P0 dead-end: it used to disappear from
    // every corrective surface). Categorized transactions remain excluded
    // whether reconciled or not.
    const transactions = await db.bankTransaction.findMany({
      where: {
        glAccountId: null,
        statement: { bankAccount: { companyId } },
      },
    orderBy: { date: 'desc' },
    select: {
      id: true,
      date: true,
      description: true,
      amount: true,
      glAccountId: true,
      isReconciled: true,
      statement: {
        select: {
          bankAccount: {
            select: { id: true, accountName: true },
          },
        },
      },
    },
  });

  return NextResponse.json({
    transactions: transactions.map((t) => ({
      id: t.id,
      date: t.date,
      description: t.description,
      amount: Number(t.amount),
      direction: Number(t.amount) >= 0 ? 'credit' : 'debit',
      glAccountId: t.glAccountId,
      isReconciled: t.isReconciled,
      bankAccountId: t.statement.bankAccount.id,
      bankAccountName: t.statement.bankAccount.accountName,
    })),
  });
});
