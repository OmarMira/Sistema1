import { z } from 'zod';

export const journalLineSchema = z.object({
  glAccountId: z.string().min(1, 'El ID de la cuenta GL es requerido'),
  description: z.string().optional().nullable(),
  debit: z.number().nonnegative('El monto del débito debe ser positivo o cero'),
  credit: z.number().nonnegative('El monto del crédito debe ser positivo o cero'),
});

export const createJournalEntrySchema = z.object({
  companyId: z.string().min(1, 'El ID de la empresa es requerido'),
  date: z.string().refine((val) => !isNaN(Date.parse(val)), 'Formato de fecha inválido'),
  description: z.string().min(1, 'La descripción es requerida'),
  reference: z.string().optional().nullable(),
  status: z.enum(['draft', 'posted']).default('draft'),
  lines: z.array(journalLineSchema).min(2, 'Se requieren al menos 2 líneas de asiento contable'),
});

export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;
export type JournalLineInput = z.infer<typeof journalLineSchema>;
