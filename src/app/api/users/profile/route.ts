import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { ValidationError } from '@/lib/api-error';
import { usAddressSchema } from '@/lib/validations/us-address';
import { saveLogo, deleteLogo } from '@/lib/uploads/logo-service';

export const PATCH = apiHandler(
  async (request: NextRequest) => {
    const userId = requireCurrentUserId();

    const formData = await request.formData();

    // 1. Parse and validate US address
    const addressRaw = formData.get('address') as string | null;
    if (!addressRaw) {
      throw new ValidationError('Los datos de dirección son requeridos.');
    }

    const addressData = usAddressSchema.parse(JSON.parse(addressRaw));

    // 2. Handle Avatar/Logo Upload (re-use saveLogo service as it supports exactly max 1MB image uploads)
    const avatarFile = formData.get('avatar') as File | null;
    const avatarCleared = formData.get('avatarCleared') === 'true';
    let newAvatarPath: string | undefined = undefined;
    let shouldUpdateAvatar = false;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { avatar: true, firstName: true, lastName: true },
    });

    if (avatarFile && avatarFile.size > 0) {
      newAvatarPath = await saveLogo(avatarFile);
      if (user?.avatar) {
        await deleteLogo(user.avatar); // Clean up old avatar
      }
      shouldUpdateAvatar = true;
    } else if (avatarCleared) {
      newAvatarPath = '';
      if (user?.avatar) {
        await deleteLogo(user.avatar); // Clean up old avatar
      }
      shouldUpdateAvatar = true;
    }

    const firstName = (formData.get('firstName') as string) || '';
    const lastName = (formData.get('lastName') as string) || '';

    if (!firstName.trim() || !lastName.trim()) {
      throw new ValidationError('Nombre y Apellido son requeridos.');
    }

    // 3. Update profile and audit in database transaction
    const updatedUser = await db.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          streetLine1: addressData.streetLine1,
          streetLine2: addressData.streetLine2 || '',
          city: addressData.city,
          state: addressData.state,
          zipCode: addressData.zipCode,
          phone: addressData.phone || '',
          ...(shouldUpdateAvatar && { avatar: newAvatarPath }),
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          streetLine1: true,
          streetLine2: true,
          city: true,
          state: true,
          zipCode: true,
          avatar: true,
        },
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: 'USER_PROFILE_UPDATED',
          entity: 'User',
          entityId: userId,
          details: JSON.stringify({
            updatedBy: userId,
            fieldsChanged: [
              'firstName',
              'lastName',
              'streetLine1',
              'streetLine2',
              'city',
              'state',
              'zipCode',
              'phone',
              ...(shouldUpdateAvatar ? ['avatar'] : []),
            ],
            timestamp: new Date().toISOString(),
          }),
        },
      });

      return updated;
    });

    return NextResponse.json({ success: true, user: updatedUser });
  },
  { requireMembership: false },
);
