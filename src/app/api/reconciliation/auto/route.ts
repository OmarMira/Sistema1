import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import {
  transactionMatchesRule,
  loadEntityFirstContext,
  evaluateWinningRule,
  loadRolePriorities,
  type Transaction,
  type Rule,
  type MatchingRule,
} from '@/lib/services/rule-matching-engine';

// ─── POST /api/reconciliation/auto ─────────────────────────────────
// Auto-reconcile using bank rules + amount matching with journal entries.
// Body: { companyId, bankAccountId, createJournalEntries?, periodId?, matchByAmount? }
export const POST = apiHandler(async (request: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  const body = await request.json();
  const { bankAccountId, createJournalEntries = false, periodId, matchByAmount = true } = body;

  if (!bankAccountId) {
    return NextResponse.json({ error: 'bankAccountId is required' }, { status: 400 });
  }

  // Verify bank account
  const bankAccount = await db.bankAccount.findFirst({
    where: { id: bankAccountId, companyId },
    include: {
      glAccount: {
        select: { id: true, code: true, name: true, normalBalance: true },
      },
    },
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

  const result = await db.$transaction(async (tx) => {
    // Get unreconciled transactions
    const statements = await tx.bankStatement.findMany({
      where: { bankAccountId },
      select: { id: true },
    });
    const statementIds = statements.map((s) => s.id);

    const unreconciledTransactions = await tx.bankTransaction.findMany({
      where: {
        statementId: { in: statementIds },
        isReconciled: false,
      },
    });

    if (unreconciledTransactions.length === 0) {
      return {
        matched: 0,
        matchedByRule: 0,
        matchedByAmount: 0,
        journalEntriesCreated: 0,
        total: 0,
        message: 'No unreconciled transactions found.',
      };
    }

    // ── Step 1: Match by rules ──
    const matchedTxIds = new Set<string>();
    const matchMap = new Map<string, { ruleId: string; ruleName: string; glAccountId: string }>();

    const rolePriorities = await loadRolePriorities();
    const entityContexts = await db.entityContext.findMany({
      where: { companyId },
      select: { pattern: true, role: true },
    });

    for (const t of unreconciledTransactions) {
      if (matchedTxIds.has(t.id)) continue;

      const matchingRules = rules.filter((rule) =>
        transactionMatchesRule(
          t as Transaction,
          rule as Rule,
          efCtx.knownSocioPatterns,
          efCtx.entityFirstMode,
        ),
      ) as MatchingRule[];

      if (matchingRules.length > 0) {
        const winner = evaluateWinningRule(
          matchingRules,
          t as Transaction,
          companyId,
          rolePriorities,
          entityContexts,
        );
        matchedTxIds.add(t.id);
        matchMap.set(t.id, {
          ruleId: winner.id,
          ruleName: winner.name,
          glAccountId: winner.glAccountId || '',
        });
      }
    }

    const matchedByRule = matchedTxIds.size;
    let matchedByAmount = 0;

    // ── Step 2: Match by amount with journal entries ──
    if (matchByAmount && unreconciledTransactions.length > matchedTxIds.size) {
      // Get posted journal lines for the bank GL account
      const journalLines = await tx.journalLine.findMany({
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

      // Build a map of journal entry amounts (net per entry on bank account)
      const journalEntryMap = new Map<
        string,
        { amount: number; date: string; description: string; counterGlAccountId: string }
      >();

      for (const jl of journalLines) {
        const existing = journalEntryMap.get(jl.entryId);
        const net = jl.debit - Number(jl.credit);
        if (existing) {
          existing.amount += net;
        } else {
          // Find the counter GL account
          const counterLine = jl.entry.lines.find((l) => l.glAccountId !== bankAccount.glAccountId);
          journalEntryMap.set(jl.entryId, {
            amount: net,
            date: jl.entry.date.toISOString().split('T')[0],
            description: jl.entry.description,
            counterGlAccountId: counterLine?.glAccountId || '',
          });
        }
      }

      // Match remaining transactions by amount
      for (const t of unreconciledTransactions) {
        if (matchedTxIds.has(t.id)) continue;

        const txDate = t.date.toISOString().split('T')[0];
        const txAmount = t.amount;

        for (const [entryId, jeInfo] of journalEntryMap) {
          if (Math.abs(jeInfo.amount - txAmount) < 0.01 && jeInfo.date === txDate) {
            matchedTxIds.add(t.id);
            matchMap.set(t.id, {
              ruleId: '',
              ruleName: 'Amount Match',
              glAccountId: jeInfo.counterGlAccountId,
            });
            matchedByAmount++;
            journalEntryMap.delete(entryId); // Don't reuse this entry
            break;
          }
        }
      }
    }

    // Pre-validate rules: if creating journal entries, all winning rules MUST have a GL account.
    const invalidRules = new Set<string>();
    for (const [_, match] of matchMap) {
      if (createJournalEntries && match.ruleId && (!match.glAccountId || !bankAccount.glAccountId)) {
        invalidRules.add(match.ruleName);
      }
    }

    if (invalidRules.size > 0) {
      const rulesList = Array.from(invalidRules).join(', ');
      return {
        isValidationError: true,
        message: `Error de Integridad: Las siguientes reglas no tienen una cuenta contable asignada y no pueden generar asientos automáticos: ${rulesList}. Por favor edita las reglas o desmarca la opción de crear asientos.`,
      };
    }

    let journalEntriesCreated = 0;

    // Process matched transactions
    for (const [txId, match] of matchMap) {
      const transaction = unreconciledTransactions.find((t) => t.id === txId);
      if (!transaction) continue;

      // Verify that the transaction date is in an active fiscal period
       
      await assertActiveFiscalPeriod(companyId, transaction.date, tx as any);

      const updateData: Record<string, unknown> = {
        glAccountId: match.glAccountId,
        isReconciled: true,
        reconciledAt: new Date(),
      };

      if (match.ruleId) {
        updateData.matchedRuleId = match.ruleId;
      }
      if (periodId) {
        updateData.reconciliationPeriodId = periodId;
      }

      await tx.bankTransaction.update({
        where: { id: txId },
        data: updateData,
      });

      // Create journal entry only for rule-matched, not amount-matched (those already have entries)
      if (createJournalEntries && match.ruleId) {
        const amount = Math.abs(transaction.amount);
        const debitAccountId = Number(transaction.amount) > 0 ? bankAccount.glAccountId : match.glAccountId;
        const creditAccountId = Number(transaction.amount) > 0 ? match.glAccountId : bankAccount.glAccountId;

        const description = `Auto-reconcile: ${transaction.description} (Rule: ${match.ruleName})`;

        await tx.journalEntry.create({
          data: {
            companyId,
            date: transaction.date,
            description,
            status: 'posted',
            lines: {
              create: [
                { glAccountId: debitAccountId, description, debit: amount, credit: 0 },
                { glAccountId: creditAccountId, description, debit: 0, credit: amount },
              ],
            },
          },
        });
        journalEntriesCreated++;
      }
    }

    // Update period transaction count
    if (periodId) {
      const periodTxCount = await tx.bankTransaction.count({
        where: { reconciliationPeriodId: periodId },
      });
      await tx.reconciliationPeriod.update({
        where: { id: periodId, companyId },
        data: { transactionCount: periodTxCount },
      });
    }

    return {
      matched: matchedTxIds.size,
      matchedByRule,
      matchedByAmount,
      journalEntriesCreated,
      total: unreconciledTransactions.length,
    };
  });

  if ('isValidationError' in result && result.isValidationError) {
    return NextResponse.json({ error: result.message }, { status: 400 });
  }

  if ('message' in result) {
    return NextResponse.json({
      success: true,
      matched: 0,
      matchedByRule: 0,
      matchedByAmount: 0,
      journalEntriesCreated: 0,
      message: result.message,
    });
  }

  // Audit log
  await db.auditLog.create({
    data: {
      companyId,
      userId,
      action: 'auto_reconcile',
      entity: 'BankTransaction',
      details: JSON.stringify({
        bankAccountId,
        matchedByRule: result.matchedByRule,
        matchedByAmount: result.matchedByAmount,
        totalMatched: result.matched,
        journalEntriesCreated: result.journalEntriesCreated,
        periodId,
      }),
    },
  });

  return NextResponse.json({
    success: true,
    matched: result.matched,
    total: result.total,
    matchedByRule: result.matchedByRule,
    matchedByAmount: result.matchedByAmount,
    journalEntriesCreated: result.journalEntriesCreated,
  });
});

