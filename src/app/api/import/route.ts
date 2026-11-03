import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';
import { ValidationError } from '@/lib/api-error';
import { ImportService } from '@/lib/services/import.service';
import { trackAPIResponseTime } from '@/lib/metrics';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { validateFile } from '@/lib/file-validation';
import { decodeCsvBuffer } from '@/lib/csv-parser';
import { serverT } from '@/lib/server-i18n';

/** Formats decoded as text (BOM / UTF-16 aware). PDF is binary and excluded. */
const TEXT_EXTENSIONS = new Set(['csv', 'tsv', 'txt', 'ofx', 'qfx']);

// ─── POST /api/import ─────────────────────────────────────────────────
// Accepts multipart/form-data with a file field.
// Supports CSV, OFX, QFX, PDF formats.
export const POST = apiHandler(async (request: NextRequest) => {
  const locale = request.headers.get('x-locale') || 'es';
  const { userId, companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin']);
  await requireModuleEntitlement('banking');

  const MAX_SIZE = 10 * 1024 * 1024;
  // The upload is multipart/form-data, so the declared body length includes the
  // boundary/part headers. Reject before buffering the body; `file.size` below
  // stays the authoritative per-file limit.
  const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
  const declaredLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SIZE + MULTIPART_OVERHEAD_BYTES) {
    throw new ValidationError(serverT(locale, 'apiErrors.import.tooLarge'));
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const bankAccountId = formData.get('bankAccountId') as string | null;
  const bypassHolderValidation = formData.get('bypassHolderValidation') === 'true';

  if (!file) {
    throw new ValidationError(serverT(locale, 'apiErrors.import.noFile'));
  }

  if (file.size > MAX_SIZE) {
    throw new ValidationError(serverT(locale, 'apiErrors.import.tooLarge'));
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const extension = validateFile(file, buffer);
  const fileName = file.name;
  // S20.5 — strip/interpret the encoding BEFORE parsing: a UTF-8 BOM would
  // corrupt the first header and UTF-16 uploads would decode to garbage.
  // Only delimited text formats are decoded this way: binary formats (PDF) are
  // parsed from `buffer` and must never be heuristically re-decoded.
  const content = TEXT_EXTENSIONS.has(extension)
    ? decodeCsvBuffer(buffer)
    : buffer.toString('utf-8');

  const importStart = performance.now();
  const result = await ImportService.importFile({
    companyId,
    bankAccountId,
    fileName,
    extension,
    buffer,
    content,
    userId,
    bypassHolderValidation,
  });
  trackAPIResponseTime('ImportService.importFile', 'POST', performance.now() - importStart);

  return NextResponse.json(result);
});
