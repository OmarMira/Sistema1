import { db } from '@/lib/db';
import { excludePendingHumanDecisions } from '@/lib/services/single-rule-apply.service';

export async function revalidateAutoMatchCandidate(
  executor: Pick<typeof db, 'pendingApproval' | 'bankTransaction'>,
  txId: string,
  companyId: string,
): Promise<boolean> {
  const exclusion = await excludePendingHumanDecisions(executor, companyId);
  const row = await executor.bankTransaction.findFirst({
    where: { id: txId, AND: [exclusion] },
    select: { id: true },
  });
  return row !== null;
}
