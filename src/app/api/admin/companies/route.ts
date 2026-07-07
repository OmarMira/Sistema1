import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { saveLogo } from '@/lib/uploads/logo-service';
import { createAdminCompanySchema } from '@/lib/validations/admin';
import { seedChartOfAccounts } from '@/lib/chart-of-accounts';
import { parseAdminBody } from '@/lib/parse-admin-body';

export const GET = apiHandler(
  async () => {
    const companies = await db.company.findMany({
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({ companies });
  },
  { requireSuperAdmin: true, requireMembership: false },
);

export const POST = apiHandler(
  async (request: NextRequest) => {
    const userId = requireCurrentUserId();

    const parsed = await parseAdminBody(request, createAdminCompanySchema);
    if (!parsed.ok) return parsed.error;

    const { legalName, taxId, phone, email, streetLine1, streetLine2, city, state, zipCode } =
      parsed.body.data;
    const logoFile = parsed.body.files.get('logo') ?? null;

    let logoPath: string | null = null;
    if (logoFile) {
      logoPath = await saveLogo(logoFile);
    }

    const companyAddress =
      [streetLine1, streetLine2, city, state, zipCode].filter(Boolean).join(', ') || null;

    const company = await db.$transaction(async (tx) => {
      const newCompany = await tx.company.create({
        data: {
          legalName,
          taxId: taxId || null,
          address: companyAddress,
          phone: phone || null,
          email: email || null,
          streetLine1: streetLine1 ?? '',
          streetLine2: streetLine2 ?? '',
          city: city ?? '',
          state: state ?? '',
          zipCode: zipCode ?? '',
          logo: logoPath,
          isActive: true,
        },
      });

      await tx.companyMember.create({
        data: {
          userId,
          companyId: newCompany.id,
          role: 'company_admin',
        },
      });

       
      await seedChartOfAccounts(tx as any, newCompany.id);

      await tx.auditLog.create({
        data: {
          companyId: newCompany.id,
          userId,
          action: 'create_company',
          entity: 'Company',
          entityId: newCompany.id,
          details: `Created company ${newCompany.legalName} and auto-seeded chart of accounts`,
        },
      });

      return newCompany;
    });

    return NextResponse.json({ company }, { status: 201 });
  },
  { requireSuperAdmin: true, requireMembership: false },
);
