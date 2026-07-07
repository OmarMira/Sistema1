import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { ForbiddenError, ValidationError } from '@/lib/api-error';
import { usAddressSchema } from '@/lib/validations/us-address';
import { saveLogo, deleteLogo } from '@/lib/uploads/logo-service';

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  const formData = await request.formData();

  // Verify company admin role
  const membership = await db.companyMember.findUnique({
    where: { userId_companyId: { userId, companyId } },
  });

  if (membership?.role !== 'company_admin') {
    throw new ForbiddenError('No tiene permisos para modificar la configuración de esta empresa.');
  }

  // 1. Parse and validate US address
  const addressRaw = formData.get('address') as string | null;
  if (!addressRaw) {
    throw new ValidationError('Los datos de dirección son requeridos.');
  }

  const addressData = usAddressSchema.parse(JSON.parse(addressRaw));

  // 2. Handle Logo Upload
  const logoFile = formData.get('logo') as File | null;
  let newLogoPath: string | undefined = undefined;

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { logo: true },
  });

  const logoCleared = formData.get('logoCleared') === 'true';
  let shouldUpdateLogo = false;

  if (logoFile && logoFile.size > 0) {
    newLogoPath = await saveLogo(logoFile);
    if (company?.logo) {
      await deleteLogo(company.logo); // Clean up old logo
    }
    shouldUpdateLogo = true;
  } else if (logoCleared) {
    newLogoPath = '';
    if (company?.logo) {
      await deleteLogo(company.logo); // Clean up old logo
    }
    shouldUpdateLogo = true;
  }

  // 3. Handle entityFirstMode toggle
  const entityFirstModeRaw = formData.get('entityFirstMode');
  const entityFirstMode =
    entityFirstModeRaw === 'true' ? true : entityFirstModeRaw === 'false' ? false : undefined;

  // 4. Update profile and audit in database transaction
  await db.$transaction(async (tx) => {
    await tx.company.update({
      where: { id: companyId },
      data: {
        streetLine1: addressData.streetLine1,
        streetLine2: addressData.streetLine2 || '',
        city: addressData.city,
        state: addressData.state,
        zipCode: addressData.zipCode,
        phone: addressData.phone || '',
        email: (formData.get('email') as string) || '',
        ...(shouldUpdateLogo && { logo: newLogoPath }),
        ...(entityFirstMode !== undefined && { entityFirstMode }),
      },
    });

    await tx.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'COMPANY_PROFILE_UPDATED',
        entity: 'Company',
        entityId: companyId,
        details: JSON.stringify({
          updatedBy: userId,
          fieldsChanged: [
            'streetLine1',
            'streetLine2',
            'city',
            'state',
            'zipCode',
            'phone',
            'email',
            ...(newLogoPath ? ['logo'] : []),
          ],
          timestamp: new Date().toISOString(),
        }),
      },
    });
  });

  return NextResponse.json({ success: true, logo: newLogoPath || company?.logo });
});
