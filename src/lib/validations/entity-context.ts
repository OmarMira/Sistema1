import { z } from 'zod';

export const entityContextSchema = z.object({
  companyId: z.string().min(1),
  pattern: z.string().min(1).max(255),
  role: z.string().min(1),
  glAccountId: z.string().min(1).nullable().optional(),
  transactionDirection: z.string().nullable().optional(),
});
