export interface FuzzyCandidate {
  id: string;
  description: string;
  amount: number;
  date: Date;
}

export interface FuzzyPreFilterOptions {
  companyId: string;
  dateFrom: Date; // Date object UTC — nunca number o string raw
  dateTo: Date; // Date object UTC
  amount: number;
  tolerancePercent?: number; // Default 0.02 (±2%)
  description?: string; // Para tolerancia dinámica por tipo
  limit?: number; // Default 300
}

/**
 * Tolerancia dinámica según tipo de transacción.
 * Zelle payments pueden variar en monto entre ciclos.
 * ACH/CCD suelen ser montos fijos.
 */
function getEffectiveTolerance(description: string | undefined, base: number): number {
  if (!description) return base;
  if (/zelle payment/i.test(description)) return 0.1; // ±10%
  if (/ACH PMT|CCD|WEB/i.test(description)) return base; // ±2%
  return base;
}

/**
 * Pre-filtra candidatos en PostgreSQL usando índices B-tree existentes.
 * Reduce el conjunto a cargar en memoria antes del fuzzy match en JS.
 *
 * Nota: PostgreSQL soporta índices parciales. El índice compuesto
 * @@index([isReconciled, journalLineId, date]) cubre este query.
 */
 
export async function fetchFuzzyCandidates(
  prisma: any,
  options: FuzzyPreFilterOptions,
): Promise<FuzzyCandidate[]> {
  const baseTolerance = options.tolerancePercent ?? 0.02;
  const tolerance = getEffectiveTolerance(options.description, baseTolerance);
  const limit = options.limit ?? 300;
  const absAmount = Math.abs(options.amount);
  const minAmount = absAmount * (1 - tolerance);
  const maxAmount = absAmount * (1 + tolerance);

  return prisma.bankTransaction.findMany({
    where: {
      statement: {
        bankAccount: {
          companyId: options.companyId, // companyId via relación anidada
        },
      },
      date: { gte: options.dateFrom, lte: options.dateTo },
      amount: { gte: minAmount, lte: maxAmount },
      isReconciled: true,
      journalLineId: null, // Solo transacciones no reflejadas en asientos
    },
    select: { id: true, description: true, amount: true, date: true }, // sin include
    take: limit,
    orderBy: { date: 'desc' },
  });
}
