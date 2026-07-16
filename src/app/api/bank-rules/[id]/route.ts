import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { createAuditLogWithRetry } from '@/lib/audit';
import { validateDirectionProfile } from '@/lib/services/direction-validation';
import { serverT } from '@/lib/server-i18n';
import { transactionIntentSchema } from '@/lib/constants/transaction-intent';
import { eligibleForClassificationWhere } from '@/lib/services/transaction-invariants';

import {
  transactionMatchesRule,
  loadEntityFirstContext,
  type Transaction,
  type Rule,
} from '@/lib/services/rule-matching-engine';

const bankRuleEntityContextAuditSelect = {
  id: true,
  userDescription: true,
  role: true,
  pattern: true,
} as const;

// ─── GET /api/bank-rules/[id] ──────────────────────────────────────
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { id } = await context.params;

  const rule = await db.bankRule.findFirst({
    where: { id, companyId },
    include: {
      glAccount: {
        select: { id: true, code: true, name: true, accountType: true },
      },
      entityContext: {
        select: bankRuleEntityContextAuditSelect,
      },
      _count: {
        select: { transactions: true },
      },
    },
  });

  if (!rule) {
    return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
  }

  return NextResponse.json({
    ...rule,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    _matchCount: rule._count.transactions,
  });
});

// ─── PUT /api/bank-rules/[id] ──────────────────────────────────────
export const PUT = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { id } = await context.params;

  const body = await request.json();
  const {
    name,
    conditionType,
    conditionValue,
    transactionDirection,
    glAccountId,
    priority,
    isActive,
    conditions,
    debitGlAccountId,
    creditGlAccountId,
    intent,
  } = body;

  // Find existing rule
  const existing = await db.bankRule.findFirst({ where: { id, companyId } });
  if (!existing) {
    return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
  }

  // Validate fields if provided
  if (name !== undefined && name !== null && !String(name).trim()) {
    return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
  }

  // Check for duplicate name within the same company
  if (name !== undefined && name !== null && String(name).trim()) {
    const dupName = await db.bankRule.findFirst({
      where: { companyId, name: String(name).trim(), NOT: { id } },
    });
    if (dupName) {
      const locale = request.headers.get('x-locale') || 'es';
      return NextResponse.json(
        { error: serverT(locale, 'bankRules.errors.duplicateName') },
        { status: 409 },
      );
    }
  }

  if (transactionDirection !== undefined) {
    const validDirections = ['debit', 'credit', 'any'];
    if (!validDirections.includes(transactionDirection)) {
      return NextResponse.json(
        { error: 'transactionDirection must be debit, credit, or any' },
        { status: 400 },
      );
    }
  }

  const hasIntent = Object.prototype.hasOwnProperty.call(body, 'intent');
  const intentResult = !hasIntent || intent == null ? null : transactionIntentSchema.safeParse(intent);
  if (intentResult !== null && !intentResult.success) {
    return NextResponse.json({ error: 'Invalid intent value' }, { status: 400 });
  }
  const parsedIntent = intentResult === null ? null : intentResult.data;

  if (conditions !== undefined) {
    if (!Array.isArray(conditions) || conditions.length === 0) {
      return NextResponse.json({ error: 'conditions must be a non-empty array' }, { status: 400 });
    }
    for (const cond of conditions) {
      if (!cond.field || !['description', 'amount'].includes(cond.field.toLowerCase())) {
        return NextResponse.json(
          { error: "condition field must be 'description' or 'amount'" },
          { status: 400 },
        );
      }
      const validConditionTypes = [
        'contains',
        'starts_with',
        'ends_with',
        'equals',
        'amount_greater',
        'amount_less',
        'greater_than',
        'less_than',
      ];
      if (!cond.operator || !validConditionTypes.includes(cond.operator)) {
        return NextResponse.json(
          { error: `condition operator must be one of: ${validConditionTypes.join(', ')}` },
          { status: 400 },
        );
      }
      if (
        cond.value === undefined ||
        cond.value === null ||
        cond.value === '' ||
        !String(cond.value).trim()
      ) {
        return NextResponse.json({ error: 'condition value cannot be empty' }, { status: 400 });
      }
      if (
        (cond.operator === 'amount_greater' || cond.operator === 'amount_less') &&
        isNaN(Number(cond.value))
      ) {
        return NextResponse.json(
          { error: 'condition value must be a number for amount conditions' },
          { status: 400 },
        );
      }
    }
  } else if (conditionType !== undefined || conditionValue !== undefined) {
    const type = conditionType !== undefined ? conditionType : existing.conditionType;
    const val = conditionValue !== undefined ? conditionValue : existing.conditionValue;

    const validConditionTypes = [
      'contains',
      'starts_with',
      'ends_with',
      'equals',
      'amount_greater',
      'amount_less',
      'greater_than',
      'less_than',
    ];
    if (!validConditionTypes.includes(type)) {
      return NextResponse.json(
        { error: `conditionType must be one of: ${validConditionTypes.join(', ')}` },
        { status: 400 },
      );
    }
    if (!val || !String(val).trim()) {
      return NextResponse.json({ error: 'conditionValue cannot be empty' }, { status: 400 });
    }
    if ((type === 'amount_greater' || type === 'amount_less') && isNaN(Number(val))) {
      return NextResponse.json(
        { error: 'conditionValue must be a number for amount conditions' },
        { status: 400 },
      );
    }
  }

  const glAccountIdsToCheck: string[] = [];
  if (glAccountId !== undefined) glAccountIdsToCheck.push(glAccountId);
  if (debitGlAccountId !== undefined && debitGlAccountId !== null)
    glAccountIdsToCheck.push(debitGlAccountId);
  if (creditGlAccountId !== undefined && creditGlAccountId !== null)
    glAccountIdsToCheck.push(creditGlAccountId);

  if (glAccountIdsToCheck.length > 0) {
    const existingAccounts = await db.glAccount.findMany({
      where: { id: { in: glAccountIdsToCheck }, companyId: existing.companyId, isActive: true },
      select: { id: true },
    });
    const existingAccountIds = new Set(existingAccounts.map((a) => a.id));

    if (glAccountId !== undefined && !existingAccountIds.has(glAccountId)) {
      return NextResponse.json(
        { error: 'GL account not found or does not belong to this company' },
        { status: 400 },
      );
    }
    if (
      debitGlAccountId !== undefined &&
      debitGlAccountId !== null &&
      !existingAccountIds.has(debitGlAccountId)
    ) {
      return NextResponse.json(
        { error: 'Debit GL account not found or does not belong to this company' },
        { status: 400 },
      );
    }
    if (
      creditGlAccountId !== undefined &&
      creditGlAccountId !== null &&
      !existingAccountIds.has(creditGlAccountId)
    ) {
      return NextResponse.json(
        { error: 'Credit GL account not found or does not belong to this company' },
        { status: 400 },
      );
    }
  }

  if (priority !== undefined) {
    const p = Math.round(priority);
    if (p < 0 || p > 20) {
      return NextResponse.json({ error: 'priority must be between 0 and 20' }, { status: 400 });
    }
  }

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = String(name).trim();
  if (conditionType !== undefined) updateData.conditionType = conditionType;
  if (conditionValue !== undefined) updateData.conditionValue = String(conditionValue).trim();

  if (conditions !== undefined) {
    updateData.conditions = conditions;
    updateData.conditionType = conditions[0].operator;
    updateData.conditionValue = conditions[0].value;
  } else if (conditionType !== undefined || conditionValue !== undefined) {
    const activeType = conditionType !== undefined ? conditionType : existing.conditionType;
    const activeValue =
      conditionValue !== undefined ? String(conditionValue).trim() : existing.conditionValue;
    updateData.conditions = [
      {
        field: 'description',
        operator: activeType,
        value: activeValue,
      },
    ];
  }

  if (transactionDirection !== undefined) updateData.transactionDirection = transactionDirection;
  if (glAccountId !== undefined) updateData.glAccountId = glAccountId;
  if (debitGlAccountId !== undefined) updateData.debitGlAccountId = debitGlAccountId;
  if (creditGlAccountId !== undefined) updateData.creditGlAccountId = creditGlAccountId;
  if (hasIntent) updateData.intent = parsedIntent;

  const finalDebit = debitGlAccountId !== undefined ? debitGlAccountId : existing.debitGlAccountId;
  const finalCredit =
    creditGlAccountId !== undefined ? creditGlAccountId : existing.creditGlAccountId;
  const finalDirection =
    transactionDirection !== undefined ? transactionDirection : existing.transactionDirection;
  if (glAccountId === undefined) {
    if (finalDirection === 'debit') {
      updateData.glAccountId = finalDebit;
    } else if (finalDirection === 'credit') {
      updateData.glAccountId = finalCredit;
    } else {
      updateData.glAccountId = finalDebit || finalCredit || null;
    }
  }

  // Direction profile validation if bifurcated accounts are provided
  if (debitGlAccountId !== undefined || creditGlAccountId !== undefined) {
    try {
      await validateDirectionProfile(
        companyId,
        debitGlAccountId !== undefined ? debitGlAccountId : existing.debitGlAccountId,
        creditGlAccountId !== undefined ? creditGlAccountId : existing.creditGlAccountId,
      );
    } catch (validationErr: unknown) {
      const validationMsg =
        validationErr instanceof Error
          ? validationErr.message
          : 'Direction profile validation failed';
      return NextResponse.json({ error: validationMsg }, { status: 400 });
    }
  }

  if (priority !== undefined) updateData.priority = Math.round(priority);
  if (isActive !== undefined) updateData.isActive = Boolean(isActive);

  // ─── Manual edit detection ────────────────────────────────────────
  // Any field change besides isActive flips isManuallyEdited=true
  const nonIsActiveFields = ['name', 'conditionType', 'conditionValue', 'transactionDirection',
    'glAccountId', 'conditions', 'debitGlAccountId', 'creditGlAccountId', 'priority', 'intent'];
  const hasNonIsActiveChange = nonIsActiveFields.some((f) => {
    if (!Object.prototype.hasOwnProperty.call(body, f)) return false;

    const nextValue = f === 'intent' ? parsedIntent : body[f];
    return String(nextValue) !== String((existing as Record<string, unknown>)[f]);
  });
  if (hasNonIsActiveChange) {
    updateData.isManuallyEdited = true;
  }
  // ──────────────────────────────────────────────────────────────────

  const rule = await db.bankRule.update({
    where: { id },
    data: updateData,
    include: {
      glAccount: {
        select: { id: true, code: true, name: true, accountType: true },
      },
      debitGlAccount: {
        select: { id: true, code: true, name: true, accountType: true },
      },
      creditGlAccount: {
        select: { id: true, code: true, name: true, accountType: true },
      },
      entityContext: {
        select: bankRuleEntityContextAuditSelect,
      },
      _count: {
        select: { transactions: true },
      },
    },
  });

  return NextResponse.json({
    ...rule,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    _matchCount: rule._count.transactions,
  });
});

// ─── DELETE /api/bank-rules/[id] ───────────────────────────────────
export const DELETE = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { id } = await context.params;

  const existing = await db.bankRule.findFirst({ where: { id, companyId } });
  if (!existing) {
    return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
  }

  // Clear matchedRuleId from transactions that reference this rule
  await db.bankTransaction.updateMany({
    where: { matchedRuleId: id },
    data: { matchedRuleId: null },
  });

  await db.bankRule.delete({ where: { id } });

  return NextResponse.json({ success: true });
});

// ─── POST /api/bank-rules/[id] (action=apply) ──────────────────────
// Apply this single rule to all unmatched transactions.
// Body: { action: 'apply' }
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { id } = await context.params;

  const body = await request.json();
  const { action } = body;

  if (action !== 'apply') {
    return NextResponse.json({ error: "Invalid action. Use 'apply'." }, { status: 400 });
  }

  const rule = await db.bankRule.findFirst({
    where: { id, companyId },
  });
  if (!rule) {
    return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
  }

  if (!rule.isActive) {
    return NextResponse.json({ error: 'Cannot apply an inactive rule' }, { status: 400 });
  }

  // Load entity-first context for SOCIO conflict detection
  const efCtx = await loadEntityFirstContext(companyId);

  // Find all unmatched transactions for this company (via statements)
  const companyStatements = await db.bankStatement.findMany({
    where: { companyId: rule.companyId },
    select: { id: true },
  });
  const statementIds = companyStatements.map((s) => s.id);

  const unmatchedTransactions = await db.bankTransaction.findMany({
    where: eligibleForClassificationWhere({
      statementId: { in: statementIds },
    }),
  });

  // Match transactions in memory
  const matchedIds = unmatchedTransactions
    .filter((tx) =>
      transactionMatchesRule(
        tx as Transaction,
        rule as Rule,
        efCtx.knownSocioPatterns,
        efCtx.entityFirstMode,
      ),
    )
    .map((tx) => tx.id);

  // Update matched transactions with TOCTOU defense
  // Batch updateMany re-evaluates the invariant filter at UPDATE time,
  // so protected transactions are silently excluded without per-ID looping.
  let actualMatched = 0;

  if (matchedIds.length > 0) {
    const debitIds: string[] = [];
    const creditIds: string[] = [];

    for (const txId of matchedIds) {
      const tx = unmatchedTransactions.find((t) => t.id === txId);
      if (tx) {
        if (tx.amount < 0) debitIds.push(txId);
        else creditIds.push(txId);
      }
    }

    if (debitIds.length > 0) {
      const debitAccountId = rule.debitGlAccountId || rule.glAccountId;
      const result = await db.bankTransaction.updateMany({
        where: eligibleForClassificationWhere({ id: { in: debitIds } }),
        data: { glAccountId: debitAccountId, matchedRuleId: rule.id },
      });
      actualMatched += result.count;
    }

    if (creditIds.length > 0) {
      const creditAccountId = rule.creditGlAccountId || rule.glAccountId;
      const result = await db.bankTransaction.updateMany({
        where: eligibleForClassificationWhere({ id: { in: creditIds } }),
        data: { glAccountId: creditAccountId, matchedRuleId: rule.id },
      });
      actualMatched += result.count;
    }
  }

  if (actualMatched < matchedIds.length) {
    console.warn(
      `[single-rule apply] ${matchedIds.length - actualMatched} of ${matchedIds.length} ` +
      `candidate transactions were protected and not updated (TOCTOU).`,
    );
  }

  await createAuditLogWithRetry({
    companyId,
    userId,
    action: 'RULE_APPLIED',
    entity: 'BankRule',
    entityId: rule.id,
    details: JSON.stringify({ matchedCount: actualMatched, ruleName: rule.name }),
  });

  return NextResponse.json({
    success: true,
    matched: actualMatched,
    total: unmatchedTransactions.length,
  });
});
