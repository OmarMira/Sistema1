import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { previewCompanyRestore } from '@/lib/backup-restore';
import { getBackupFile } from '@/lib/backup';
import { requireCompanyRole } from '@/lib/rbac';

/**
 * Server-side snapshot lookup for the in-app preview (S11).
 *
 * Kept identical to the restore route: the browser only names a backup, the
 * snapshot text is read here after the name is validated against the caller's
 * company, and the preview source check re-proves the tenant identity. Route
 * files may not export shared helpers (Next only accepts HTTP-method and segment
 * exports), so this is intentionally duplicated rather than moved to a new lib.
 */
type SnapshotLookup = { text: string } | { status: number; code: string; error: string };

function readOwnedSnapshot(companyId: string, filename: unknown): SnapshotLookup {
  if (
    typeof filename !== 'string' ||
    filename.length === 0 ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    !filename.startsWith(`${companyId}_`) ||
    !filename.endsWith('.json')
  ) {
    return { status: 400, code: 'INVALID_BACKUP_FILENAME', error: 'Invalid filename' };
  }
  const stored = getBackupFile(filename);
  if (!stored) return { status: 404, code: 'BACKUP_FILE_NOT_FOUND', error: 'Backup file not found' };
  return { text: stored.data };
}

/**
 * POST /api/backup/restore/preview
 * Body (JSON): { data: string } — inline snapshot text, or
 *              { filename: string } — server-side lookup of a stored backup.
 *
 * The `filename` form keeps the internal snapshot inside the installation: the
 * preview returns counts/checksum/ids only, never the snapshot content.
 */
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  const { companyId } = requireCompanyContext();

  // Preview exposes snapshot contents and counts; require the same role tier
  // as the restore itself.
  await requireCompanyRole(companyId, ['company_admin']);
  const body = await request.json();

  let text: string;
  if (body?.filename !== undefined) {
    const located = readOwnedSnapshot(companyId, body.filename);
    if ('status' in located) {
      return NextResponse.json(
        { error: located.error, code: located.code },
        { status: located.status },
      );
    }
    text = located.text;
  } else {
    const { data } = body;
    if (!data || typeof data !== 'string') return NextResponse.json({ error: 'data required' }, { status: 400 });
    text = data;
  }

  try {
    const preview = await previewCompanyRestore(companyId, text);
    return NextResponse.json({
      companyId: preview.companyId,
      checksum: preview.checksum,
      counts: preview.counts,
      ids: preview.ids,
      blockers: preview.blockers,
      scope: preview.scope,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 400 });
  }
});
