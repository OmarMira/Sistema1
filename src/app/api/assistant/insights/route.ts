import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { generateInsights } from '@/lib/assistant/insight-engine';
import { db } from '@/lib/db';
import { readJsonConfig } from '@/lib/config-loader';
import { requireCompanyContext } from '@/lib/context-storage';

export const dynamic = 'force-dynamic';
export const revalidate = 300;

export const GET = apiHandler(async (req: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  // Separation: global instance authority (User.role) vs tenant authority
  // (CompanyMember.role). super_admin bypasses without requiring a membership.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { platformRole: true },
  });

  let accessPath = '';
  if (user?.platformRole === 'super_admin') {
    accessPath = 'global_super_admin';
  } else {
    const member = await db.companyMember.findUnique({
      where: { userId_companyId: { userId, companyId } },
    });
    if (member?.role === 'company_admin') {
      accessPath = 'tenant_company_admin';
    }
  }

  // Neutral functional contract for non-privileged roles: HTTP 200 + empty list.
  if (!accessPath) {
    return NextResponse.json({ insights: [], message: 'Acceso restringido a roles financieros' });
  }

  const insights = await generateInsights(companyId);

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
        accessPath,
        generatedAt: new Date().toISOString(),
      }),
    },
  });

  return NextResponse.json({ insights, generatedAt: new Date().toISOString() });
}, { requireMembership: false });
