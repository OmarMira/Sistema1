import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';
import { recalculateBankAccountBalance } from '@/lib/reconciliation';

// Helper: check if a transaction matches a rule
function transactionMatchesRule(
  tx: { description: string; amount: number },
  rule: {
    conditionType: string;
    conditionValue: string;
    transactionDirection: string;
  }
): boolean {
  if (rule.transactionDirection === 'debit' && tx.amount >= 0) return false;
  if (rule.transactionDirection === 'credit' && tx.amount < 0) return false;

  const desc = tx.description.toLowerCase();
  const val = rule.conditionValue.toLowerCase();

  switch (rule.conditionType) {
    case 'contains':
      return desc.includes(val);
    case 'starts_with':
      return desc.startsWith(val);
    case 'ends_with':
      return desc.endsWith(val);
    case 'equals':
      return desc === val;
    case 'amount_greater':
      return Math.abs(tx.amount) > Number(rule.conditionValue);
    case 'amount_less':
      return Math.abs(tx.amount) < Number(rule.conditionValue);
    default:
      return false;
  }
}

// ─── POST /api/reconciliation/auto ─────────────────────────────────
// Auto-reconcile using bank rules + amount matching with journal entries.
// Body: { companyId, bankAccountId, createJournalEntries?, periodId?, matchByAmount? }
export async function POST(request: NextRequest) {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const {
      companyId,
      bankAccountId,
      createJournalEntries = false,
      periodId,
      matchByAmount = true,
    } = body;

    if (!companyId || !bankAccountId) {
      return NextResponse.json(
        { error: 'companyId and bankAccountId are required' },
        { status: 400 }
      );
    }

    // Verify access
    const membership = await db.companyMember.findUnique({
      where: { userId_companyId: { userId, companyId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
      return NextResponse.json(
        { error: 'Bank account not found' },
        { status: 404 }
      );
    }

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
        isIgnored: false,
      },
    });

    if (unreconciledTransactions.length === 0) {
      return NextResponse.json({
        success: true,
        matched: 0,
        matchedByRule: 0,
        matchedByAmount: 0,
        journalEntriesCreated: 0,
        message: 'No unreconciled transactions found.',
      });
    }

    // ── Step 1: Match by rules ──
    const matchedTxIds = new Set<string>();
    const matchMap = new Map<string, { ruleId: string; ruleName: string; glAccountId: string }>();

    for (const rule of rules) {
      for (const tx of unreconciledTransactions) {
        if (matchedTxIds.has(tx.id)) continue;
        if (transactionMatchesRule(tx, rule)) {
          matchedTxIds.add(tx.id);
          matchMap.set(tx.id, {
            ruleId: rule.id,
            ruleName: rule.name,
            glAccountId: rule.glAccountId,
          });
        }
      }
    }

    let matchedByRule = matchedTxIds.size;
    let matchedByAmount = 0;

    // ── Step 2: Match by amount with journal entries ──
    if (matchByAmount && unreconciledTransactions.length > matchedTxIds.size) {
      // Get posted journal lines for the bank GL account
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

      // Build a map of journal entry amounts (net per entry on bank account)
      const journalEntryMap = new Map<string, { amount: number; date: string; description: string; counterGlAccountId: string }>();

      for (const jl of journalLines) {
        const existing = journalEntryMap.get(jl.entryId);
        const net = jl.debit - jl.credit;
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
      for (const tx of unreconciledTransactions) {
        if (matchedTxIds.has(tx.id)) continue;

        const txDate = tx.date.toISOString().split('T')[0];
        const txAmount = tx.amount;

        for (const [entryId, jeInfo] of journalEntryMap) {
          if (Math.abs(jeInfo.amount - txAmount) < 0.01 && jeInfo.date === txDate) {
            matchedTxIds.add(tx.id);
            matchMap.set(tx.id, {
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

    let journalEntriesCreated = 0;

    // Process matched transactions
    await db.$transaction(async (tx) => {
      for (const [txId, match] of matchMap) {
        const transaction = unreconciledTransactions.find((t) => t.id === txId);
        if (!transaction) continue;

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
          const debitAccountId = transaction.amount > 0
            ? bankAccount.glAccountId
            : match.glAccountId;
          const creditAccountId = transaction.amount > 0
            ? match.glAccountId
            : bankAccount.glAccountId;

          const description = `Auto-reconcile: ${transaction.description} (Rule: ${match.ruleName})`;

          const journalEntry = await tx.journalEntry.create({
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

          // Save journal entry ID back to the transaction
          await tx.bankTransaction.update({
            where: { id: txId },
            data: { journalEntryId: journalEntry.id },
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
          where: { id: periodId },
          data: { transactionCount: periodTxCount },
        });
      }
    });

    // Recalculate bank account balance after auto-reconciliation
    await recalculateBankAccountBalance(bankAccountId);

    // Audit log
    await db.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'auto_reconcile',
        entity: 'BankTransaction',
        details: JSON.stringify({
          bankAccountId,
          matchedByRule,
          matchedByAmount,
          totalMatched: matchedTxIds.size,
          journalEntriesCreated,
          periodId,
        }),
      },
    });

    return NextResponse.json({
      success: true,
      matched: matchedTxIds.size,
      total: unreconciledTransactions.length,
      matchedByRule,
      matchedByAmount,
      journalEntriesCreated,
    });
  } catch (error) {
    console.error('[AUTO RECONCILIATION ERROR]', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
