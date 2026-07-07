import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { ValidationError } from '@/lib/api-error';
import { parseCSV } from '@/lib/csv-parser';
import { parseOFX } from '@/lib/ofx-parser';
import { parsePDFAsync } from '@/lib/pdf-processor';
import { validateFile } from '@/lib/file-validation';
import { logger } from '@/lib/logger';

interface AnalyzeFileResult {
  fileName: string;
  extension: string;
  bankName: string | null;
  accountSuffix: string | null;
  exists: boolean;
  existingAccountId: string | null;
  existingAccountName: string | null;
  error: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

function extractBankNameFromFilename(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  const parts = base.split(/[-_\s]+/).filter(Boolean);
  const bankKeywords = [
    'chase', 'bank', 'wells', 'fargo', 'citi', 'america',
    'bofa', 'hsbc', 'paypal', 'venmo', 'cashapp',
  ];
  const matchingParts = parts.filter((p) =>
    bankKeywords.some((kw) => p.toLowerCase().includes(kw)),
  );
  if (matchingParts.length > 0) {
    return matchingParts
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join(' ');
  }
  if (parts.length > 0 && parts[0].length > 2) {
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
  }
  return 'Cuenta Bancaria Importada';
}

function getLastSix(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 6 ? digits.slice(-6) : digits;
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  const formData = await request.formData();
  const files = formData.getAll('files') as File[];

  if (!files || files.length === 0) {
    throw new ValidationError('Se requieren uno o más archivos para analizar.');
  }

  const results: AnalyzeFileResult[] = [];

  for (const file of files) {
    const fileName = file.name;
    const baseResult: Omit<AnalyzeFileResult, 'exists' | 'existingAccountId' | 'existingAccountName'> = {
      fileName,
      extension: '',
      bankName: null,
      accountSuffix: null,
      error: null,
      periodStart: null,
      periodEnd: null,
    };

    let buffer: Buffer;
    let extension: string;

    try {
      buffer = Buffer.from(await file.arrayBuffer());
      extension = validateFile(file, buffer);
    } catch (err: unknown) {
      results.push({
        ...baseResult,
        extension: fileName.split('.').pop()?.toLowerCase() || '',
        error: err instanceof Error ? err.message : String(err),
        exists: false,
        existingAccountId: null,
        existingAccountName: null,
      });
      continue;
    }

    baseResult.extension = extension;

    try {
      let bankName: string | null = null;
      let accountNo: string | null = null;
      let periodStart: string | null = null;
      let periodEnd: string | null = null;

      if (extension === 'pdf') {
        const parsed = await parsePDFAsync(buffer, { fileName, companyId, userId });
        bankName = parsed.bankName || extractBankNameFromFilename(fileName);
        accountNo = parsed.accountNo || null;
        periodStart = parsed.startDate?.toISOString() || null;
        periodEnd = parsed.endDate?.toISOString() || null;
      } else if (extension === 'ofx' || extension === 'qfx') {
        const content = buffer.toString('utf-8');
        const parsed = parseOFX(content);
        bankName = parsed.bankName || extractBankNameFromFilename(fileName);
        accountNo = parsed.accountNumber || null;
        periodStart = parsed.startDate?.toISOString() || null;
        periodEnd = parsed.endDate?.toISOString() || null;
      } else if (extension === 'csv' || extension === 'tsv' || extension === 'txt') {
        bankName = extractBankNameFromFilename(fileName);
      }

      baseResult.bankName = bankName;
      baseResult.accountSuffix = getLastSix(accountNo);

      // Look up existing bank account
      let existingAccountId: string | null = null;
      let existingAccountName: string | null = null;
      let exists = false;

      if (bankName) {
        const match = await db.bankAccount.findFirst({
          where: {
            companyId,
            bankName,
            ...(accountNo ? { accountNo } : {}),
            isActive: true,
          },
          select: { id: true, accountName: true },
        });
        if (match) {
          exists = true;
          existingAccountId = match.id;
          existingAccountName = match.accountName;
        }
      }

      results.push({
        ...baseResult,
        exists,
        existingAccountId,
        existingAccountName,
      });
    } catch (err: unknown) {
      logger.error('[IMPORT ANALYZE ERROR]', { fileName, error: err instanceof Error ? err.message : String(err) });
      results.push({
        ...baseResult,
        error: err instanceof Error ? err.message : String(err),
        exists: false,
        existingAccountId: null,
        existingAccountName: null,
      });
    }
  }

  return NextResponse.json({ results });
});
