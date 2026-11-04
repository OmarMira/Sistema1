import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requireModuleEntitlement } from '@/lib/module-entitlement-guard';
import { AppError, ValidationError } from '@/lib/api-error';
import { ImportService } from '@/lib/services/import.service';
import type { ImportResult, ImportRowRejection } from '@/lib/services/import.service';
import { trackAPIResponseTime } from '@/lib/metrics';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { validateFile } from '@/lib/file-validation';
import { decodeCsvBuffer } from '@/lib/csv-parser';
import { serverT } from '@/lib/server-i18n';
import { logger } from '@/lib/logger';

/** Formats decoded as text (BOM / UTF-16 aware). PDF is binary and excluded. */
const TEXT_EXTENSIONS = new Set(['csv', 'tsv', 'txt', 'ofx', 'qfx']);

const MAX_SIZE = 10 * 1024 * 1024;

// The upload is multipart/form-data, so the declared body length includes the
// boundary/part headers. `file.size` stays the authoritative per-file limit.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * S2 — files accepted in ONE batch request.
 *
 * A batch needs a bounded body, and the declared content-length of a batch is
 * only knowable before buffering as a single ceiling. This is therefore both
 * the file-count limit and the multiplier of the pre-buffer body ceiling.
 */
const MAX_FILES_PER_REQUEST = 10;

/**
 * S3 — stable, translatable reason for an import rejection.
 *
 * `ValidationError` always answers the family code `VALIDATION_ERROR`, so the
 * specific reason rides in `details.code`, which apiHandler forwards verbatim
 * and the frontend resolves against the `errors.<CODE>` locale catalog.
 */
type ImportErrorCode = 'IMPORT_NO_FILE' | 'IMPORT_TOO_LARGE' | 'IMPORT_TOO_MANY_FILES';

function importError(message: string, code: ImportErrorCode): ValidationError {
  return new ValidationError(message, { code });
}

/** Per-file outcome of a multi-file import (S2). */
export interface ImportBatchFileResult {
  fileName: string;
  status: 'imported' | 'skipped' | 'failed';
  /** Spanish, human-readable reason — always present for skipped/failed. */
  reason?: string;
  statementId?: string;
  transactionCount: number;
  autoCategorizedCount?: number;
  duplicatesSkipped: number;
  newAccountCreated?: boolean;
  bankAccountName?: string;
  /** Rows skipped/quarantined inside this file (same contract as a single import). */
  rejectedRows?: ImportRowRejection[];
}

/** Batch response body. Emitted ONLY when the request carries more than 1 file. */
export interface ImportBatchResult {
  status: 'imported' | 'partial' | 'failed';
  results: ImportBatchFileResult[];
}

// ─── POST /api/import ─────────────────────────────────────────────────
// Accepts multipart/form-data with a file field.
// Supports CSV, OFX, QFX, PDF formats.
export const POST = apiHandler(async (request: NextRequest) => {
  const locale = request.headers.get('x-locale') || 'es';
  const { userId, companyId } = requireCompanyContext();
  await requireCompanyRole(companyId, ['company_admin']);
  await requireModuleEntitlement('banking');

  // Ceiling for the whole request, checked BEFORE the body is buffered. A
  // single file therefore keeps its exact previous behavior; a batch is one
  // part per file, so the ceiling scales with MAX_FILES_PER_REQUEST.
  const declaredLength = Number(request.headers.get('content-length') ?? '');
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_FILES_PER_REQUEST * (MAX_SIZE + MULTIPART_OVERHEAD_BYTES)
  ) {
    throw importError(serverT(locale, 'apiErrors.import.tooLarge'), 'IMPORT_TOO_LARGE');
  }

  const formData = await request.formData();
  const files = collectImportFiles(formData);
  const bankAccountId = formData.get('bankAccountId') as string | null;
  const bypassHolderValidation = formData.get('bypassHolderValidation') === 'true';

  if (files.length === 0) {
    throw importError(serverT(locale, 'apiErrors.import.noFile'), 'IMPORT_NO_FILE');
  }

  if (files.length > MAX_FILES_PER_REQUEST) {
    throw importError(
      `No se pueden importar más de ${MAX_FILES_PER_REQUEST} archivos en una sola petición. Divídalos en lotes más pequeños.`,
      'IMPORT_TOO_MANY_FILES',
    );
  }

  const importFile = (file: File) =>
    importOneFile(file, { locale, companyId, bankAccountId, bypassHolderValidation, userId });

  // Single file: unchanged. One transaction, the historical response body and
  // the historical error contract (pinned by tests/api/import-route-e2e).
  if (files.length === 1) {
    return NextResponse.json(await importFile(files[0]!));
  }

  // S2 — a batch is N independent imports. Each file runs through
  // ImportService.importFile, which owns its OWN transaction, so one failing
  // file can never roll back (or abort) the files around it.
  const results: ImportBatchFileResult[] = [];
  for (const file of files) {
    try {
      results.push(toBatchFileResult(file.name, await importFile(file)));
    } catch (error) {
      const conflict = error instanceof AppError && error.code === 'CONFLICT';
      logger.warn('[IMPORT BATCH] file not imported', {
        fileName: file.name,
        status: conflict ? 'skipped' : 'failed',
        code: error instanceof AppError ? error.code : undefined,
        error: String(error),
      });
      results.push({
        fileName: file.name,
        status: conflict ? 'skipped' : 'failed',
        reason: batchFailureReason(error),
        transactionCount: 0,
        duplicatesSkipped: 0,
      });
    }
  }

  // A partially successful batch cannot be described by a single status code,
  // so the HTTP status stays 200 and `status` + `results` carry the truth.
  return NextResponse.json({ status: overallBatchStatus(results), results });
});

/**
 * Files carried by the request: repeated `files` parts (the convention
 * /api/import/validate already uses) plus a legacy single `file` part, so a
 * client may send either name.
 */
function collectImportFiles(formData: FormData): File[] {
  const files: File[] = [];
  for (const entry of [...formData.getAll('files'), ...formData.getAll('file')]) {
    if (entry instanceof File) files.push(entry);
  }
  return files;
}

async function importOneFile(
  file: File,
  params: {
    locale: string;
    companyId: string;
    bankAccountId: string | null;
    bypassHolderValidation: boolean;
    userId: string;
  },
): Promise<ImportResult> {
  const { locale, companyId, bankAccountId, bypassHolderValidation, userId } = params;

  if (file.size > MAX_SIZE) {
    throw importError(serverT(locale, 'apiErrors.import.tooLarge'), 'IMPORT_TOO_LARGE');
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const extension = validateFile(file, buffer);
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
    fileName: file.name,
    extension,
    buffer,
    content,
    userId,
    bypassHolderValidation,
  });
  trackAPIResponseTime('ImportService.importFile', 'POST', performance.now() - importStart);

  return result;
}

function toBatchFileResult(fileName: string, result: ImportResult): ImportBatchFileResult {
  // A file whose every row already exists added nothing: that is a skip
  // (content-hash dedupe), never a failure.
  const alreadyImported = result.transactionCount === 0 && result.duplicatesSkipped > 0;
  return {
    fileName,
    status: alreadyImported ? 'skipped' : 'imported',
    ...(alreadyImported && {
      reason: `Archivo ya importado: no se agregaron transacciones nuevas (${result.duplicatesSkipped} filas duplicadas omitidas).`,
    }),
    statementId: result.statementId,
    transactionCount: result.transactionCount,
    autoCategorizedCount: result.autoCategorizedCount,
    duplicatesSkipped: result.duplicatesSkipped,
    newAccountCreated: result.newAccountCreated,
    bankAccountName: result.bankAccountName,
    ...(result.rejectedRows && { rejectedRows: result.rejectedRows }),
  };
}

/** Spanish, actionable reason. Internal failures never leak driver/ORM text. */
function batchFailureReason(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return 'No se pudo importar este archivo por un error interno. Intente nuevamente; si el problema persiste, contacte al administrador.';
}

function overallBatchStatus(results: ImportBatchFileResult[]): ImportBatchResult['status'] {
  if (results.every((r) => r.status === 'imported')) return 'imported';
  if (results.every((r) => r.status === 'failed')) return 'failed';
  return 'partial';
}
