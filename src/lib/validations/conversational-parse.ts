import { z } from 'zod';

export const directionProfileSchema = z.object({
  creditPct: z.number().min(0).max(1),
  debitPct: z.number().min(0).max(1),
});

export const conversationalParseSchema = z
  .object({
    pattern: z.string().min(1, 'pattern is required'),
    userInput: z.string().min(1, 'userInput is required').optional(),
    userAnswer: z.string().min(1, 'userAnswer is required').optional(),
    directionProfile: directionProfileSchema,
  })
  .refine((data) => data.userInput || data.userAnswer, {
    message: 'Either userInput or userAnswer is required',
    path: ['userInput'],
  });
