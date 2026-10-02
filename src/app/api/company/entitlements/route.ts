import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { listCompanyModuleEntitlements } from '@/lib/services/module-entitlements.service';

export const GET = apiHandler(async () => {
  const ctx = requireCompanyContext();
  const rows = await listCompanyModuleEntitlements(ctx.companyId);

  return NextResponse.json({
    companyId: ctx.companyId,
    entitlements: rows.map((row) => ({
      moduleKey: row.moduleKey,
      enabled: row.enabled,
    })),
  });
});
