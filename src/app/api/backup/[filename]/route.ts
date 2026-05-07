import { NextRequest, NextResponse } from 'next/server';
import { getSessionUserId } from '@/lib/sessions';
import { getBackupFile } from '@/lib/backup';

/**
 * GET /api/backup/[filename] — Download a specific backup file
 * Query: ?companyId=xxx
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const userId = getSessionUserId(request);
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { filename } = await params;

    if (!filename) {
      return NextResponse.json({ error: 'Filename is required' }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    const companyId = searchParams.get('companyId');

    if (!companyId) {
      return NextResponse.json({ error: 'companyId is required' }, { status: 400 });
    }

    // Verify membership
    const { db } = await import('@/lib/db');
    const membership = await db.companyMember.findFirst({
      where: { userId, companyId },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const result = getBackupFile(filename);

    if (!result) {
      return NextResponse.json({ error: 'Backup file not found' }, { status: 404 });
    }

    // Return as downloadable JSON file
    const base64Data = Buffer.from(result.data, 'utf-8').toString('base64');

    return NextResponse.json({
      filename,
      size: result.size,
      data: base64Data,
    });
  } catch (error) {
    console.error('[BACKUP DOWNLOAD ERROR]', error);
    return NextResponse.json({ error: 'Failed to download backup' }, { status: 500 });
  }
}
