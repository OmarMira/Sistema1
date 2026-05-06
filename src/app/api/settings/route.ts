import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';

/**
 * GET /api/settings — Get company settings
 * PUT /api/settings — Update company info
 */
export async function GET(request: NextRequest) {
  try {
    const userId = getSessionUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const companyId = searchParams.get('companyId');

    if (!companyId) {
      return NextResponse.json({ error: 'companyId is required' }, { status: 400 });
    }

    // Verify membership
    const membership = await db.companyMember.findFirst({
      where: { userId, companyId },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    // Get company info
    const company = await db.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        legalName: true,
        taxId: true,
        address: true,
        phone: true,
        email: true,
        logo: true,
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

    // Get current user info
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      company,
      user,
      stats: {
        memberCount,
        accountCount,
        periodCount: periods.length,
      },
      periods,
    });
  } catch (error) {
    console.error('[SETTINGS GET ERROR]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const userId = getSessionUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { companyId, legalName, taxId, address, phone, email } = body;

    if (!companyId) {
      return NextResponse.json({ error: 'companyId is required' }, { status: 400 });
    }

    // Verify membership (only admins can edit company)
    const membership = await db.companyMember.findFirst({
      where: { userId, companyId },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

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

    return NextResponse.json({
      message: 'Settings updated successfully',
      company: updated,
    });
  } catch (error) {
    console.error('[SETTINGS PUT ERROR]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

