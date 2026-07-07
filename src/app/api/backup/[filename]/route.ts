import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { getBackupFile } from '@/lib/backup';

/**
 * GET /api/backup/[filename] — Download a specific backup file
 * Query: ?companyId=xxx
 */
export const GET = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();
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

  // Return as downloadable JSON file
  const base64Data = Buffer.from(result.data, 'utf-8').toString('base64');

  return NextResponse.json({
    filename,
    size: result.size,
    data: base64Data,
  });
});
