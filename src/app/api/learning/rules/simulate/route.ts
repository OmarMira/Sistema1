import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { eligibleForClassificationWhere } from '@/lib/services/transaction-invariants';

// Condition schema validation
const conditionSchema = z.object({
  field: z.enum(['description', 'amount']),
  operator: z.enum([
    'contains',
    'equals',
    'greater_than',
    'less_than',
    'starts_with',
    'ends_with',
    'amount_greater',
    'amount_less',
  ]),
  value: z.string(),
});

// Request body validation schema
const simulateRequestSchema = z.object({
  conditions: z.array(conditionSchema),
});

// Condition matching logic
function matchCondition(
  tx: { description: string; amount: number; reference?: string | null },
  cond: z.infer<typeof conditionSchema>,
): boolean {
  const field = cond.field.toLowerCase();
  const operator = cond.operator;
  const value = cond.value;

  if (!value) return false;

  if (field === 'amount') {
    const absAmount = Math.abs(tx.amount);
    const valNum = parseFloat(value);
    if (isNaN(valNum)) return false;

    if (operator === 'equals') return absAmount === valNum;
    if (operator === 'greater_than' || operator === 'amount_greater') return absAmount > valNum;
    if (operator === 'less_than' || operator === 'amount_less') return absAmount < valNum;
    return false;
  } else {
    const desc = tx.description.toLowerCase();
    const val = value.toLowerCase();
    switch (operator) {
      case 'contains':
        return desc.includes(val);
      case 'starts_with':
        return desc.startsWith(val);
      case 'ends_with':
        return desc.endsWith(val);
      case 'equals':
        return desc === val;
      default:
        return false;
    }
  }
}

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  try {
    const body = await request.json();

    // Validate request parameters using Zod
    const validation = simulateRequestSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid request payload', details: validation.error.format() },
        { status: 400 },
      );
    }

    const { conditions } = validation.data;

    // Fetch all unreconciled transactions for the company
    const transactions = await db.bankTransaction.findMany({
      where: eligibleForClassificationWhere({
        statement: { companyId },
      }),
      select: {
        id: true,
        date: true,
        description: true,
        amount: true,
        reference: true,
      },
    });

    // Evaluate matching rules on the dataset
    const matched = transactions.filter((tx) =>
      conditions.every((cond) => matchCondition(tx, cond)),
    );

    const matchCount = matched.length;

    // Take at most 5 samples for UI preview
    const samples = matched.slice(0, 5).map((tx) => ({
      date: tx.date,
      description: tx.description,
      amount: tx.amount,
      reference: tx.reference,
    }));

    return NextResponse.json({
      success: true,
      matchCount,
      samples,
    });
  } catch (error: unknown) {
    logger.error('[POST RULE SIMULATION ERROR]', { error: String(error) });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
});
