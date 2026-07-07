import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { validateRequest } from '@/lib/validate-request';
import { createAdminCompanySchema } from '@/lib/validations/admin';
import { createAuditLogWithRetry } from '@/lib/audit';
import { seedChartOfAccounts } from '@/lib/chart-of-accounts';

export const POST = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();

    const body = await validateRequest(request, createAdminCompanySchema);
    if (body instanceof NextResponse) return body;
    const { legalName, taxId } = body;

    if (!legalName || !legalName.trim()) {
      return NextResponse.json({ error: 'legalName is required' }, { status: 400 });
    }

    const company = await db.$transaction(async (tx) => {
      // 1. Create company
      const newCompany = await tx.company.create({
        data: {
          legalName: legalName.trim(),
          taxId: taxId?.trim() || null,
          isActive: true,
        },
      });

      // 2. Create membership
      await tx.companyMember.create({
        data: {
          userId,
          companyId: newCompany.id,
          role: 'company_admin',
        },
      });

      // 3. Seed accounts
       
      await seedChartOfAccounts(tx as any, newCompany.id);

      // 5. Create audit log
      await createAuditLogWithRetry(
        {
          companyId: newCompany.id,
          userId,
          action: 'create_company',
          entity: 'Company',
          entityId: newCompany.id,
          details: `Created company ${newCompany.legalName} and auto-seeded chart of accounts`,
        },
         
        tx as any,
      );

      return newCompany;
    });

    return NextResponse.json({ company }, { status: 201 });
  },
  { requireMembership: false },
);
