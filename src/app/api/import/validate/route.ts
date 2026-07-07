import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { ValidationError } from '@/lib/api-error';
import { parsePDFAsync } from '@/lib/pdf-processor';
import {
  validateAccountHolder,
  isStrictModeEnabled,
} from '@/lib/validation/account-holder-validator';
import { validateFile } from '@/lib/file-validation';

export const POST = apiHandler(async (request: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  const formData = await request.formData();
  const files = formData.getAll('files') as File[];

  if (!files || files.length === 0) {
    throw new ValidationError('Se requieren uno o más archivos para validar.');
  }

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { legalName: true },
  });
  const companyName = company?.legalName || '';
  interface ValidationResult {
    fileName: string;
    extension: string;
    requiresApproval: boolean;
    extractedHolder?: string;
    score?: number;
    error?: string;
    companyName?: string;
    matches?: boolean;
  }

  const results: ValidationResult[] = [];

  for (const file of files) {
    const fileName = file.name;
    const buffer = Buffer.from(await file.arrayBuffer());

    let extension: string;
    try {
      extension = validateFile(file, buffer);
    } catch {
      results.push({
        fileName,
        extension: fileName.split('.').pop()?.toLowerCase() || '',
        extractedHolder: 'Error de validación',
        companyName,
        score: 0.0,
        matches: false,
        requiresApproval: true,
        error: 'El archivo no pasó la validación de seguridad',
      });
      continue;
    }

    if (extension !== 'pdf') {
      // Non-PDF files are approved by default as they don't contain holder name metadata in standard text form
      results.push({
        fileName,
        extension,
        extractedHolder: 'N/A',
        companyName,
        score: 1.0,
        matches: true,
        requiresApproval: false,
      });
      continue;
    }

    try {
      const parsed = await parsePDFAsync(buffer);
      const extractedHolder = parsed.accountHolder || '';

      const validation = validateAccountHolder(extractedHolder, companyName);

      results.push({
        fileName,
        extension,
        extractedHolder: extractedHolder || 'No detectado',
        companyName,
        score: Math.round(validation.score * 100) / 100,
        matches: validation.matches,
        requiresApproval: validation.requiresApproval,
      });
    } catch (err: unknown) {
      results.push({
        fileName,
        extension,
        extractedHolder: 'Error al parsear PDF',
        companyName,
        score: 0.0,
        matches: false,
        requiresApproval: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({ results, strictMode: isStrictModeEnabled() });
});
