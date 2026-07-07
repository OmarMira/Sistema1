import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { logger } from '@/lib/logger';

// ─── GET /api/import/history?companyId=xxx ────────────────────────────
// List all bank statements (import history) for a company
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  const { searchParams } = new URL(request.url);

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
              ? Math.round((categorizedCount / stmt._count.transactions) * 100)
              : 0,
        };
      }),
    );

    return NextResponse.json({ statements: statementsWithStats });
  } catch (error) {
    logger.error('[IMPORT HISTORY ERROR]', { error: String(error) });
    return NextResponse.json({ error: 'Failed to fetch import history' }, { status: 500 });
  }
});
