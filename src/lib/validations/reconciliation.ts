import { z } from 'zod';

export const transactionSplitSchema = z.object({
  glAccountId: z.string().min(1, 'El ID de la cuenta GL es requerido'),
  amount: z.number().positive('El monto debe ser mayor que cero'),
  description: z.string().optional().nullable(),
});

export const reconcileTransactionItemSchema = z.object({
  id: z.string().min(1, 'El ID de la transacción es requerido'),
  glAccountId: z.string().optional().nullable(),
  splits: z.array(transactionSplitSchema).optional().nullable(),
});

export const createReconciliationSchema = z.object({
  companyId: z.string().min(1, 'El ID de la empresa es requerido'),
  bankAccountId: z.string().min(1, 'El ID de la cuenta bancaria es requerido'),
  transactions: z
    .array(reconcileTransactionItemSchema)
    .min(1, 'Debe proporcionar al menos una transacción para conciliar'),
  createJournalEntries: z.boolean().default(false),
  periodId: z.string().optional().nullable(),
});

export type CreateReconciliationInput = z.infer<typeof createReconciliationSchema>;
export type ReconcileTransactionItem = z.infer<typeof reconcileTransactionItemSchema>;
export type TransactionSplitInput = z.infer<typeof transactionSplitSchema>;
