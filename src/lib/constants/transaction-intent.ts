import { z } from 'zod';

export const TRANSACTION_INTENT_VALUES = [
  'LOAN_PAYMENT',
  'RENT_PAYMENT',
  'OPERATING_EXPENSE',
  'OWNER_CONTRIBUTION',
  'CUSTOMER_PAYMENT',
  'TRANSFER',
  'TAX_PAYMENT',
  'OTHER',
] as const;

export type TransactionIntent = (typeof TRANSACTION_INTENT_VALUES)[number];

export const transactionIntentSchema = z.enum(TRANSACTION_INTENT_VALUES);
