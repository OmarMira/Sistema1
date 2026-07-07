// src/lib/fiscal-period/strategies/base.ts
import { FiscalYearConfig, PeriodDefinition } from '../types';

export abstract class PeriodStrategy {
  abstract calculate(ctx: { year: number; config: FiscalYearConfig }): PeriodDefinition[];

  // Helper seguro para UTC
  protected utcDate(year: number, month: number, day: number, h = 0, m = 0, s = 0): Date {
    return new Date(Date.UTC(year, month - 1, day, h, m, s));
  }

  protected toMonthName(month: number, lang: 'es' | 'en' = 'es'): string {
    return new Date(Date.UTC(2000, month - 1)).toLocaleString(lang, {
      month: 'long',
      timeZone: 'UTC',
    });
  }
}
