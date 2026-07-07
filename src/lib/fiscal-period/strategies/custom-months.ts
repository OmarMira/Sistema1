// src/lib/fiscal-period/strategies/custom-months.ts
import { PeriodStrategy } from './base';
import { PeriodDefinition, FiscalYearConfig } from '../types';

export class CustomMonthStrategy extends PeriodStrategy {
  calculate(ctx: { year: number; config: FiscalYearConfig }): PeriodDefinition[] {
    const { year } = ctx;
    const { startMonth, periodsPerYear = 12 } = ctx.config;
    const periods: PeriodDefinition[] = [];

    for (let i = 0; i < periodsPerYear; i++) {
      const monthIndex = ((startMonth - 1 + i) % 12) + 1;
      const calcYear = year + Math.floor((startMonth - 1 + i) / 12);

      periods.push({
        startDate: this.utcDate(calcYear, monthIndex, 1),
        endDate: this.utcDate(calcYear, monthIndex + 1, 0, 23, 59, 59),
        name: `${this.toMonthName(monthIndex).toUpperCase()} ${calcYear}`,
        isShort: false,
      });
    }
    return periods;
  }
}
