import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/app/api/auth/me/route';

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
// Auto-reconcile a bank account using bank rules.
// Matches unreconciled transactions via rules and creates journal entries.
// Body: { companyId, bankAccountId, createJournalEntries?: boolean }
export async function POST(request: NextRequest) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const {
      companyId,
      bankAccountId,
      createJournalEntries = false,
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

    // Get unreconciled transactions for this bank account
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
        journalEntriesCreated: 0,
        message: 'No unreconciled transactions found.',
      });
    }

    // Match transactions against rules
    const matchedTxIds = new Set<string>();
    const matchMap = new Map<
      string,
      { ruleId: string; ruleName: string; glAccountId: string }
    >();

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

    let journalEntriesCreated = 0;

    // Process matched transactions
    await db.$transaction(async (tx) => {
      for (const [txId, match] of matchMap) {
        const transaction = unreconciledTransactions.find((t) => t.id === txId);
        if (!transaction) continue;

        // Update the transaction
        await tx.bankTransaction.update({
          where: { id: txId },
          data: {
            glAccountId: match.glAccountId,
            matchedRuleId: match.ruleId,
            isReconciled: true,
          },
        });

        // Optionally create a journal entry
        if (createJournalEntries) {
          const amount = Math.abs(transaction.amount);
          const debitAccountId = transaction.amount > 0
            ? bankAccount.glAccountId // Cash/ bank account (debit for deposits)
            : match.glAccountId;      // Expense account (debit for payments)
          const creditAccountId = transaction.amount > 0
            ? match.glAccountId       // Revenue account (credit for deposits)
            : bankAccount.glAccountId; // Cash/ bank account (credit for payments)

          const description = `Auto-reconcile: ${transaction.description} (Rule: ${match.ruleName})`;

          await tx.journalEntry.create({
            data: {
              companyId,
              date: transaction.date,
              description,
              status: 'posted',
              lines: {
                create: [
                  {
                    glAccountId: debitAccountId,
                    description,
                    debit: amount,
                    credit: 0,
                  },
                  {
                    glAccountId: creditAccountId,
                    description,
                    debit: 0,
                    credit: amount,
                  },
                ],
              },
            },
          });

          journalEntriesCreated++;
        }
      }
    });

    return NextResponse.json({
      success: true,
      matched: matchedTxIds.size,
      total: unreconciledTransactions.length,
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
