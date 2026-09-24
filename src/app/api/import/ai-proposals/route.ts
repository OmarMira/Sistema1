import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import {
  decideAiProposal,
  listPendingAiProposals,
  type DecideAiProposalResult,
} from '@/lib/services/ai-proposal-approval.service';

// ─── /api/import/ai-proposals ─────────────────────────────────────────────
// Thin HTTP boundary over the S10 1B.2B.2 server authority. All domain
// rules — tenant chain, importHash resolution, CAS consumption, atomic
// accounting via reclassifyTransaction, post-commit KE — live in
// `ai-proposal-approval.service.ts`; this file only parses, authorizes,
// and maps domain results to HTTP. No UI here.

function mapDecisionResult(result: DecideAiProposalResult): NextResponse {
  switch (result.status) {
    case 'OK':
      return NextResponse.json({
        decision: result.decision,
        approval: { id: result.approvalId, status: result.approvalStatus },
        ...(result.decision !== 'REJECT'
          ? { transaction: result.transaction }
          : {}),
      });
    case 'APPROVAL_NOT_FOUND':
    case 'INVALID_ACTION':
    case 'TENANT_MISMATCH':
      // Tenant-safe: mismatched payloads and foreign approvals are
      // indistinguishable from a missing proposal.
      return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
    case 'NOT_PENDING':
      return NextResponse.json(
        { error: 'Proposal already consumed' },
        { status: 409 },
      );
    case 'INVALID_DECISION':
    case 'INVALID_INPUT':
    case 'INVALID_GL_ACCOUNT':
      return NextResponse.json({ error: 'Invalid decision input' }, { status: 400 });
    case 'INVALID_CONFIRMED_ENTITY':
      return NextResponse.json(
        {
          error:
            'confirmedEntity must include a non-empty canonicalName and a valid entityType',
        },
        { status: 400 },
      );
    case 'RECLASSIFY_REJECTED': {
      // Mirror the pre-existing HTTP contract of PATCH /api/transactions/[id].
      if (result.detail === 'GL_ACCOUNT_NOT_FOUND') {
        return NextResponse.json(
          { error: 'GL account not found or inactive' },
          { status: 404 },
        );
      }
      if (result.detail === 'TRANSACTION_NOT_FOUND') {
        return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
      }
      return NextResponse.json({ error: 'Reclassification rejected' }, { status: 422 });
    }
  }
}

// GET /api/import/ai-proposals
// Pending ai_classification_proposal approvals whose tenant ownership is
// proven (payload.companyId + importHash → BankTransaction in tenant).
export const GET = apiHandler(async () => {
  const { companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin', 'employee']);

  const proposals = await listPendingAiProposals(companyId);
  return NextResponse.json({ proposals });
});

// POST /api/import/ai-proposals
// Human decision over one pending proposal: ACCEPT | CORRECT | REJECT.
export const POST = apiHandler(async (request: NextRequest) => {
  const { companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin', 'employee']);

  const body: unknown = await request.json();
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { approvalId, decision, glAccountId, confirmedEntity } = body as Record<
    string,
    unknown
  >;

  const result = await decideAiProposal({
    companyId,
    approvalId,
    decision,
    glAccountId,
    confirmedEntity,
  });
  return mapDecisionResult(result);
});
