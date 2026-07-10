/**
 * Crea una ventana de fechas UTC segura para queries de Prisma.
 * Evita desfases de timezone en entornos serverless (Vercel = UTC, dev = local).
 */
export function createDateWindow(refDate: Date, daysOffset: number): { from: Date; to: Date } {
  const from = new Date(
    Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate() - daysOffset),
  );
  const to = new Date(
    Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate() + daysOffset),
  );
  return { from, to };
}

/**
 * Formatea una Date a "YYYY-MM" para usar como statementMonth en el hash.
 */
export function toStatementMonth(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Formatea una Date a "YYYY-MM-DD" para usar como txDate en el hash.
 */
export function toDateString(date: Date): string {
  return date.toISOString().split('T')[0] ?? '';
}
