import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { restoreBackup, validateBackup, type BackupData } from '@/lib/backup';

/**
 * POST /api/backup/restore — Restore from backup
 * Body (JSON): { companyId: string, data: string (base64) }
 * Body (FormData): companyId (field) + file (File attachment)
 */
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();

  let backupData: BackupData;

  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    // Handle FormData upload
    const formData = await request.formData();

    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const MAX_BACKUP_SIZE = 50 * 1024 * 1024; // 50MB
    if (file.size > MAX_BACKUP_SIZE) {
      return NextResponse.json(
        { error: 'Backup file exceeds maximum size (50MB)' },
        { status: 400 },
      );
    }

    const name = file.name.toLowerCase();
    if (!name.endsWith('.json') && !name.endsWith('.backup')) {
      return NextResponse.json(
        { error: 'Invalid file extension. Only .json and .backup files are allowed' },
        { status: 400 },
      );
    }

    const fileBuffer = await file.arrayBuffer();
    const firstByte = new Uint8Array(fileBuffer.slice(0, 1))[0];
    if (firstByte !== 0x7b && firstByte !== 0x5b) {
      return NextResponse.json({ error: 'Invalid backup file: not a JSON file' }, { status: 400 });
    }

    const jsonString = new TextDecoder().decode(fileBuffer);

    try {
      backupData = JSON.parse(jsonString) as BackupData;
    } catch {
      return NextResponse.json({ error: 'Invalid backup file: not valid JSON' }, { status: 400 });
    }
  } else {
    // Handle JSON body with base64 data
    const body = await request.json();
    const base64Data = body.data;

    if (!base64Data) {
      return NextResponse.json({ error: 'companyId and data are required' }, { status: 400 });
    }

    try {
      const jsonString = Buffer.from(base64Data, 'base64').toString('utf-8');
      backupData = JSON.parse(jsonString) as BackupData;
    } catch {
      return NextResponse.json(
        { error: 'Invalid backup data: not valid base64/JSON' },
        { status: 400 },
      );
    }
  }

  // Validate backup structure
  const validation = validateBackup(backupData);
  if (!validation.valid) {
    return NextResponse.json(
      { error: `Invalid backup: ${validation.errors.join(', ')}` },
      { status: 400 },
    );
  }

  // Execute restore
  const result = await restoreBackup(companyId, backupData);

  if (!result.success) {
    return NextResponse.json({ error: result.message }, { status: 400 });
  }

  return NextResponse.json({
    success: true,
    message: result.message,
    restoredCounts: result.restoredCounts,
  });
});
