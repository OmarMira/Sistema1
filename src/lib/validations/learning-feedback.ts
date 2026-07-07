import { z } from 'zod';

export const learningFeedbackSchema = z.object({
  bankDescription: z.string().min(1, 'bankDescription is required'),
  glAccountCode: z.string().min(1, 'glAccountCode is required'),
  role: z.string().optional(),
  source: z.string().optional(),
});
