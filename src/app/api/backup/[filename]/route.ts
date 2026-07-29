import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { getBackupFile } from '@/lib/backup';
import { createAuditLogWithRetry } from '@/lib/audit';

/**
 * GET /api/backup/[filename] — Download a specific backup file
 * Query: ?companyId=xxx
 */
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const { filename } = await context.params;

  if (!filename) {
    return NextResponse.json({ error: 'Filename is required' }, { status: 400 });
  }

  // Path traversal prevention: reject path separators, .., and enforce companyId prefix
  if (
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    !filename.startsWith(`${companyId}_`) ||
    !filename.endsWith('.json')
  ) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
  }

  const result = getBackupFile(filename);

  if (!result) {
    return NextResponse.json({ error: 'Backup file not found' }, { status: 404 });
  }

  // Audit Contract v1 — SecurityEvent: backup downloaded
  await createAuditLogWithRetry({
    companyId,
    userId,
    action: 'SECURITY_BACKUP_DOWNLOADED',
    entity: 'Backup',
    entityId: filename,
    details: JSON.stringify({
      contractVersion: 1,
      filename,
      size: result.size,
    }),
  });

  // Return as downloadable JSON file
  const base64Data = Buffer.from(result.data, 'utf-8').toString('base64');

  return NextResponse.json({
    filename,
    size: result.size,
    data: base64Data,
  });
});
