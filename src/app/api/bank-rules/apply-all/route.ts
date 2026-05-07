import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';

// Helper: check if a transaction matches a rule
function transactionMatchesRule(
  tx: { description: string; amount: number },
  rule: {
    conditionType: string;
    conditionValue: string;
    transactionDirection: string;
  }
): boolean {
  // Check direction first
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

// ─── POST /api/bank-rules/apply-all ────────────────────────────────
// Apply ALL active rules to all unmatched transactions.
// Rules are processed in priority order (lower number = higher priority).
// First match wins per transaction.
// Body: { companyId }
export async function POST(request: NextRequest) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { companyId } = body;

    if (!companyId) {
      return NextResponse.json(
        { error: 'companyId is required' },
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

    // Get all active rules sorted by priority
    const rules = await db.bankRule.findMany({
      where: { companyId, isActive: true },
      orderBy: { priority: 'asc' },
    });

    if (rules.length === 0) {
      return NextResponse.json({
        success: true,
        matched: 0,
        total: 0,
        message: 'No active rules found.',
      });
    }

    // Get all unmatched transactions for this company
    const companyStatements = await db.bankStatement.findMany({
      where: { companyId },
      select: { id: true },
    });
    const statementIds = companyStatements.map((s) => s.id);

    const unmatchedTransactions = await db.bankTransaction.findMany({
      where: {
        statementId: { in: statementIds },
        isReconciled: false,
        matchedRuleId: null,
      },
    });

    let totalMatched = 0;
    const matchResults: { ruleId: string; ruleName: string; count: number }[] = [];

    // Track which transactions have been matched
    const matchedTxIds = new Set<string>();

    // Process each rule in priority order
    for (const rule of rules) {
      const txsForThisRule = unmatchedTransactions.filter(
        (tx) => !matchedTxIds.has(tx.id) && transactionMatchesRule(tx, rule)
      );

      if (txsForThisRule.length > 0) {
        const txIds = txsForThisRule.map((tx) => tx.id);
        await db.bankTransaction.updateMany({
          where: { id: { in: txIds } },
          data: {
            glAccountId: rule.glAccountId,
            matchedRuleId: rule.id,
          },
        });

        txIds.forEach((tid) => matchedTxIds.add(tid));
        totalMatched += txIds.length;
        matchResults.push({
          ruleId: rule.id,
          ruleName: rule.name,
          count: txIds.length,
        });
      }
    }

    return NextResponse.json({
      success: true,
      matched: totalMatched,
      total: unmatchedTransactions.length,
      rulesApplied: matchResults,
    });
  } catch (error) {
    console.error('[BANK RULES APPLY ALL ERROR]', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
