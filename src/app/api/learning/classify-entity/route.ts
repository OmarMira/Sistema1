import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { classifyEntity, getEntityCandidates } from '@/lib/services/entity-classifier';
import { parseConversationalContext } from '@/lib/services/conversational-service';
import { safeAuditLog } from '@/lib/services/audit-service';
import { db } from '@/lib/db';
import { transactionIntentSchema } from '@/lib/constants/transaction-intent';
import { logger } from '@/lib/logger';
import { serverT } from '@/lib/server-i18n';

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const locale = request.headers.get('x-locale') ?? 'en';

  try {
    const body = await request.json();
    const { pattern, userInput, glAccountCode, role, transactionDirection, directionOverride, userDescription, intent, autoAssign, createRule } = body;

    if (!pattern) {
      return NextResponse.json(
        { error: serverT(locale, 'learning.patternRequired') },
        { status: 400 },
      );
    }

    // Validate intent only when a concrete value is provided; null/undefined mean no intent.
    const intentResult = intent == null ? null : transactionIntentSchema.safeParse(intent);
    if (intentResult !== null && !intentResult.success) {
      return NextResponse.json(
        { error: 'Invalid intent value' },
        { status: 400 },
      );
    }
    const parsedIntent = intentResult === null ? null : intentResult.data;

    const trimmedUserDescription = typeof userDescription === 'string' ? userDescription.trim() : userDescription;

    // Log direction override for audit trail
    if (directionOverride) {
      logger.warn('[DIRECTION OVERRIDE]', { pattern, role, userId });
    }

    let finalRole = role;
    let finalGlAccountCode = glAccountCode;

    if (!finalRole) {
      // Fallback AI inference for conversational flow
      const parseResult = await parseConversationalContext(
        companyId,
        pattern,
        userInput || pattern,
        userId,
        undefined,
        undefined,
        undefined,
        locale,
      );
      finalRole = parseResult.role;
      finalGlAccountCode = finalGlAccountCode || parseResult.glAccountCode;
    }

    // Validate userDescription is required when role resolves to OTRO
    if (finalRole === 'OTRO' && !trimmedUserDescription) {
      return NextResponse.json(
        { error: 'userDescription is required when role is OTRO' },
        { status: 400 },
      );
    }

    // Validate createRule prerequisite
    if (createRule === true && (!parsedIntent || !finalGlAccountCode)) {
      return NextResponse.json(
        { error: 'Intent and GL account are required when createRule is true' },
        { status: 400 },
      );
    }

    const classifyResult = await classifyEntity({
      companyId,
      pattern,
      role: finalRole,
      roles: [finalRole],
      glAccountCode: finalGlAccountCode || undefined,
      source: 'user',
      userId,
      transactionDirection: transactionDirection ?? undefined,
      userDescription: trimmedUserDescription ?? null,
      intent: parsedIntent,
      createRule: createRule === true,
      ...(autoAssign !== undefined ? { autoAssign } : {}),
    });

    const ruleRequested = createRule === true;
    const ruleCreationWarning = classifyResult.warning ? true : false;

    await safeAuditLog({
      companyId,
      userId,
      action: 'ENTITY_CLASSIFIED',
      entity: 'EntityContext',
      details: {
        pattern,
        role: finalRole,
        glAccountCode: finalGlAccountCode || null,
        directionOverride: directionOverride || undefined,
        intent: parsedIntent,
        userDescription: trimmedUserDescription ?? null,
        ruleCreated: ruleRequested && !ruleCreationWarning,
        requiresReview: ruleRequested && ruleCreationWarning,
        createRule: ruleRequested,
      },
    });

    return NextResponse.json({
      success: true,
      data: { role: finalRole, entityContext: classifyResult.context },
      ...(classifyResult.warning ? { warning: classifyResult.warning } : {}),
      ...(ruleRequested && !ruleCreationWarning ? { ruleCreated: true } : {}),
      ...(ruleRequested && ruleCreationWarning ? { ruleCreated: false, requiresReview: true } : {}),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : serverT(locale, 'learning.serverError');
    logger.error('[CLASSIFY ENTITY ERROR]', { error: msg });
    if (msg.includes('CONFLICT')) {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});

export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const locale = request.headers.get('x-locale') ?? 'en';
  const { searchParams } = new URL(request.url);
  const includeOtro = searchParams.get('includeOtro') === 'true';

  try {
    if (includeOtro) {
      // Return OTRO entities for review/re-classification
      const otroEntities = await db.entityContext.findMany({
        where: { companyId, role: 'OTRO' },
        orderBy: { updatedAt: 'desc' },
      });

      await safeAuditLog({
        companyId,
        userId,
        action: 'ENTITY_OTRO_FETCHED',
        entity: 'EntityContext',
        details: { count: otroEntities.length },
      });

      return NextResponse.json({ success: true, data: otroEntities });
    }

    const candidates = await getEntityCandidates(companyId);

    await safeAuditLog({
      companyId,
      userId,
      action: 'ENTITY_CANDIDATES_FETCHED',
      entity: 'EntityContext',
      details: { count: candidates.length },
    });

    return NextResponse.json({ success: true, data: candidates });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : serverT(locale, 'learning.serverError');
    logger.error('[ENTITY CANDIDATES ERROR]', { error: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});
