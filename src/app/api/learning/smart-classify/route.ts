import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { loadConfig, clusterByBehavior } from '@/lib/services/entity-detector';
import { logger } from '@/lib/logger';
import { toNum } from '@/lib/utils/decimal';
import { eligibleForClassificationWhere } from '@/lib/services/transaction-invariants';

function normalizeForComparison(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── GET /api/learning/smart-classify ─────────────────────────────────
// Dedicated endpoint that uses clusterByBehavior() for the wizard flow.
// Does NOT replace classify-entity — this is additive for the wizard only.
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  try {
    // Fetch unclassified, unreconciled bank transactions for this company
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

    // Convert Prisma models to the raw format expected by clusterByBehavior
    const rawTransactions = transactions.map((t) => ({
      description: t.description,
      amount: toNum(t.amount),
      date: t.date.toISOString(),
    }));

    const config = loadConfig();
    const candidates = clusterByBehavior(rawTransactions, config);

    // ── Filter out entities already classified ──
    // Check EntityContext (onboarding modal) and CompanyKnowledge (CK page) independently.
    // If one table is missing or errors, the other still works.
    let filtered = candidates;
    try {
      const classifiedPatterns = new Set<string>();

      // Query EntityContext (always exists)
      const entityContexts = await db.entityContext.findMany({
        where: { companyId },
        select: { pattern: true },
      });
      for (const ctx of entityContexts) {
        classifiedPatterns.add(normalizeForComparison(ctx.pattern));
      }

      // Query CompanyKnowledge (may not exist in all environments)
      try {
        const knowledgeEntries = await db.companyKnowledge.findMany({
          where: { companyId, status: 'active' },
          select: { canonicalName: true, aliases: true },
        });
        for (const e of knowledgeEntries) {
          classifiedPatterns.add(normalizeForComparison(e.canonicalName));
          for (const alias of e.aliases ?? []) {
            classifiedPatterns.add(normalizeForComparison(alias));
          }
        }
      } catch {
        // CompanyKnowledge table may not exist — skip silently
      }

      filtered = candidates.filter((c) => {
        const normalized = normalizeForComparison(c.canonicalName);
        return !classifiedPatterns.has(normalized);
      });
    } catch (filterError) {
      logger.warn('SMART_CLASSIFY_FILTER_ERROR', {
        error: filterError instanceof Error ? filterError.message : String(filterError),
      });
    }

    return NextResponse.json({ data: filtered });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Internal server error';
    logger.error('SMART_CLASSIFY_ERROR', { error: msg });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
