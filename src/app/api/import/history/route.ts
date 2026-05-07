import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';

// ─── GET /api/import/history?companyId=xxx ────────────────────────────
// List all bank statements (import history) for a company
export async function GET(request: NextRequest) {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const companyId = searchParams.get('companyId');

  if (!companyId) {
    return NextResponse.json(
      { error: 'companyId is required' },
      { status: 400 }
    );
  }

  // Verify membership
  const membership = await db.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId } },
  });
  if (!membership) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const statements = await db.bankStatement.findMany({
      where: { companyId },
      include: {
        bankAccount: {
          select: {
            id: true,
            accountName: true,
            bankName: true,
          },
        },
        _count: {
          select: { transactions: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Calculate auto-categorized count for each statement
    const statementsWithStats = await Promise.all(
      statements.map(async (stmt) => {
        const categorizedCount = await db.bankTransaction.count({
          where: {
            statementId: stmt.id,
            matchedRuleId: { not: null },
          },
        });

        return {
          id: stmt.id,
          companyId: stmt.companyId,
          bankAccountId: stmt.bankAccountId,
          bankAccount: stmt.bankAccount,
          startDate: stmt.startDate,
          endDate: stmt.endDate,
          openingBalance: stmt.openingBalance,
          closingBalance: stmt.closingBalance,
          totalCredits: stmt.totalCredits,
          totalDebits: stmt.totalDebits,
          format: stmt.format,
          fileName: stmt.fileName,
          createdAt: stmt.createdAt,
          transactionCount: stmt._count.transactions,
          autoCategorizedCount: categorizedCount,
          autoCategorizedPercent:
            stmt._count.transactions > 0
              ? Math.round(
                  (categorizedCount / stmt._count.transactions) * 100
                )
              : 0,
        };
      })
    );

    return NextResponse.json({ statements: statementsWithStats });
  } catch (error) {
    console.error('[IMPORT HISTORY ERROR]', error);
    return NextResponse.json(
      { error: 'Failed to fetch import history' },
      { status: 500 }
    );
  }
}
