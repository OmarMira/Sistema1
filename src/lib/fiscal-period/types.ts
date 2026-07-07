import { z } from 'zod';

export const fiscalConfigSchema = z.object({
  type: z.enum(['CALENDAR', 'CUSTOM_MONTHS', 'WEEK_52_53']),
  startMonth: z.number().min(1).max(12),
  endDayRule: z.string().optional(),
  allowShortPeriods: z.boolean().default(false),
  closingAccountCode: z.string().min(1),
  periodsPerYear: z.number().default(12),
});

export type FiscalYearConfig = z.infer<typeof fiscalConfigSchema>;

export interface PeriodDefinition {
  startDate: Date; // ⚠️ DEBE SER UTC
  endDate: Date; // ⚠️ DEBE SER UTC
  name: string;
  isShort: boolean;
}
