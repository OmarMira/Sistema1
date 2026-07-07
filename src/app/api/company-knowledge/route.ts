import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { db } from '@/lib/db';

export const GET = apiHandler(async (request: NextRequest, _context: RouteContext) => {
  const { companyId } = requireCompanyContext();

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '20');
  const type = searchParams.get('type');
  const status = searchParams.get('status');
  const search = searchParams.get('search');

  const where: Record<string, unknown> = { companyId };
  if (type) where.type = type;
  if (status) where.status = status;
  if (search) where.canonicalName = { contains: search, mode: 'insensitive' };

  const [data, total] = await Promise.all([
    db.companyKnowledge.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
    db.companyKnowledge.count({ where }),
  ]);
  return NextResponse.json({ data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
});
