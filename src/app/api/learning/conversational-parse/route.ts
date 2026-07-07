import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { parseConversationalContext } from '@/lib/services/conversational-service';
import { safeAuditLog } from '@/lib/services/audit-service';
import { logger } from '@/lib/logger';
import { readJsonConfig, fileExists } from '@/lib/config-loader';
import { db } from '@/lib/db';
import { conversationalParseSchema } from '@/lib/validations/conversational-parse';
import { serverT } from '@/lib/server-i18n';

// ── POST /api/learning/conversational-parse ──────────────────────
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const locale = request.headers.get('x-locale') ?? 'es';

  try {
    const raw = await request.json();
    const parsed = conversationalParseSchema.safeParse(raw);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues.map((i) => i.message).join('; ') },
        { status: 400 },
      );
    }

    const { pattern, directionProfile } = parsed.data;
    const userInput = (parsed.data.userInput || parsed.data.userAnswer)!.trim();

    // Derive direction from profile for heuristic fallback
    const threshold = 0.9;
    const direction: 'debit' | 'credit' | undefined =
      directionProfile.creditPct >= threshold
        ? 'credit'
        : directionProfile.debitPct >= threshold
          ? 'debit'
          : undefined;

    // Ejecutar el parser (con userId para auditoría de respuesta IA externa)
    const result = await parseConversationalContext(
      companyId,
      pattern,
      userInput,
      userId,
      undefined,
      undefined,
      direction,
      locale,
    );

    // ─── VALIDACIÓN CRÍTICA DE DIRECCIONALIDAD (EXTERNALIZADA) ───
    const creditPct = directionProfile.creditPct;
    const debitPct = directionProfile.debitPct;

    // Look up accountType from DB instead of inferring from code prefix
    let suggestedAccountType: string | undefined;
    if (result.glAccountCode) {
      const accountRecord = await db.glAccount.findFirst({
        where: { companyId, code: result.glAccountCode, isActive: true },
        select: { accountType: true },
      });
      suggestedAccountType = accountRecord?.accountType ?? undefined;
    }

    if (suggestedAccountType) {
      let directionProfiles: Record<
        string,
        { normalBalance: 'credit' | 'debit'; deviationThreshold: number; allowOpposite?: boolean }
      > = {};
      try {
        directionProfiles = await readJsonConfig('direction-profiles.json');
      } catch (fsErr) {
        logger.error('FS_ERROR_DIRECTION_PROFILES', { error: String(fsErr) });
      }

      const profile = directionProfiles[suggestedAccountType];
      const threshold = profile?.deviationThreshold ?? 0.9;
      const allowOpposite = profile?.allowOpposite ?? false;
      const isMixed = creditPct > 0.15 && debitPct > 0.15;

      // Only block if: entity is NOT mixed, opposite is not allowed,
      // AND the account's normal balance clearly contradicts the observed flow.
      if (!allowOpposite && !isMixed) {
        if (creditPct >= threshold && profile?.normalBalance === 'debit') {
          return NextResponse.json(
            {
              error: serverT(locale, 'learning.directionCreditError'),
            },
            { status: 400 },
          );
        }

        if (debitPct >= threshold && profile?.normalBalance === 'credit') {
          return NextResponse.json(
            {
              error: serverT(locale, 'learning.directionDebitError'),
            },
            { status: 400 },
          );
        }
      }

      // Warn (structured) when a mixed entity maps to Equity
      if (isMixed && suggestedAccountType === 'equity') {
        logger.warn('MIXED_ENTITY_CLASSIFIED_AS_EQUITY', { pattern, creditPct, debitPct });
      }
    }

    // ─── FIX: Proteger el AuditLog usando el servicio seguro ───
    try {
      await safeAuditLog({
        companyId,
        userId,
        action: 'CONVERSATIONAL_CONTEXT_PARSED',
        entity: 'EntityContext',
        details: {
          pattern,
          userInput,
          parsedRole: result.role,
          parsedGlAccountCode: result.glAccountCode,
          suggestSubAccount: result.suggestSubAccount,
        },
      });
    } catch (auditErr) {
      logger.warn('AUDIT_LOG_FAILED', { error: String(auditErr) });
    }
    // ──────────────────────────────────────────────────────────────

    return NextResponse.json({ success: true, data: result });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : serverT(locale, 'learning.serverError');
    const code = (error as Error & { code?: string }).code;
    logger.error('CONVERSATIONAL_PARSE_ROUTE_ERROR', { error: msg });
    return NextResponse.json({ error: msg, code }, { status: 500 });
  }
});
