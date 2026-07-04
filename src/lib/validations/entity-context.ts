import { z } from 'zod';
import { entityRoleSchema } from '../constants/entity-roles';

export const entityContextSchema = z.object({
  companyId: z.string().min(1),
  pattern: z.string().min(1).max(255),
  role: entityRoleSchema,
  glAccountId: z.string().min(1).nullable().optional(),
  transactionDirection: z.string().nullable().optional(),
});
