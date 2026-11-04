import { db } from '@/lib/db';
import { createAuditLogWithRetry } from '@/lib/audit';
import { appendEntryToJournalChain } from '@/lib/journal-chain';
import { fromCents, sumCents, toCents } from '@/lib/money';
import { JournalEntryService } from '@/lib/services/journal-entry.service';
import { getPeriodStrategy } from '@/lib/fiscal-period/strategies';
import { FiscalYearConfig } from '@/lib/fiscal-period/types';

export async function executeYearClose(companyId: string, year: number, config: FiscalYearConfig) {
  const strategy = getPeriodStrategy(config.type);
  const calcPeriods = strategy.calculate({ year, config });
  if (!calcPeriods.length) throw new Error('Estrategia no generó períodos');

  const fiscalStart = calcPeriods[0]!.startDate; // UTC
  const fiscalEnd = calcPeriods[calcPeriods.length - 1]!.endDate; // UTC

  const dbPeriods = await db.fiscalPeriod.findMany({
    where: { companyId, startDate: { gte: fiscalStart }, endDate: { lte: fiscalEnd } },
    orderBy: { startDate: 'asc' },
  });
  if (dbPeriods.length !== config.periodsPerYear || !dbPeriods.every((p) => p.isLocked)) {
    throw new Error('Períodos incompletos o no bloqueados');
  }

  const accounts = await db.glAccount.findMany({
    where: { companyId, accountType: { in: ['revenue', 'expense'] }, isActive: true },
  });

  // Agregación única — reemplaza N+1 queries por un solo groupBy
  const totals = await db.journalLine.groupBy({
    by: ['glAccountId'],
    _sum: { debit: true, credit: true },
    where: {
      glAccountId: { in: accounts.map((a) => a.id) },
      entry: { companyId, date: { gte: fiscalStart, lte: fiscalEnd }, status: 'posted' },
    },
  });
  // S3: the groupBy `_sum` values arrive as Prisma.Decimal (aggregate results
  // bypass the db.ts result layer), so every balance is derived in integer
  // cents and converted back only when the closing line is written.
  const balanceMap = new Map(
    totals.map((t) => [
      t.glAccountId,
      { debitCents: toCents(t._sum.debit ?? 0), creditCents: toCents(t._sum.credit ?? 0) },
    ]),
  );
  const netBalances = accounts.map((acc) => {
    const { debitCents, creditCents } = balanceMap.get(acc.id) ?? { debitCents: 0, creditCents: 0 };
    return { id: acc.id, diffCents: sumCents(debitCents, -creditCents) };
  });

  const lines = netBalances
    // A residual of one cent or less is not closed (unchanged threshold: |diff| > 0.01).
    .filter((b) => Math.abs(b.diffCents) > 1)
    .map((b) => ({
      glAccountId: b.id,
      description: `Cierre ${year}`,
      debit: b.diffCents < 0 ? fromCents(-b.diffCents) : 0,
      credit: b.diffCents > 0 ? fromCents(b.diffCents) : 0,
    }));

  const closingAcc = await db.glAccount.findFirst({
    where: { companyId, code: config.closingAccountCode, isActive: true },
  });
  if (!closingAcc) throw new Error('Cuenta de cierre no encontrada');

  const netToRetainedCents = lines.reduce(
    (total, line) => sumCents(total, toCents(line.debit), -toCents(line.credit)),
    0,
  );
  lines.push({
    glAccountId: closingAcc.id,
    description: `Traslado utilidades ${year}`,
    debit: netToRetainedCents < 0 ? fromCents(-netToRetainedCents) : 0,
    credit: netToRetainedCents > 0 ? fromCents(netToRetainedCents) : 0,
  });

  const totalDebitCents = lines.reduce((total, line) => sumCents(total, toCents(line.debit)), 0);
  const totalCreditCents = lines.reduce((total, line) => sumCents(total, toCents(line.credit)), 0);
  if (Math.abs(sumCents(totalDebitCents, -totalCreditCents)) > 1) {
    throw new Error('Asiento de cierre descuadrado');
  }

  return await db.$transaction(async (tx) => {
    const entry = await tx.journalEntry.create({
      data: {
        companyId,
        date: fiscalEnd,
        description: `Cierre ${year}`,
        reference: `CLOSE-${year}`,
        status: 'posted',
        lines: { create: lines },
      },
    });
    // JH2 writer: closing entry is POSTED at creation.
    await appendEntryToJournalChain(tx as any, { companyId, entryId: entry.id });

    // S23h: a POSTED entry changes GlAccount.balance, and every other posting
    // path (post, void, bank flows) refreshes it in the same transaction. The
    // closing entry must not leave balances stale.
    for (const glAccountId of new Set(lines.map((l) => l.glAccountId))) {
      await JournalEntryService.recalculateBalance(tx as any, glAccountId);
    }
    await createAuditLogWithRetry(
      {
        companyId,
        action: 'YEAR_CLOSED',
        entity: 'JournalEntry',
        entityId: entry.id,
        details: JSON.stringify({ year }),
      },
       
      tx as any,
    );
    await tx.fiscalPeriod.updateMany({
      where: { companyId, startDate: { lte: fiscalEnd }, endDate: { lte: fiscalEnd } },
      data: { isLocked: true },
    });
    return { success: true, entryId: entry.id };
  });
}

