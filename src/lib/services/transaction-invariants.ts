import type { Prisma } from '@prisma/client';

export const ELIGIBLE_FOR_CLASSIFICATION_FILTER = Object.freeze({
  isReconciled: false,
  isIgnored: false,
  journalEntryId: null,
  matchedRuleId: null,
  glAccountId: null,
}) satisfies Prisma.BankTransactionWhereInput;

export function eligibleForClassificationWhere(
  extra: Prisma.BankTransactionWhereInput = {},
): Prisma.BankTransactionWhereInput {
  return {
    AND: [ELIGIBLE_FOR_CLASSIFICATION_FILTER, extra],
  };
}
