import { z } from 'zod';

export const onboardingPayloadSchema = z.object({
  companyId: z.string().min(1, 'El ID de la empresa es requerido'),
  legalName: z.string().min(3, 'El nombre legal debe tener al menos 3 caracteres'),
  currency: z.enum(['USD', 'EUR', 'MXN', 'ARS', 'GBP']).default('USD'),
  fiscalYearStartMonth: z.number().min(1).max(12, 'El mes de inicio debe estar entre 1 y 12'),
  fiscalYearStartYear: z.number().min(2000).max(2100, 'El año debe estar entre 2000 y 2100'),
  periodType: z.enum(['CALENDAR', 'CUSTOM_MONTHS', 'WEEK_52_53']),
  initialCashBalance: z.number().min(0, 'El saldo inicial no puede ser negativo').optional(),
});

export type OnboardingPayload = z.infer<typeof onboardingPayloadSchema>;
