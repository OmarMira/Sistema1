import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';

/**
 * GET /api/diagnostics — System diagnostics
 */
export const GET = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();

    // Verify user is admin
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user || (user.role !== 'company_admin' && user.role !== 'super_admin')) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // Get database size from PostgreSQL
    let dbSize = 'Unknown';
    try {
      const result = await db.$queryRawUnsafe<{ size: string }[]>(
        "SELECT pg_size_pretty(pg_database_size(current_database())) as size"
      );
      dbSize = result[0]?.size ?? 'Unknown';
    } catch {
      dbSize = 'Unknown';
    }

    // Count tables (Prisma models)
    const tableCount = 12; // User, Company, CompanyMember, GlAccount, BankAccount, BankStatement, BankTransaction, BankRule, JournalEntry, JournalLine, FiscalPeriod, AuditLog

    // Get counts from database
    const [
      accountTotal,
      accountActive,
      journalTotal,
      journalPosted,
      journalDraft,
      bankAccountTotal,
      bankRuleTotal,
      bankRuleActive,
      transactionTotal,
      transactionReconciled,
      transactionUnreconciled,
    ] = await Promise.all([
      db.glAccount.count(),
      db.glAccount.count({ where: { isActive: true } }),
      db.journalEntry.count(),
      db.journalEntry.count({ where: { status: 'posted' } }),
      db.journalEntry.count({ where: { status: 'draft' } }),
      db.bankAccount.count(),
      db.bankRule.count(),
      db.bankRule.count({ where: { isActive: true } }),
      db.bankTransaction.count(),
      db.bankTransaction.count({ where: { isReconciled: true } }),
      db.bankTransaction.count({ where: { isReconciled: false } }),
    ]);

    // System uptime (from process)
    const uptimeMs = process.uptime();
    const days = Math.floor(uptimeMs / 86400);
    const hours = Math.floor((uptimeMs % 86400) / 3600);
    const uptimeStr = days > 0 ? `${days}d ${hours}h` : `${hours}h`;

    return NextResponse.json({
      database: {
        status: 'connected',
        size: dbSize,
        tables: tableCount,
      },
      accounts: {
        total: accountTotal,
        active: accountActive,
      },
      journalEntries: {
        total: journalTotal,
        posted: journalPosted,
        draft: journalDraft,
      },
      bankAccounts: {
        total: bankAccountTotal,
      },
      bankRules: {
        total: bankRuleTotal,
        active: bankRuleActive,
      },
      transactions: {
        total: transactionTotal,
        reconciled: transactionReconciled,
        unreconciled: transactionUnreconciled,
      },
      system: {
        uptime: uptimeStr,
        version: '1.0.0',
      },
    });
  },
  { requireMembership: false },
);
