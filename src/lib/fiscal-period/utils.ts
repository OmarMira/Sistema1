// src/lib/fiscal-period/utils.ts
export interface FiscalPeriodData {
  id: string;
  name: string;
  startDate: string | Date;
  endDate: string | Date;
  isLocked: boolean;
}

export function isPeriodLocked(date: Date, periods: FiscalPeriodData[]): boolean {
  const targetTime = date.getTime();
  return periods.some(
    (p) =>
      p.isLocked &&
      targetTime >= new Date(p.startDate).getTime() &&
      targetTime <= new Date(p.endDate).getTime(),
  );
}

export function formatFiscalDate(utcDate: Date | string, locale: string = 'es'): string {
  const d = typeof utcDate === 'string' ? new Date(utcDate) : utcDate;
  return d.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
}
