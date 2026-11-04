import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';
import { Prisma } from '@prisma/client';

interface TransactionLine {
  id: string;
  glAccountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  description: string;
  debit: number;
  credit: number;
}

interface CombinedEntry {
  id: string;
  date: Date;
  description: string;
  reference: string | null;
  status: string;
  lines: TransactionLine[];
}

export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();
  await requireModuleEntitlement('accounting');

  const { searchParams } = new URL(request.url);
  const startDateParam = searchParams.get('startDate');
  const endDateParam = searchParams.get('endDate');
  const glAccountId = searchParams.get('glAccountId');
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '25', 10) || 25));
  const offset = (page - 1) * limit;

  const startDate = startDateParam ? new Date(startDateParam + 'T00:00:00.000Z') : null;
  const endDate = endDateParam ? new Date(endDateParam + 'T23:59:59.999Z') : null;

  // S23a — this route used to load EVERY posted entry with every line (plus
  // every reconciled bank transaction) and then paginate/aggregate in JS. The
  // page window and the total count now come from one SQL query each, and the
  // GL filter is part of the query instead of a JS pass. The response shape is
  // unchanged: { data, pagination: { page, limit, totalCount, totalPages } }.
  //
  // The report merges two sources (journal entries and "virtual" entries built
  // from reconciled bank transactions that were never turned into a journal
  // entry), so the page has to be cut from the UNION — cutting each source
  // separately would break the page boundaries.
  const journalDateFilter =
    startDate || endDate
      ? Prisma.sql`${startDate ? Prisma.sql`AND je."date" >= ${startDate}` : Prisma.empty}${
          endDate ? Prisma.sql` AND je."date" <= ${endDate}` : Prisma.empty
        }`
      : Prisma.empty;

  const bankDateFilter =
    startDate || endDate
      ? Prisma.sql`${startDate ? Prisma.sql`AND bt."date" >= ${startDate}` : Prisma.empty}${
          endDate ? Prisma.sql` AND bt."date" <= ${endDate}` : Prisma.empty
        }`
      : Prisma.empty;

  const journalGlFilter = glAccountId
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM "JournalLine" jl WHERE jl."entryId" = je.id AND jl."glAccountId" = ${glAccountId})`
    : Prisma.empty;

  // Parity with the previous JS pass: a virtual entry is selected by its
  // ASSIGNED gl account (the bank-asset line is still returned with it).
  const bankGlFilter = glAccountId
    ? Prisma.sql`AND bt."glAccountId" = ${glAccountId}`
    : Prisma.empty;

  const unified = Prisma.sql`
    SELECT je.id AS id, je."date" AS date, 'journal'::text AS source
    FROM "JournalEntry" je
    WHERE je."companyId" = ${companyId}
      AND je."status" = 'posted'
      ${journalDateFilter}
      ${journalGlFilter}
    UNION ALL
    SELECT bt.id AS id, bt."date" AS date, 'bank'::text AS source
    FROM "BankTransaction" bt
    JOIN "BankStatement" bs ON bs.id = bt."statementId"
    JOIN "BankAccount" ba ON ba.id = bs."bankAccountId"
    WHERE ba."companyId" = ${companyId}
      AND bt."isReconciled" = true
      AND bt."glAccountId" IS NOT NULL
      AND bt."journalEntryId" IS NULL
      ${bankDateFilter}
      ${bankGlFilter}
  `;

  const [pageRows, countRows] = await Promise.all([
    db.$queryRaw<Array<{ id: string; date: Date; source: string }>>`
      SELECT id, date, source FROM (${unified}) unified
      ORDER BY date DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    db.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*) AS total FROM (${unified}) unified
    `,
  ]);

  const totalCount = Number(countRows[0]?.total ?? 0);
  const journalIds = pageRows.filter((r) => r.source === 'journal').map((r) => r.id);
  const bankIds = pageRows.filter((r) => r.source === 'bank').map((r) => r.id);

  const [realEntries, reconciledTxs] = await Promise.all([
    journalIds.length > 0
      ? db.journalEntry.findMany({
          where: { id: { in: journalIds } },
          include: {
            lines: {
              include: {
                glAccount: {
                  select: { id: true, code: true, name: true, accountType: true, normalBalance: true },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
    bankIds.length > 0
      ? db.bankTransaction.findMany({
          where: { id: { in: bankIds } },
          select: {
            id: true,
            date: true,
            amount: true,
            description: true,
            reference: true,
            journalEntryId: true,
            glAccount: {
              select: { id: true, code: true, name: true, accountType: true, normalBalance: true },
            },
            statement: {
              select: {
                bankAccount: {
                  select: {
                    glAccount: {
                      select: {
                        id: true,
                        code: true,
                        name: true,
                        accountType: true,
                        normalBalance: true,
                      },
                    },
                  },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  const entryById = new Map(realEntries.map((entry) => [entry.id, entry]));
  const txById = new Map(reconciledTxs.map((tx) => [tx.id, tx]));

  const combinedEntries: CombinedEntry[] = [];

  // Rebuild the page in the SQL order: no client-side re-sort, no re-filter.
  for (const row of pageRows) {
    if (row.source === 'journal') {
      const entry = entryById.get(row.id);
      if (!entry) continue;
      combinedEntries.push({
        id: entry.id,
        date: entry.date,
        description: entry.description,
        reference: entry.reference,
        status: entry.status,
        lines: entry.lines.map((l) => ({
          id: l.id,
          glAccountId: l.glAccountId,
          accountCode: l.glAccount.code,
          accountName: l.glAccount.name,
          accountType: l.glAccount.accountType,
          description: l.description ?? '',
          debit: l.debit || 0,
          credit: l.credit || 0,
        })),
      });
      continue;
    }

    const tx = txById.get(row.id);
    if (!tx || !tx.glAccount) continue;
    // A transaction already represented by a journal entry (journalEntryId) is
    // already present as a real entry — never as a virtual entry.
    if (tx.journalEntryId) continue;

    const isDeposit = Number(tx.amount) > 0;
    const absAmount = Math.abs(tx.amount);
    const bankGlAccount = tx.statement.bankAccount.glAccount;

    const lines: TransactionLine[] = [];

    // The assigned GL Account line
    lines.push({
      id: tx.id + '-1',
      glAccountId: tx.glAccount.id,
      accountCode: tx.glAccount.code,
      accountName: tx.glAccount.name,
      accountType: tx.glAccount.accountType,
      description: tx.description,
      debit: isDeposit ? 0 : absAmount,
      credit: isDeposit ? absAmount : 0,
    });

    // The Bank Asset Account line
    if (bankGlAccount) {
      lines.push({
        id: tx.id + '-2',
        glAccountId: bankGlAccount.id,
        accountCode: bankGlAccount.code,
        accountName: bankGlAccount.name,
        accountType: bankGlAccount.accountType,
        description: tx.description,
        debit: isDeposit ? absAmount : 0,
        credit: isDeposit ? 0 : absAmount,
      });
    }

    combinedEntries.push({
      id: tx.id,
      date: tx.date,
      description: tx.description,
      reference: tx.reference,
      status: 'posted',
      lines,
    });
  }

  const result = combinedEntries.map((entry) => {
    const totalDebit = entry.lines.reduce((sum: number, l: TransactionLine) => sum + Number(l.debit), 0);
    const totalCredit = entry.lines.reduce((sum: number, l: TransactionLine) => sum + Number(l.credit), 0);
    return {
      ...entry,
      date: entry.date.toISOString(),
      _totalDebit: Math.round(totalDebit * 100) / 100,
      _totalCredit: Math.round(totalCredit * 100) / 100,
    };
  });

  return NextResponse.json({
    data: result,
    pagination: {
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
    },
  });
});
