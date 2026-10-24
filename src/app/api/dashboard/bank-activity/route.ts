import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';
import { db } from '@/lib/db';
const querySchema = z.object({
  accountId: z.string().min(1).max(200).optional(),
  year: z.coerce.number().int().min(1900).max(9999).optional(),
  cursor: z.string().min(1).max(200).optional()
});
const day = (date: Date) => date.toISOString().slice(0, 10);

// Bank facts only. Never reads or writes journals, applies rules, or reconciles.
export const GET = apiHandler(async (req: NextRequest) => {
  const {
    companyId
  } = requireCompanyContext();
  await requireModuleEntitlement('accounting');
  const params = req.nextUrl.searchParams;
  const parsed = querySchema.safeParse(Object.fromEntries(['accountId', 'year', 'cursor'].filter(key => params.has(key)).map(key => [key, params.get(key)])));
  if (!parsed.success) return NextResponse.json({
    error: 'Invalid bank activity query'
  }, {
    status: 400
  });
  const query = parsed.data;
  const accounts = await db.bankAccount.findMany({
    where: {
      companyId
    },
    orderBy: {
      id: 'asc'
    },
    select: {
      id: true,
      accountName: true,
      bankName: true,
      currency: true
    }
  });
  const account = query.accountId ? accounts.find(a => a.id === query.accountId) : accounts[0];
  if (query.accountId && !account) return NextResponse.json({
    error: 'Bank account not found'
  }, {
    status: 404
  });
  if (!account) return NextResponse.json({
    accounts,
    account: null,
    years: [],
    year: null,
    statements: [],
    transactions: [],
    total: 0,
    hasMore: false,
    nextCursor: null
  });
  const allStatements = await db.bankStatement.findMany({
    where: {
      bankAccountId: account.id,
      bankAccount: {
        companyId
      }
    },
    orderBy: [{
      startDate: 'asc'
    }, {
      id: 'asc'
    }],
    select: {
      id: true,
      startDate: true,
      endDate: true,
      openingBalance: true,
      closingBalance: true
    }
  });
  const years = [...new Set(allStatements.flatMap(s => {
    const result: number[] = [];
    for (let year = s.startDate.getUTCFullYear(); year <= s.endDate.getUTCFullYear(); year++) result.push(year);
    return result;
  }))].sort((a, b) => b - a);
  const year = query.year ?? years[0] ?? new Date().getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
  const where = {
    statement: {
      bankAccountId: account.id,
      bankAccount: {
        companyId
      }
    },
    date: {
      gte: start,
      lte: end
    }
  };
  const [total, rows] = await Promise.all([db.bankTransaction.count({
    where
  }), db.bankTransaction.findMany({
    where,
    orderBy: [{
      date: 'asc'
    }, {
      id: 'asc'
    }],
    take: 501,
    ...(query.cursor ? {
      cursor: {
        id: query.cursor
      },
      skip: 1
    } : {}),
    select: {
      id: true,
      statementId: true,
      date: true,
      description: true,
      amount: true,
      isReconciled: true,
      isIgnored: true,
      glAccount: {
        select: {
          code: true,
          name: true
        }
      }
    }
  })]);
  const hasMore = rows.length > 500;
  const transactions = rows.slice(0, 500).map(tx => ({
    id: tx.id,
    statementId: tx.statementId,
    fecha: day(tx.date),
    descripcion: tx.description,
    monto: Math.abs(Number(tx.amount)),
    tipo: Number(tx.amount) >= 0 ? 'credito' : 'debito',
    cuenta_contable: tx.glAccount ? `${tx.glAccount.code} ${tx.glAccount.name}` : '',
    glAccountName: tx.glAccount?.name ?? null,
    categoria: tx.glAccount?.name || 'Sin asignar',
    conciliado: tx.isReconciled,
    ignored: tx.isIgnored
  }));
  return NextResponse.json({
    accounts,
    account,
    years,
    year,
    total,
    transactions,
    hasMore,
    nextCursor: hasMore ? transactions[transactions.length - 1].id : null,
    statements: allStatements.filter(s => s.endDate >= start && s.startDate <= end).map(s => ({
      id: s.id,
      startDate: day(s.startDate),
      endDate: day(s.endDate),
      openingBalance: Number(s.openingBalance),
      closingBalance: Number(s.closingBalance)
    }))
  });
});
