import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { createAuditLogWithRetry } from '@/lib/audit';
import { createLearningRuleSchema } from '@/lib/validations/learning-rule';
import { logger } from '@/lib/logger';

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  const body = await request.json();
  const parsed = createLearningRuleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const {
      pattern,
      lockedDirection,
      glAccountCode,
      role,
      createSubAccount,
      subAccountName,
      // v2 parameters
      conditions,
      debitGlAccountId,
      creditGlAccountId,
      debitGlAccountCode,
      creditGlAccountCode,
      priority,
    } = parsed.data;

    if (!pattern && (!conditions || !Array.isArray(conditions))) {
      return NextResponse.json(
        { error: 'companyId, and pattern or conditions are required' },
        { status: 400 },
      );
    }

    // Pre-resolve GL account IDs outside the transaction (read-only lookups)
    let resolvedDebitGlAccountId = debitGlAccountId || null;
    let resolvedCreditGlAccountId = creditGlAccountId || null;

    if (debitGlAccountCode) {
      const dbAcc = await db.glAccount.findFirst({
        where: { companyId, code: debitGlAccountCode, isActive: true },
      });
      if (dbAcc) resolvedDebitGlAccountId = dbAcc.id;
    }

    if (creditGlAccountCode) {
      const dbAcc = await db.glAccount.findFirst({
        where: { companyId, code: creditGlAccountCode, isActive: true },
      });
      if (dbAcc) resolvedCreditGlAccountId = dbAcc.id;
    }

    // Pre-resolve parent GL account for legacy path
    let parentAccount: {
      id: string;
      code: string;
      accountType: string;
      normalBalance: string;
      name: string;
      parentId: string | null;
    } | null = null;
    if (glAccountCode) {
      parentAccount = await db.glAccount.findFirst({
        where: { companyId, code: glAccountCode, isActive: true },
        select: {
          id: true,
          code: true,
          accountType: true,
          normalBalance: true,
          name: true,
          parentId: true,
        },
      });
      if (!parentAccount) {
        return NextResponse.json(
          {
            error: `GL account ${glAccountCode} not found in this company. Select a valid account or create one first.`,
            code: 'GL_ACCOUNT_NOT_FOUND',
          },
          { status: 400 },
        );
      }
    }

    // Pre-fetch siblings for sub-account code generation is now done INSIDE
    // the transaction to prevent race conditions (two partners created at the
    // same time would both see 0 siblings and collide on 3040-01).

    // ─── Single atomic transaction ────────────────────────────────────
    const rule = await db.$transaction(async (tx) => {
      let legacyGlAccountId: string | null = null;

      if (parentAccount) {
        let finalGlAccountId = parentAccount.id;

        if (createSubAccount && subAccountName?.trim()) {
          // Fetch siblings INSIDE the transaction so concurrent partner creation
          // cannot produce duplicate codes. PostgreSQL serializes writes per transaction.
          const siblings = await tx.glAccount.findMany({
            where: { companyId, parentId: parentAccount.id },
            orderBy: { code: 'desc' },
            select: { code: true },
          });

          let nextCode = `${parentAccount.code}-01`;
          if (siblings.length > 0) {
            const lastCode = siblings[0].code;
            const parts = lastCode.split('-');
            if (parts.length > 1) {
              const suffixNum = parseInt(parts[parts.length - 1], 10) + 1;
              const suffixStr = suffixNum.toString().padStart(2, '0');
              nextCode = `${parentAccount.code}-${suffixStr}`;
            }
          }

          // Create new sub-account inside transaction — find free code if race
          while (
            await tx.glAccount.findUnique({
              where: { companyId_code: { companyId, code: nextCode } },
            })
          ) {
            const parts = nextCode.split('-');
            const suffixNum = parseInt(parts[parts.length - 1], 10) + 1;
            nextCode = `${parentAccount.code}-${suffixNum.toString().padStart(2, '0')}`;
          }
          const capitalizedSubName = subAccountName
            .trim()
            .split(/\s+/)
            .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');
          const subAccount = await tx.glAccount.create({
            data: {
              companyId,
              code: nextCode,
              name: `${parentAccount.name} - ${capitalizedSubName}`,
              accountType: parentAccount.accountType,
              normalBalance: parentAccount.normalBalance,
              parentId: parentAccount.id,
              isActive: true,
            },
          });
          finalGlAccountId = subAccount.id;
        }

        legacyGlAccountId = finalGlAccountId;

        // Apply 3-way mapping logic to set bifurcated accounts if not explicitly set
        if (!resolvedDebitGlAccountId && !resolvedCreditGlAccountId) {
          const direction = lockedDirection || 'any';
          if (direction === 'debit') {
            resolvedDebitGlAccountId = finalGlAccountId;
          } else if (direction === 'credit') {
            resolvedCreditGlAccountId = finalGlAccountId;
          } else {
            resolvedDebitGlAccountId = finalGlAccountId;
            resolvedCreditGlAccountId = finalGlAccountId;
          }
        }
      }

      const defaultConditionType = pattern ? 'contains' : conditions?.[0]?.operator || 'contains';
      const defaultConditionValue = pattern || conditions?.[0]?.value || '';

      const capitalizedPattern = pattern
        ? pattern
            .trim()
            .split(/\s+/)
            .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ')
        : 'V2 Composite';

      // Determine the parent account's name dynamically. If it is already a sub-account (parentId exists and code contains a hyphen), use its parent's name.
      let ruleParentName = parentAccount?.name || '';
      if (parentAccount && !createSubAccount && parentAccount.parentId) {
        if (parentAccount.code.includes('-')) {
          const gp = await tx.glAccount.findUnique({
            where: { id: parentAccount.parentId },
            select: { name: true },
          });
          if (gp) {
            ruleParentName = gp.name;
          }
        }
      }

      // Create Bank Matching Rule inside transaction
      const newRule = await tx.bankRule.create({
        data: {
          companyId,
          name:
            parsed.data.name ||
            (parentAccount
              ? `${parentAccount.code} / ${ruleParentName} - ${capitalizedPattern}`
              : `Rule: ${capitalizedPattern}`),
          conditionType: defaultConditionType,
          conditionValue: defaultConditionValue,
          transactionDirection: lockedDirection || 'any',
          glAccountId: legacyGlAccountId,
          conditions:
            (conditions as Array<{ field: string; operator: string; value: string | number }>) ??
            null,
          debitGlAccountId: resolvedDebitGlAccountId,
          creditGlAccountId: resolvedCreditGlAccountId,
          priority: parsed.data.priority ?? 10,
          isActive: true,
        },
      });

      // Upsert Entity Context inside transaction
      if (pattern && role && legacyGlAccountId) {
        const normalizedPattern = pattern.toLowerCase();
        await tx.entityContext.upsert({
          where: {
            companyId_pattern: {
              companyId,
              pattern: normalizedPattern,
            },
          },
          update: {
            role,
            glAccountId: legacyGlAccountId,
            source: 'user',
          },
          create: {
            companyId,
            pattern: normalizedPattern,
            role,
            glAccountId: legacyGlAccountId,
            source: 'user',
          },
        });
      }

      // Write Audit Log inside transaction — if this throws, everything rolls back
      await createAuditLogWithRetry(
        {
          companyId,
          userId,
          action: 'RULE_CREATED_WITH_CONTEXT',
          entity: 'BankRule',
          details: JSON.stringify({
            ruleId: newRule.id,
            pattern,
            lockedDirection,
            glAccountId: legacyGlAccountId,
            debitGlAccountId: resolvedDebitGlAccountId,
            creditGlAccountId: resolvedCreditGlAccountId,
            role,
            createSubAccount,
            subAccountName,
          }),
        },
         
        tx as any,
      );

      return newRule;
    });
    // ─────────────────────────────────────────────────────────────────

    return NextResponse.json({ success: true, data: rule });
  } catch (error: unknown) {
    logger.error('[POST LEARNING RULE ERROR]', { error: String(error) });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
});
