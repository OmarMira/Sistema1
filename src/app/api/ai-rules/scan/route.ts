import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import type { RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { loadConfig, clusterCandidates } from '@/lib/services/entity-detector';
import { enrichCandidates, buildScanPattern } from '@/lib/services/entity-enricher';
import type { ScanEntry } from '@/lib/services/entity-enricher';
import { loadRolePriorities } from '@/lib/services/rule-matching-engine';

/**
 * POST /api/ai-rules/scan
 * Body: { companyId: string }
 *
 * Reads all bank transactions for a company and detects repetitive
 * description patterns (≥ 3 occurrences).  No external AI is used —
 * everything runs locally with pure string heuristics.
 */
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const config = loadConfig();

  // ── 1. Get all bank accounts for the company ───────────────────
  const bankAccounts = await db.bankAccount.findMany({
    where: { companyId, isActive: true },
    select: { id: true },
  });
  const bankAccountIds = bankAccounts.map((a) => a.id);

  if (bankAccountIds.length === 0) {
    return NextResponse.json({ patterns: [] });
  }

  // ── 2. Fetch all transactions ──────────────────────────────────
  const rawTransactions = await db.bankTransaction.findMany({
    where: {
      statement: { bankAccountId: { in: bankAccountIds } },
    },
    select: {
      id: true,
      description: true,
      amount: true,
      date: true,
      matchedRuleId: true,
      glAccountId: true,
    },
  });

  // Map to BankTransactionRaw (convert Date → ISO string)
  const transactions = rawTransactions.map((tx) => ({
    id: tx.id,
    description: tx.description ?? '',
    amount: tx.amount,
    date: tx.date ? (typeof tx.date === 'string' ? tx.date : (tx.date as Date).toISOString()) : new Date().toISOString(),
  }));

  // ── 3. Run unified engine (exact mode) ─────────────────────────
  const candidates = clusterCandidates(transactions, config, {
    mode: 'exact',
    extraNumberStrip: true,
  });

  // ── 4. Fetch supporting data ───────────────────────────────────
  const existingRules = await db.bankRule.findMany({
    where: { companyId, isActive: true },
    select: { conditionValue: true, conditionType: true },
  });

  const glAccounts = await db.glAccount.findMany({
    where: { companyId, isActive: true },
    select: { id: true, name: true, code: true, accountType: true },
  });

  const contexts = await db.entityContext.findMany({
    where: { companyId },
    include: { glAccount: true },
  });

  const knownSocioPatterns = contexts
    .filter((ctx) => ctx.role.toUpperCase() === 'SOCIO')
    .map((ctx) => ctx.pattern.toLowerCase());

  // ── 5. Build descriptions map (entityKey → raw sample) ─────────
  const descriptions = new Map<string, string>();
  for (const c of candidates) {
    descriptions.set(c.canonicalName.toLowerCase(), c.sampleDescriptions[0] ?? '');
  }

  // ── 6. Enrich candidates (no requireRole — context-less now included with low confidence) ──
  const enriched = enrichCandidates(candidates, descriptions, {
    contexts,
    glAccounts,
    rolePriorities: await loadRolePriorities(),
    knownSocioPatterns,
    existingRules,
  }, {
    smartFrequency: true,
  });

  // ── 7. Map enriched candidates to ScanPattern[] ────────────────
  const patterns = enriched.map((e) => {
      const entityKey = e.canonicalName.toLowerCase();
      const entry: ScanEntry = {
        count: e.occurrences,
        sample: e.sampleDescriptions[0] ?? '',
        totalAmount: e.totalAmount ?? 0,
        debitCount: Math.round(e.directionProfile.debitPct * e.occurrences),
        creditCount: e.occurrences - Math.round(e.directionProfile.debitPct * e.occurrences),
      };
      return buildScanPattern(e, entityKey, entry);
    });

  // ── 8. Sort by most frequent first ─────────────────────────────
  patterns.sort((a, b) => b.occurrences - a.occurrences);

  return NextResponse.json({ patterns });
});
