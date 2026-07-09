import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { restoreBackup, validateBackup, type BackupData } from '@/lib/backup';
import { createSession } from '@/lib/sessions';

export const POST = apiHandler(
  async (request: NextRequest) => {
    const companyCount = await db.company.count();
    if (companyCount > 0) {
      return NextResponse.json(
        { error: 'El sistema ya tiene datos. No se puede inicializar desde un respaldo.', code: 'DB_NOT_EMPTY' },
        { status: 409 },
      );
    }

    let backupData: BackupData;

    const contentType = request.headers.get('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = formData.get('file') as File | null;
      if (!file) {
        return NextResponse.json({ error: 'No se subió ningún archivo' }, { status: 400 });
      }

      const MAX_BACKUP_SIZE = 50 * 1024 * 1024;
      if (file.size > MAX_BACKUP_SIZE) {
        return NextResponse.json({ error: 'El archivo de respaldo supera el tamaño máximo (50MB)' }, { status: 400 });
      }

      const name = file.name.toLowerCase();
      if (!name.endsWith('.json') && !name.endsWith('.backup')) {
        return NextResponse.json({ error: 'Extensión inválida. Solo archivos .json y .backup' }, { status: 400 });
      }

      const fileBuffer = await file.arrayBuffer();
      const firstByte = new Uint8Array(fileBuffer.slice(0, 1))[0];
      if (firstByte !== 0x7b && firstByte !== 0x5b) {
        return NextResponse.json({ error: 'Archivo inválido: no es un JSON válido' }, { status: 400 });
      }

      const jsonString = new TextDecoder().decode(fileBuffer);
      try {
        backupData = JSON.parse(jsonString) as BackupData;
      } catch {
        return NextResponse.json({ error: 'Archivo inválido: no es un JSON válido' }, { status: 400 });
      }
    } else {
      const body = await request.json();
      const base64Data = body.data;
      if (!base64Data) {
        return NextResponse.json({ error: 'Se requiere data en base64' }, { status: 400 });
      }
      try {
        const jsonString = Buffer.from(base64Data, 'base64').toString('utf-8');
        backupData = JSON.parse(jsonString) as BackupData;
      } catch {
        return NextResponse.json({ error: 'Datos inválidos: no es base64/JSON válido' }, { status: 400 });
      }
    }

    const validation = validateBackup(backupData);
    if (!validation.valid) {
      return NextResponse.json(
        { error: `Respaldo inválido: ${validation.errors.join(', ')}` },
        { status: 400 },
      );
    }

    const companyId = backupData.manifest.companyId;
    const result = await restoreBackup(companyId, backupData, { bootstrap: true });

    if (!result.success) {
      return NextResponse.json({ error: result.message }, { status: 400 });
    }

    const restoredUser = backupData.data.users[0];
    if (!restoredUser?.id) {
      return NextResponse.json({ error: 'El respaldo no contiene usuarios' }, { status: 400 });
    }

    const token = await createSession(restoredUser.id as string);

    const user = await db.user.findUnique({
      where: { id: restoredUser.id as string },
      select: { id: true, email: true, firstName: true, lastName: true, role: true },
    });

    const companies = await db.companyMember.findMany({
      where: { userId: restoredUser.id as string },
      include: {
        company: {
          select: { id: true, legalName: true, entityType: true, taxId: true, isOnboardingComplete: true },
        },
      },
    });

    const response = NextResponse.json({
      success: true,
      message: result.message,
      restoredCounts: result.restoredCounts,
      user,
      companies: companies.map((m) => m.company),
    });

    const isProd = process.env.NODE_ENV === 'production';
    response.cookies.set(isProd ? '__Host-session' : 'session', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    });

    return response;
  },
  { allowAnonymous: true, requireMembership: false },
);
