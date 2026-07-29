import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { createBackup, listBackups, deleteBackup } from '@/lib/backup';
import { createAuditLogWithRetry } from '@/lib/audit';

/**
 * POST /api/backup — Create a full backup for a company
 */
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();

  const result = await createBackup(companyId);

  // Audit Contract v1 — BACKUP_CREATED
  await createAuditLogWithRetry({
    companyId,
    userId,
    action: 'BACKUP_CREATED',
    entity: 'Backup',
    entityId: result.id,
    details: JSON.stringify({
      contractVersion: 1,
      filename: result.filename,
      size: result.size,
      recordCounts: result.recordCounts,
    }),
  });

  return NextResponse.json({
    id: result.id,
    filename: result.filename,
    size: result.size,
    createdAt: result.createdAt,
    data: result.data,
    recordCounts: result.recordCounts,
  });
});

/**
 * GET /api/backup — List backups for a company
 * Query: ?companyId=xxx
 */
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();

  const backups = listBackups(companyId);

  return NextResponse.json({ backups });
});

/**
 * DELETE /api/backup — Delete a specific backup
 * Body: { companyId: string, filename: string }
 */
export const DELETE = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { userId, companyId } = requireCompanyContext();
  const body = await request.json();
  const { filename } = body;

  if (!filename) {
    return NextResponse.json({ error: 'companyId and filename are required' }, { status: 400 });
  }

  // Ownership check: filename must belong to the session's company
  if (!filename.startsWith(`${companyId}_`)) {
    return NextResponse.json({ error: 'Backup file does not belong to this company' }, { status: 403 });
  }

  const success = deleteBackup(filename);

  if (!success) {
    return NextResponse.json({ error: 'Backup file not found' }, { status: 404 });
  }

  // Audit Contract v1 — BACKUP_DELETED
  await createAuditLogWithRetry({
    companyId,
    userId,
    action: 'BACKUP_DELETED',
    entity: 'Backup',
    entityId: filename,
    details: JSON.stringify({
      contractVersion: 1,
      filename,
    }),
  });

  return NextResponse.json({ success: true, message: 'Backup deleted' });
});
