import { db } from '@/lib/db';
import { reclassifyTransaction } from '@/lib/services/transaction-reclassification.service';
import { EntityTypeValues, type EntityType } from '@/internal/company-knowledge/entity/types';
import type { Prisma } from '@prisma/client';

// ─── S10 1B.2B.2 — AI proposal approval consumer ───────────────────────────
// Server-side authority that closes the loop:
//   AI proposal → human decision → CAS approval → reclassifyTransaction
//   → atomic commit of approval + accounting → Knowledge Engine post-commit.
//
// Design contracts (certified by 1B.2B.1):
//  - `reclassifyTransaction(input, { tx })` is the ONLY accounting
//    authority reused here — no second implementation of GL validation,
//    fiscal guard, journal void/repost, or KE learning exists in this file.
//  - KE runs exclusively through the returned once-guarded
//    `runPostCommitLearning()` hook, awaited AFTER db.$transaction resolves.
//
// Tenant chain (PendingApproval has NO companyId column):
//  session companyId
//  → approval pending + action='ai_classification_proposal'
//  → payload.companyId === session companyId
//  → payload.transactionId interpreted as BankTransaction.importHash
//  → BankTransaction resolved by importHash inside session tenant
//  → reclassifyTransaction re-validates ownership with the same companyId.
// Any failure in that chain means: no accounting mutation, no approval
// transition, no learning.

export const AI_PROPOSAL_ACTION = 'ai_classification_proposal';

const AI_PROPOSAL_DECISIONS = ['ACCEPT', 'CORRECT', 'REJECT'] as const;
export type AiProposalDecision = (typeof AI_PROPOSAL_DECISIONS)[number];

// Historical payload contract (producer: import.service.ts). The field is
// named `transactionId` but its REAL value is BankTransaction.importHash —
// never BankTransaction.id. Do not rename the historical payload.
type AiProposalPayload = {
  companyId: string;
  transactionId: string; // = BankTransaction.importHash
  bankAccountId: string;
  deterministicResult?: unknown;
  aiProposal: Record<string, unknown> & { glAccountId?: unknown };
  proposedEntity?: unknown;
};

export type PendingAiProposalItem = {
  approvalId: string;
  requestedBy: string;
  requestedAt: Date;
  bankAccountId: string;
  deterministicResult: unknown;
  aiProposal: Record<string, unknown>;
  proposedEntity: unknown;
  proposedGlAccount: { id: string; code: string; name: string } | null;
  transaction: {
    id: string;
    importHash: string;
    date: Date;
    amount: number;
    description: string;
  };
};

export type DecideAiProposalInput = {
  companyId: string;
  approvalId: unknown;
  decision: unknown;
  glAccountId?: unknown;
  confirmedEntity?: unknown;
};

export type DecideAiProposalResult =
  | {
      status: 'OK';
      decision: 'ACCEPT' | 'CORRECT';
      approvalId: string;
      approvalStatus: 'accepted' | 'corrected';
      transaction: {
        id: string;
        date: Date;
        amount: number;
        description: string;
        glAccountId: string | null;
        journalEntryId: string | null;
      };
    }
  | {
      status: 'OK';
      decision: 'REJECT';
      approvalId: string;
      approvalStatus: 'rejected';
    }
  | {
      status:
        | 'APPROVAL_NOT_FOUND'
        | 'INVALID_ACTION'
        | 'NOT_PENDING'
        | 'TENANT_MISMATCH'
        | 'INVALID_DECISION'
        | 'INVALID_INPUT'
        | 'INVALID_GL_ACCOUNT'
        | 'INVALID_CONFIRMED_ENTITY';
    }
  | { status: 'RECLASSIFY_REJECTED'; detail: string };

type ConfirmedEntity = { canonicalName: string; entityType: EntityType };

/**
 * Thrown INSIDE the decision transaction when the accounting authority
 * refuses the reclassification. The throw rolls back the CAS in the same
 * transaction, so a failed accounting phase can never consume the
 * approval — it stays `pending` and no KE ever runs.
 */
class ReclassifyRejectedError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`reclassifyTransaction rejected: ${detail}`);
    this.name = 'ReclassifyRejectedError';
    this.detail = detail;
  }
}

function parseAiProposalPayload(raw: unknown): AiProposalPayload | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const p = raw as Record<string, unknown>;
  if (typeof p.companyId !== 'string' || p.companyId.length === 0) return null;
  if (typeof p.transactionId !== 'string' || p.transactionId.length === 0) return null;
  if (typeof p.bankAccountId !== 'string' || p.bankAccountId.length === 0) return null;
  if (typeof p.aiProposal !== 'object' || p.aiProposal === null) return null;
  return p as unknown as AiProposalPayload;
}

function extractProposalGlAccountId(payload: AiProposalPayload): string | null {
  const glAccountId = payload.aiProposal.glAccountId;
  return typeof glAccountId === 'string' && glAccountId.trim().length > 0
    ? glAccountId
    : null;
}

/**
 * Mirrors the certified confirmedEntity validation of
 * PATCH /api/transactions/[id]: absent/null → undefined; a present value
 * must carry a trim-non-empty canonicalName and an entityType member of
 * EntityTypeValues. Returns `null` for INVALID values.
 */
function parseConfirmedEntity(value: unknown): ConfirmedEntity | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object') {
    return null;
  }
  const ce = value as { canonicalName?: unknown; entityType?: unknown };
  const canonicalNameOk =
    typeof ce.canonicalName === 'string' && ce.canonicalName.trim().length > 0;
  const entityTypeOk =
    typeof ce.entityType === 'string' &&
    (EntityTypeValues as readonly string[]).includes(ce.entityType);
  if (!canonicalNameOk || !entityTypeOk) {
    return null;
  }
  return {
    canonicalName: (ce.canonicalName as string).trim(),
    entityType: ce.entityType as EntityType,
  };
}

/**
 * List pending AI classification proposals for the active company.
 *
 * Tenant safety: a row is returned ONLY when payload.companyId matches AND
 * the payload's importHash resolves to a BankTransaction that demonstrably
 * belongs to the session tenant. Payload JSON alone is never treated as
 * authority.
 */
export async function listPendingAiProposals(
  companyId: string,
): Promise<PendingAiProposalItem[]> {
  const rows = await db.pendingApproval.findMany({
    where: { action: AI_PROPOSAL_ACTION, status: 'pending' },
    orderBy: { requestedAt: 'desc' },
  });

  const items: PendingAiProposalItem[] = [];
  for (const row of rows) {
    const payload = parseAiProposalPayload(row.payload);
    if (!payload || payload.companyId !== companyId) {
      continue;
    }

    const transaction = await db.bankTransaction.findFirst({
      where: {
        importHash: payload.transactionId,
        statement: { bankAccount: { companyId } },
      },
      select: {
        id: true,
        importHash: true,
        date: true,
        amount: true,
        description: true,
      },
    });
    if (!transaction) {
      continue;
    }

    const proposedGlCandidate = extractProposalGlAccountId(payload);
    const proposedGlAccount = proposedGlCandidate
      ? await db.glAccount.findFirst({
          where: { id: proposedGlCandidate, companyId },
          select: { id: true, code: true, name: true },
        })
      : null;

    items.push({
      approvalId: row.id,
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt,
      bankAccountId: payload.bankAccountId,
      deterministicResult: payload.deterministicResult ?? null,
      aiProposal: payload.aiProposal,
      proposedEntity: payload.proposedEntity ?? null,
      proposedGlAccount,
      transaction: {
        id: transaction.id,
        importHash: transaction.importHash ?? '',
        date: transaction.date,
        amount: Number(transaction.amount),
        description: transaction.description,
      },
    });
  }
  return items;
}

/**
 * Decide a pending AI proposal exactly once.
 *
 * Sequence inside ONE db.$transaction (ACCEPT/CORRECT):
 *  1. approval exists, action matches, still pending
 *  2. tenant + payload validation
 *  3. BankTransaction resolved by importHash inside the tenant
 *  4. CAS pending → accepted/corrected (concurrency arbiter)
 *  5. reclassifyTransaction(input, { tx }) — joins THIS transaction
 *  6. return accounting result + once-guarded KE hook
 * COMMIT
 * await runPostCommitLearning()  ← KE runs only after a successful commit
 *
 * REJECT: CAS pending → rejected only. No accounting, no journal, no KE.
 * Any failure in 1–5 leaves the approval `pending` (throw → rollback).
 */
export async function decideAiProposal(
  input: DecideAiProposalInput,
): Promise<DecideAiProposalResult> {
  const { companyId, approvalId, decision, glAccountId, confirmedEntity } = input;

  // ─── Input validation (§10): strictest minimal contract ─────────────────
  if (
    typeof decision !== 'string' ||
    !AI_PROPOSAL_DECISIONS.includes(decision as AiProposalDecision)
  ) {
    return { status: 'INVALID_DECISION' };
  }
  const typedDecision = decision as AiProposalDecision;

  if (typeof approvalId !== 'string' || approvalId.length === 0) {
    return { status: 'INVALID_INPUT' };
  }

  const parsedConfirmedEntity = parseConfirmedEntity(confirmedEntity);
  if (parsedConfirmedEntity === null) {
    return { status: 'INVALID_CONFIRMED_ENTITY' };
  }

  if (typedDecision === 'REJECT') {
    // Strict: a rejection never reclassifies, so reclassification fields
    // are prohibited rather than silently ignored.
    if (glAccountId !== undefined || confirmedEntity !== undefined) {
      return { status: 'INVALID_INPUT' };
    }
  }

  if (typedDecision === 'CORRECT') {
    if (typeof glAccountId !== 'string' || glAccountId.trim().length === 0) {
      return { status: 'INVALID_GL_ACCOUNT' };
    }
  }

  if (typedDecision === 'ACCEPT') {
    // The accepted GL comes EXCLUSIVELY from the proposal payload, and
    // accepting never confirms an AI-suggested identity — so both
    // reclassification fields are rejected outright.
    if (glAccountId !== undefined || confirmedEntity !== undefined) {
      return { status: 'INVALID_INPUT' };
    }
  }

  let outcome: DecideAiProposalResult & { runPostCommitLearning?: () => Promise<void> };

  try {
    outcome = (await db.$transaction(async (tx) => {
      // 1. Approval still exists, right action, still pending.
      const approval = await tx.pendingApproval.findUnique({
        where: { id: approvalId },
      });
      if (!approval) {
        return { status: 'APPROVAL_NOT_FOUND' } as const;
      }
      if (approval.action !== AI_PROPOSAL_ACTION) {
        return { status: 'INVALID_ACTION' } as const;
      }
      if (approval.status !== 'pending') {
        return { status: 'NOT_PENDING' } as const;
      }

      // 2. Tenant + payload validation inside the same snapshot.
      const payload = parseAiProposalPayload(approval.payload);
      if (!payload || payload.companyId !== companyId) {
        return { status: 'TENANT_MISMATCH' } as const;
      }

      // 3. Resolve payload.transactionId (= importHash) to the real
      //    BankTransaction, tenant-scoped. Ownership is proven by the
      //    relation, never by payload JSON alone.
      const bankTransaction = await tx.bankTransaction.findFirst({
        where: {
          importHash: payload.transactionId,
          statement: { bankAccount: { companyId } },
        },
        select: { id: true },
      });
      if (!bankTransaction) {
        return { status: 'TENANT_MISMATCH' } as const;
      }

      if (typedDecision === 'REJECT') {
        // 4. CAS: pending → rejected. Nothing else happens.
        const cas = await tx.pendingApproval.updateMany({
          where: { id: approvalId, status: 'pending' },
          data: { status: 'rejected' },
        });
        if (cas.count !== 1) {
          return { status: 'NOT_PENDING' } as const;
        }
        return {
          status: 'OK' as const,
          decision: 'REJECT' as const,
          approvalId,
          approvalStatus: 'rejected' as const,
        };
      }

      // ACCEPT: GL exclusively from payload. CORRECT: the human's GL.
      const targetGlAccountId =
        typedDecision === 'ACCEPT'
          ? extractProposalGlAccountId(payload)
          : (glAccountId as string);
      if (!targetGlAccountId) {
        return { status: 'INVALID_GL_ACCOUNT' } as const;
      }

      // 4. CAS — the once-only consumption arbiter. A lost race means
      //    count 0: no accounting, no journal, no KE.
      const cas = await tx.pendingApproval.updateMany({
        where: { id: approvalId, status: 'pending' },
        data: { status: typedDecision === 'ACCEPT' ? 'accepted' : 'corrected' },
      });
      if (cas.count !== 1) {
        return { status: 'NOT_PENDING' } as const;
      }

      // 5. The single accounting authority joins THIS transaction.
      //    ACCEPT never passes confirmedEntity: accepting the GL must not
      //    convert an AI-suggested identity into a human-confirmed one.
      const reclassified = await reclassifyTransaction(
        {
          companyId,
          transactionId: bankTransaction.id,
          glAccountId: targetGlAccountId,
          confirmedEntity:
            typedDecision === 'CORRECT' ? parsedConfirmedEntity : undefined,
        },
        // Typed boundary cast — the SAME certified one used inside
        // reclassifyTransaction (1B.2B.1): the extended client's tx must
        // cross into the raw Prisma.TransactionClient option type.
        { tx: tx as unknown as Prisma.TransactionClient },
      );

      if (reclassified.status !== 'OK') {
        // Roll the CAS back with the accounting failure: the approval
        // must remain consumable, the books must remain untouched.
        throw new ReclassifyRejectedError(reclassified.status);
      }

      // 6. Return the once-guarded post-commit KE hook. It is NOT called
      //    here — the transaction is still open.
      return {
        status: 'OK' as const,
        decision: typedDecision,
        approvalId,
        approvalStatus:
          typedDecision === 'ACCEPT'
            ? ('accepted' as const)
            : ('corrected' as const),
        transaction: reclassified.transaction,
        runPostCommitLearning: reclassified.runPostCommitLearning,
      };
    })) as DecideAiProposalResult & { runPostCommitLearning?: () => Promise<void> };
  } catch (error) {
    if (error instanceof ReclassifyRejectedError) {
      // Transaction already rolled back: CAS undone, approval pending.
      return { status: 'RECLASSIFY_REJECTED', detail: error.detail };
    }
    // Fiscal guard / unexpected errors: rollback already happened inside
    // db.$transaction; propagate untouched (apiHandler maps AppError).
    throw error;
  }

  if (outcome.status !== 'OK') {
    return outcome;
  }

  // COMMIT succeeded → run KE exactly once, outside the transaction.
  // The hook is the authority's once-guard and never rejects: a KE
  // failure leaves the committed decision + accounting standing.
  if (outcome.decision !== 'REJECT') {
    await outcome.runPostCommitLearning?.();
  }

  const { runPostCommitLearning: _runPostCommitLearning, ...result } = outcome;
  return result;
}
