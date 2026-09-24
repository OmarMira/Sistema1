import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { resolveEntity } from '@/memory/entity-resolution';
import { EntityTypeValues, type EntityType } from '@/internal/company-knowledge/entity/types';
import { reclassifyTransaction } from '@/lib/services/transaction-reclassification.service';

// ─── PATCH /api/transactions/[id] ───────────────────────────────────────
// Manual GL account assignment: updates the transaction and creates the
// corresponding journal entry automatically.
//
// S10 1B.2A: this handler is ONLY the HTTP boundary (parsing, auth,
// request validation, response mapping). The certified domain sequence —
// tenant-scoped lookup, GL validation, fiscal guard, journal void/repost,
// Knowledge Engine learning — lives in the single reusable server
// authority `reclassifyTransaction`. Do not re-implement any part of that
// sequence here; future consumers (ai_classification_proposal) must call
// the same authority directly instead of duplicating or HTTP-proxying it.
export const PATCH = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin', 'employee']);
  const { id } = await context.params;

  const body = await request.json();
  const { glAccountId, confirmedEntity } = body as {
    glAccountId: string;
    confirmedEntity?: {
      canonicalName: string;
      entityType: EntityType;
    };
  };

  if (!glAccountId) {
    return NextResponse.json(
      { error: 'glAccountId is required' },
      { status: 400 },
    );
  }

  // Validate confirmedEntity BEFORE any side effect. When present it must be
  // an object with a trim-non-empty canonicalName and an entityType member of
  // EntityTypeValues — otherwise the request is rejected with 400 so invalid
  // identity confirmations never reach confirmEntityIdentity.
  if (confirmedEntity !== undefined && confirmedEntity !== null) {
    const ce = confirmedEntity as { canonicalName?: unknown; entityType?: unknown };
    const canonicalNameOk =
      typeof ce === 'object' &&
      typeof ce.canonicalName === 'string' &&
      ce.canonicalName.trim().length > 0;
    const entityTypeOk =
      typeof ce.entityType === 'string' &&
      (EntityTypeValues as readonly string[]).includes(ce.entityType);
    if (!canonicalNameOk || !entityTypeOk) {
      return NextResponse.json(
        {
          error:
            'confirmedEntity must include a non-empty canonicalName and a valid entityType',
        },
        { status: 400 },
      );
    }
  }

  // Domain operation: single certified authority (accounting + learning).
  // Domain results map 1:1 onto the pre-extraction HTTP contract.
  const outcome = await reclassifyTransaction({
    companyId,
    transactionId: id,
    glAccountId,
    confirmedEntity,
  });

  if (outcome.status === 'TRANSACTION_NOT_FOUND') {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
  }
  if (outcome.status === 'GL_ACCOUNT_NOT_FOUND') {
    return NextResponse.json(
      { error: 'GL account not found or inactive' },
      { status: 404 },
    );
  }

  return NextResponse.json({ transaction: outcome.transaction });
});

// ─── GET /api/transactions/[id] ───────────────────────────────────────────
// Entity-status endpoint for ReclassifyDialog: reports whether the
// transaction description already resolves to a known entity identity.
// Read-only: no learning, no writes. On resolution failure the client
// degrades to GL-only, so the response is 200 { entityStatus: 'ERROR' }
// instead of a 500.
export const GET = apiHandler(async (_request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin', 'employee']);
  const { id } = await context.params;

  const transaction = await db.bankTransaction.findFirst({
    where: { id, statement: { bankAccount: { companyId } } },
    select: { id: true, description: true },
  });

  if (!transaction) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
  }

  try {
    const resolution = await resolveEntity(companyId, transaction.description);
    if (resolution.status === 'KNOWN') {
      return NextResponse.json({
        entityStatus: 'KNOWN',
        entityId: resolution.entityId,
        transaction: { id: transaction.id, description: transaction.description },
      });
    }
    if (resolution.status === 'UNKNOWN') {
      return NextResponse.json({
        entityStatus: 'UNKNOWN',
        transaction: { id: transaction.id, description: transaction.description },
      });
    }
    return NextResponse.json({ entityStatus: 'ERROR' });
  } catch {
    return NextResponse.json({ entityStatus: 'ERROR' });
  }
});
