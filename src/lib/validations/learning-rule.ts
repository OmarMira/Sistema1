import { z } from 'zod';

export const conditionSchema = z.object({
  field: z.enum(['description', 'amount']),
  operator: z.enum([
    'contains',
    'equals',
    'starts_with',
    'ends_with',
    'amount_greater',
    'amount_less',
    'greater_than',
    'less_than',
  ]),
  value: z.string().min(1),
});

export const createLearningRuleSchema = z
  .object({
    pattern: z.string().min(1).optional(),
    lockedDirection: z.enum(['any', 'debit', 'credit']).optional(),
    glAccountCode: z.string().optional(),
    role: z.string().optional(),
    createSubAccount: z.boolean().optional(),
    subAccountName: z.string().nullable().optional(),
    conditions: z.array(conditionSchema).optional(),
    debitGlAccountId: z.string().optional(),
    creditGlAccountId: z.string().optional(),
    debitGlAccountCode: z.string().optional(),
    creditGlAccountCode: z.string().optional(),
    name: z.string().optional(),
    priority: z.number().int().min(0).max(20).optional(),
  })
  .refine((data) => data.pattern || (data.conditions && data.conditions.length > 0), {
    message: 'pattern or conditions are required',
  });
