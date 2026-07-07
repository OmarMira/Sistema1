// src/lib/fiscal-period/strategies/week52-53.ts
import { PeriodStrategy } from './base';
import { PeriodDefinition, FiscalYearConfig } from '../types';

export class Week52_53Strategy extends PeriodStrategy {
  calculate(ctx: { year: number; config: FiscalYearConfig }): PeriodDefinition[] {
    const { year } = ctx;
    const { endDayRule = 'LAST_FRIDAY_OF_DECEMBER' } = ctx.config;
    const endDate = this.resolveRuleDate(year, endDayRule);
    const startDate = new Date(endDate);
    startDate.setUTCDate(startDate.getUTCDate() - 52 * 7 + 1);

    return [
      {
        startDate,
        endDate,
        name: `AÑO FISCAL ${year} (52/53 SEM.)`,
        isShort: false,
      },
    ];
  }

  private resolveRuleDate(year: number, rule: string): Date {
    // Parseo dinámico: "LAST_FRIDAY_OF_DECEMBER"
    const [position, dayName, of, monthName] = rule.split('_');
    const monthIndex = this.getMonthIndex(monthName);
    const dayIndex = this.getDayIndex(dayName);

    const date = new Date(Date.UTC(year, monthIndex + 1, 0)); // Último día del mes
    while (date.getUTCDay() !== dayIndex) {
      date.setUTCDate(date.getUTCDate() - 1);
    }
    return date;
  }

  private getMonthIndex(name: string): number {
    const m: Record<string, number> = {
      JANUARY: 0,
      FEBRUARY: 1,
      MARCH: 2,
      APRIL: 3,
      MAY: 4,
      JUNE: 5,
      JULY: 6,
      AUGUST: 7,
      SEPTEMBER: 8,
      OCTOBER: 9,
      NOVEMBER: 10,
      DECEMBER: 11,
    };
    return m[name.toUpperCase()] ?? 0;
  }

  private getDayIndex(name: string): number {
    const d: Record<string, number> = {
      SUNDAY: 0,
      MONDAY: 1,
      TUESDAY: 2,
      WEDNESDAY: 3,
      THURSDAY: 4,
      FRIDAY: 5,
      SATURDAY: 6,
    };
    return d[name.toUpperCase()] ?? 0;
  }
}
