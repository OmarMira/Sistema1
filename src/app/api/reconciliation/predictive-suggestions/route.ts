import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { generateSuggestions } from '@/lib/reconciliation/predictive-engine';
import { readJsonConfig } from '@/lib/config-loader';
import { db } from '@/lib/db';
import { requireCompanyContext } from '@/lib/context-storage';

export const GET = apiHandler(async (req: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  const { searchParams } = new URL(req.url);
  const bankAccountId = searchParams.get('bankAccountId');

  if (!bankAccountId) {
    return NextResponse.json({ error: 'bankAccountId es requerido' }, { status: 400 });
  }

  const bankAccount = await db.bankAccount.findFirst({
    where: { id: bankAccountId, companyId },
    select: { id: true },
  });
  if (!bankAccount) {
    return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });
  }

  interface PredictiveConfig {
    auditActions: { shown: string };
    confidenceThreshold: number;
  }

  const config = await readJsonConfig<PredictiveConfig>('predictive-recon.json');
  const suggestions = await generateSuggestions(companyId, bankAccountId);

  // Auditoría de sugerencias mostradas
  await db.auditLog.create({
    data: {
      companyId,
      action: config.auditActions.shown,
      entity: 'Company',
      entityId: companyId,
      details: JSON.stringify({ count: suggestions.length, threshold: config.confidenceThreshold }),
    },
  });

  return NextResponse.json({ suggestions, generatedAt: new Date().toISOString() });
});
