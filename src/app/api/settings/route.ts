import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { companySettingsCache } from '@/lib/cache';
import { logger } from '@/lib/logger';

/**
 * GET /api/settings — Get company settings
 * PUT /api/settings — Update company info
 */
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  try {
    // Try cache first for company data
    let companyData = companySettingsCache.get(companyId);

    if (!companyData) {
      // Get company info
      const company = await db.company.findUnique({
        where: { id: companyId },
        select: {
          id: true,
          legalName: true,
          taxId: true,
          address: true,
          streetLine1: true,
          streetLine2: true,
          city: true,
          state: true,
          zipCode: true,
          phone: true,
          email: true,
          logo: true,
          entityFirstMode: true,
          isActive: true,
          createdAt: true,
        },
      });

      if (!company) {
        return NextResponse.json({ error: 'Company not found' }, { status: 404 });
      }

      // Get user count and member count
      const memberCount = await db.companyMember.count({
        where: { companyId },
      });

      // Get GL account count
      const accountCount = await db.glAccount.count({
        where: { companyId },
      });

      // Get fiscal periods
      const periods = await db.fiscalPeriod.findMany({
        where: { companyId },
        orderBy: { startDate: 'asc' },
        select: { id: true, name: true, startDate: true, endDate: true, isLocked: true },
      });

      companyData = {
        company,
        stats: {
          memberCount,
          accountCount,
          periodCount: periods.length,
        },
        periods,
      };

      companySettingsCache.set(companyId, companyData);
    }

    // Get current user info (not cached, user-specific)
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        phone: true,
        streetLine1: true,
        streetLine2: true,
        city: true,
        state: true,
        zipCode: true,
        avatar: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      company: companyData.company,
      user,
      stats: companyData.stats,
      periods: companyData.periods,
    });
  } catch (error) {
    logger.error('[SETTINGS GET ERROR]', { error: String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});

export const PUT = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  try {
    const body = await request.json();
    const { legalName, taxId, address, phone, email } = body;

    // Check if user is company admin or super admin
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (!user || (user.role !== 'company_admin' && user.role !== 'super_admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    // Build update data
    const updateData: Record<string, string | null> = {};
    if (legalName !== undefined) {
      if (!legalName.trim()) {
        return NextResponse.json({ error: 'Legal name is required' }, { status: 400 });
      }
      updateData.legalName = legalName.trim();
    }
    if (taxId !== undefined) updateData.taxId = taxId?.trim() || null;
    if (address !== undefined) updateData.address = address?.trim() || null;
    if (phone !== undefined) updateData.phone = phone?.trim() || null;
    if (email !== undefined) updateData.email = email?.trim() || null;

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const updated = await db.company.update({
      where: { id: companyId },
      data: updateData,
      select: {
        id: true,
        legalName: true,
        taxId: true,
        address: true,
        phone: true,
        email: true,
      },
    });

    // Log audit
    await db.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'update_company_settings',
        entity: 'Company',
        entityId: companyId,
        details: JSON.stringify(updateData),
      },
    });

    companySettingsCache.invalidate(companyId);

    return NextResponse.json({
      message: 'Settings updated successfully',
      company: updated,
    });
  } catch (error) {
    logger.error('[SETTINGS PUT ERROR]', { error: String(error) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
