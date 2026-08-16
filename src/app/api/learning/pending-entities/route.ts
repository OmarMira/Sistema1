import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { loadConfig, clusterCandidates } from '@/lib/services/entity-detector';
import { handleRouteError } from '@/lib/route-error-handler';
import { eligibleForClassificationWhere } from '@/lib/services/transaction-invariants';

export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  try {
    // Load un-reconciled, un-imputed transactions
    const transactions = await db.bankTransaction.findMany({
      where: eligibleForClassificationWhere({
        statement: {
          bankAccount: { companyId },
        },
      }),
      select: {
        description: true,
        amount: true,
        date: true,
      },
    });

    const rawTransactions = transactions.map((t) => ({
      description: t.description,
      amount: t.amount,
      date: t.date.toISOString(),
    }));

    const config = loadConfig();
    const candidates = clusterCandidates(rawTransactions, config);

    // ── FK-based coverage detection ──────────────────────────────────
    const entityContexts = await db.entityContext.findMany({
      where: { companyId },
      select: { id: true, pattern: true },
    });

    const contextByPattern = new Map<string, string>(
      entityContexts.map((ctx) => [ctx.pattern.toLowerCase(), ctx.id]),
    );

    const activeLinkedRules = await db.bankRule.findMany({
      where: {
        companyId,
        isActive: true,
        entityContextId: { not: null },
      },
      select: { entityContextId: true },
    });

    const coveredContextIds = new Set<string>(
      activeLinkedRules.map((r) => r.entityContextId).filter(Boolean) as string[],
    );

    const candidatesWithCoverage = candidates.map((c) => {
      const contextId = contextByPattern.get(c.canonicalName.toLowerCase());
      return {
        ...c,
        isCovered: contextId ? coveredContextIds.has(contextId) : false,
      };
    });

    const sorted = candidatesWithCoverage.sort((a, b) => b.occurrences - a.occurrences);

    return NextResponse.json({ success: true, candidates: sorted });
  } catch (error) {
    return handleRouteError(error, 'GET_PENDING_ENTITIES_ERROR');
  }
});
