// src/lib/fiscal-period/strategies/index.ts
import { CalendarYearStrategy } from './calendar';
import { CustomMonthStrategy } from './custom-months';
import { Week52_53Strategy } from './week52-53';
import { PeriodStrategy } from './base';

export function getPeriodStrategy(type: string): PeriodStrategy {
  switch (type) {
    case 'CALENDAR':
      return new CalendarYearStrategy();
    case 'CUSTOM_MONTHS':
      return new CustomMonthStrategy();
    case 'WEEK_52_53':
      return new Week52_53Strategy();
    default:
      throw new Error(`Unsupported fiscal year type: ${type}`);
  }
}
