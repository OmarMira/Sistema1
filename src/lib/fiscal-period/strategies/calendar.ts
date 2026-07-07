// src/lib/fiscal-period/strategies/calendar.ts
import { PeriodStrategy } from './base';
import { FiscalYearConfig, PeriodDefinition } from '../types';

export class CalendarYearStrategy extends PeriodStrategy {
  calculate(ctx: { year: number; config: FiscalYearConfig }): PeriodDefinition[] {
    const { year } = ctx;
    const { periodsPerYear = 12 } = ctx.config;
    const monthsPerPeriod = 12 / periodsPerYear;
    return Array.from({ length: periodsPerYear }, (_, i) => {
      const startM = i * monthsPerPeriod;
      return {
        startDate: this.utcDate(year, startM + 1, 1),
        endDate: this.utcDate(year, startM + monthsPerPeriod + 1, 0, 23, 59, 59),
        name:
          new Date(Date.UTC(year, startM))
            .toLocaleString('es', { month: 'long', timeZone: 'UTC' })
            .toUpperCase() + ` ${year}`,
        isShort: false,
      };
    });
  }
}
