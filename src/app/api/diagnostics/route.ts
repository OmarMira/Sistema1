import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';
import fs from 'fs';
import path from 'path';

/**
 * GET /api/diagnostics — System diagnostics
 */
export async function GET(request: Request) {
  try {
    const userId = await getSessionUserId(request as unknown as import('next/server').NextRequest);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Verify user is admin
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user || (user.role !== 'company_admin' && user.role !== 'super_admin')) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // Check database size
    let dbSize = '0KB';
    try {
      const dbPath = path.join(process.cwd(), 'db', 'custom.db');
      const stats = fs.statSync(dbPath);
      const bytes = stats.size;
      if (bytes < 1024) dbSize = `${bytes}B`;
      else if (bytes < 1024 * 1024) dbSize = `${(bytes / 1024).toFixed(0)}KB`;
      else dbSize = `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
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
  } catch (error) {
    console.error('[DIAGNOSTICS ERROR]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
