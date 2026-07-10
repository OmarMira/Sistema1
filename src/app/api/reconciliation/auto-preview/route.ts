import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';

import {
  transactionMatchesRule,
  loadEntityFirstContext,
  type Transaction,
  type Rule,
} from '@/lib/services/rule-matching-engine';

// ─── POST /api/reconciliation/auto-preview ─────────────────────────────────
// Preview auto-reconcile using bank rules + amount matching without making changes.
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const body = await request.json();
  const { bankAccountId, matchByAmount = true } = body;

  if (!bankAccountId) {
    return NextResponse.json({ error: 'bankAccountId is required' }, { status: 400 });
  }

  // Verify bank account
  const bankAccount = await db.bankAccount.findFirst({
    where: { id: bankAccountId, companyId },
  });
  if (!bankAccount) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });
  }

  // Load entity-first context for SOCIO conflict detection
  const efCtx = await loadEntityFirstContext(companyId);

  // Get active rules sorted by priority
  const rules = await db.bankRule.findMany({
    where: { companyId, isActive: true },
    orderBy: { priority: 'asc' },
  });

  // Get unreconciled transactions
  const statements = await db.bankStatement.findMany({
    where: { bankAccountId },
    select: { id: true },
  });
  const statementIds = statements.map((s) => s.id);

  const unreconciledTransactions = await db.bankTransaction.findMany({
    where: {
      statementId: { in: statementIds },
      isReconciled: false,
    },
  });

  if (unreconciledTransactions.length === 0) {
    return NextResponse.json({
      success: true,
      matched: 0,
      matchedByRule: 0,
      matchedByAmount: 0,
    });
  }

  // ── Step 1: Match by rules ──
  const matchedTxIds = new Set<string>();

  for (const rule of rules) {
    for (const tx of unreconciledTransactions) {
      if (matchedTxIds.has(tx.id)) continue;
      if (
        transactionMatchesRule(
          tx as Transaction,
          rule as Rule,
          efCtx.knownSocioPatterns,
          efCtx.entityFirstMode,
        )
      ) {
        matchedTxIds.add(tx.id);
      }
    }
  }

  const matchedByRule = matchedTxIds.size;
  let matchedByAmount = 0;

  // ── Step 2: Match by amount with journal entries ──
  if (matchByAmount && unreconciledTransactions.length > matchedTxIds.size) {
    const journalLines = await db.journalLine.findMany({
      where: {
        glAccountId: bankAccount.glAccountId,
        entry: { companyId, status: 'posted' },
      },
      include: {
        entry: {
          select: { id: true, date: true, description: true, reference: true, lines: true },
        },
      },
      orderBy: { entry: { date: 'asc' } },
    });

    const journalEntryMap = new Map<string, { amount: number; date: string }>();

    for (const jl of journalLines) {
      const existing = journalEntryMap.get(jl.entryId);
      const net = jl.debit - Number(jl.credit);
      if (existing) {
        existing.amount += net;
      } else {
        journalEntryMap.set(jl.entryId, {
          amount: net,
          date: jl.entry.date.toISOString().split('T')[0] ?? '',
        });
      }
    }

    for (const tx of unreconciledTransactions) {
      if (matchedTxIds.has(tx.id)) continue;

      const txDate = tx.date.toISOString().split('T')[0];
      const txAmount = tx.amount;

      for (const [entryId, jeInfo] of journalEntryMap) {
        if (Math.abs(jeInfo.amount - txAmount) < 0.01 && jeInfo.date === txDate) {
          matchedTxIds.add(tx.id);
          matchedByAmount++;
          journalEntryMap.delete(entryId);
          break;
        }
      }
    }
  }

  return NextResponse.json({
    success: true,
    matched: matchedTxIds.size,
    total: unreconciledTransactions.length,
    matchedByRule,
    matchedByAmount,
  });
});

