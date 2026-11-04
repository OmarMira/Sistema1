import { TRANSACTION_INTENT_VALUES, type TransactionIntent } from '@/lib/constants/transaction-intent';

export interface GuidanceAccount {
  id: string;
  code: string;
  name: string;
  accountType: string;
  normalBalance: string;
  parentId: string | null;
}

export interface AccountGuidance {
  account: GuidanceAccount | null;
  intent: TransactionIntent | null;
  reason: string;
  needsClarification: boolean;
  question: string | null;
}

export interface AccountGuidanceInput {
  accountCode?: unknown;
  intent?: unknown;
  evidence?: unknown;
  accountReason?: unknown;
  needsClarification?: unknown;
  clarificationQuestion?: unknown;
}

// Never invent a chart code or treat an entity relationship as transaction evidence.
export function resolveAccountGuidance(
  input: AccountGuidanceInput,
  accounts: GuidanceAccount[],
  samples: string[],
  direction: { creditPct: number; debitPct: number } | undefined,
  locale: 'es' | 'en',
): AccountGuidance {
  const account = accounts.find((item) => item.code === input.accountCode);
  const intent = TRANSACTION_INTENT_VALUES.find((value) => value === input.intent);
  const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : '';
  const evidenced = evidence.length >= 5 && samples.some((sample) => sample.toLowerCase().includes(evidence.toLowerCase()));
  const isRent = intent === 'RENT_PAYMENT';
  const rentEvidence = /\b(rent(?:al)?|lease|alquiler|renta)\b/i.test(evidence);
  const depositEvidence = /\b(deposits?|dep[oó]sitos?|security|garant[ií]a)\b/i.test(samples.join(' '));
  const rentType = direction && direction.creditPct >= 0.85 ? 'revenue'
    : direction && direction.debitPct >= 0.85 ? 'expense' : null;
  const valid = input.needsClarification === false && account && intent && evidenced
    && (!isRent || (rentEvidence && !depositEvidence && account.accountType === rentType))
    && (!depositEvidence || !direction || direction.creditPct < 0.85 || account.accountType === 'liability');

  if (!valid || !account || !intent) {
    const question = isRent || depositEvidence
      ? locale === 'es' ? '¿Son pagos o cobros de alquiler, depósitos de garantía u otro concepto?'
        : 'Are these rent payments or receipts, security deposits, or another kind of payment?'
      : locale === 'es' ? '¿Qué representan estos movimientos? Aclará el concepto para poder sugerir una cuenta.'
        : 'What do these movements represent? Clarify their purpose so an account can be suggested.';
    return { account: null, intent: null, reason: '', needsClarification: true, question };
  }
  return {
    account, intent, needsClarification: false, question: null,
    reason: typeof input.accountReason === 'string' ? input.accountReason : '',
  };
}
