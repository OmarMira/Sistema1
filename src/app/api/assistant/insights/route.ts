import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { generateInsights } from '@/lib/assistant/insight-engine';
import { db } from '@/lib/db';
import { ForbiddenError } from '@/lib/api-error';
import { readJsonConfig } from '@/lib/config-loader';
import { requireCompanyContext } from '@/lib/context-storage';

export const dynamic = 'force-dynamic';
export const revalidate = 300;

export const GET = apiHandler(async (req: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  // Get user role for this company (membership is already verified by apiHandler)
  const member = await db.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId } },
  });
  if (!member) {
    throw new ForbiddenError();
  }

  const role = member.role;

  // Filter by allowed roles
  if (!['super_admin', 'admin', 'accountant'].includes(role)) {
    return NextResponse.json({ insights: [], message: 'Acceso restringido a roles financieros' });
  }

  const insights = await generateInsights(companyId, role);

  const config = await readJsonConfig<{ auditActions: { insightGenerated: string } }>(
    'assistant-config.json',
  );

  await db.auditLog.create({
    data: {
      companyId,
      userId,
      action: config.auditActions.insightGenerated,
      entity: 'Assistant',
      details: JSON.stringify({
        count: insights.length,
        role,
        generatedAt: new Date().toISOString(),
      }),
    },
  });

  return NextResponse.json({ insights, generatedAt: new Date().toISOString() });
});
