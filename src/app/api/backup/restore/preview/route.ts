import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { previewCompanyRestore } from '@/lib/backup-restore';

export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();
  const body = await request.json();
  const { data } = body;
  if (!data || typeof data !== 'string') return NextResponse.json({ error: 'data required' }, { status: 400 });
  try {
    const preview = await previewCompanyRestore(companyId, data);
    return NextResponse.json({
      companyId: preview.companyId,
      checksum: preview.checksum,
      counts: preview.counts,
      ids: preview.ids,
      blockers: preview.blockers,
      scope: preview.scope,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
});
