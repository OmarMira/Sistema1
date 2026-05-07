import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';
import { parseCSV } from '@/lib/csv-parser';
import { parseOFX } from '@/lib/ofx-parser';
import { parsePDF } from '@/lib/pdf-parser';

// ─── POST /api/import ─────────────────────────────────────────────────
// Accepts multipart/form-data with a "file" field (single) or "files" field (multiple).
// Supports CSV, OFX, QFX, and PDF formats.
export async function POST(request: NextRequest) {
  const userId = await getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const companyId = formData.get('companyId') as string | null;
    const bankAccountId = formData.get('bankAccountId') as string | null;

    if (!companyId) {
      return NextResponse.json(
        { error: 'companyId is required' },
        { status: 400 }
      );
    }

    // Verify membership
    console.log('[IMPORT] Verifying membership for user', userId, 'company', companyId);
    const membership = await db.companyMember.findUnique({
      where: { userId_companyId: { userId, companyId } },
    });
    if (!membership) {
      console.error('[IMPORT] Membership not found for user', userId, 'company', companyId);
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Check for multiple files ("files" field) or single file ("file" field)
    const multiFiles = formData.getAll('files').filter((f) => f instanceof File) as File[];
    const singleFile = formData.get('file') as File | null;

    if (multiFiles.length > 0) {
      // ─── Multi-file import ────────────────────────────────────────
      console.log('[IMPORT] Multi-file import: processing', multiFiles.length, 'files');

      const results: {
        fileName: string;
        success: boolean;
        transactionCount?: number;
        autoCategorizedCount?: number;
        duplicatesSkipped?: number;
        newAccountCreated?: boolean;
        bankAccountName?: string;
        statementId?: string;
        error?: string;
      }[] = [];

      for (let i = 0; i < multiFiles.length; i++) {
        const file = multiFiles[i];
        console.log(`[IMPORT] Processing file ${i + 1}/${multiFiles.length}: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

        try {
          const result = await processOneFile(file, companyId, bankAccountId);
          console.log(`[IMPORT] File "${file.name}" succeeded: ${result.transactionCount} transactions`);
          results.push({
            fileName: file.name,
            success: true,
            transactionCount: result.transactionCount,
            autoCategorizedCount: result.autoCategorizedCount,
            duplicatesSkipped: result.duplicatesSkipped,
            newAccountCreated: result.newAccountCreated,
            bankAccountName: result.bankAccountName,
            statementId: result.statementId,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[IMPORT] File "${file.name}" failed: ${msg}`);
          results.push({
            fileName: file.name,
            success: false,
            error: msg,
          });
        }
      }

      const successResults = results.filter((r) => r.success);
      const totalTransactions = successResults.reduce((sum, r) => sum + (r.transactionCount || 0), 0);

      return NextResponse.json({
        results,
        totalTransactions,
        totalFiles: results.length,
        successCount: successResults.length,
        failCount: results.length - successResults.length,
      });
    }

    if (!singleFile) {
      return NextResponse.json(
        { error: 'No file uploaded. Provide a "file" or "files" field.' },
        { status: 400 }
      );
    }

    // ─── Single-file import (backward compatible) ────────────────────
    console.log('[IMPORT] Single-file import:', singleFile.name, `(${(singleFile.size / 1024).toFixed(1)} KB)`);

    try {
      const result = await processOneFile(singleFile, companyId, bankAccountId);
      console.log('[IMPORT] Import successful:', result.transactionCount, 'transactions');

      return NextResponse.json({
        statementId: result.statementId,
        transactionCount: result.transactionCount,
        autoCategorizedCount: result.autoCategorizedCount,
        duplicatesSkipped: result.duplicatesSkipped,
        newAccountCreated: result.newAccountCreated,
        bankAccountName: result.bankAccountName,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[IMPORT] Import failed:', msg);
      return NextResponse.json({ error: msg }, { status: 400 });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[IMPORT ERROR]', msg, error);
    return NextResponse.json(
      { error: `Failed to import bank statement: ${msg}` },
      { status: 500 }
    );
  }
}

// ─── Helper: Process one file ─────────────────────────────────────────

interface ProcessedFileResult {
  statementId: string;
  transactionCount: number;
  autoCategorizedCount: number;
  duplicatesSkipped: number;
  newAccountCreated: boolean;
  bankAccountName: string;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const SUPPORTED_EXTENSIONS = ['csv', 'tsv', 'txt', 'ofx', 'qfx', 'pdf'];

async function processOneFile(
  file: File,
  companyId: string,
  bankAccountId: string | null
): Promise<ProcessedFileResult> {
  // Validate file size
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum size is 10 MB.`);
  }

  const fileName = file.name;
  const extension = fileName.split('.').pop()?.toLowerCase() || '';

  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw new Error(`Unsupported file format: .${extension}. Supported formats: .csv, .tsv, .txt, .ofx, .qfx, .pdf`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const content = buffer.toString('utf-8');

  console.log(`[IMPORT] Parsing file "${fileName}" as .${extension}`);

  // ─── PDF parsing ──────────────────────────────────────────────
  if (extension === 'pdf') {
    console.log('[IMPORT] Using PDF parser for', fileName);
    const parsed = await parsePDF(buffer, fileName);
    console.log(`[IMPORT] PDF parsed: ${parsed.transactions.length} raw transactions`);

    const bankName = parsed.bankName;
    console.log('[IMPORT] Detected bank name:', bankName || '(none)');

    const bankAccount = await findOrCreateBankAccount(
      companyId,
      bankAccountId,
      bankName,
      parsed.transactions
    );
    const newAccountCreated = !bankAccountId;
    console.log('[IMPORT] Using bank account:', bankAccount.accountName, bankAccount.id);

    const result = await importTransactions(
      companyId,
      bankAccount.id,
      parsed.transactions,
      'pdf',
      fileName,
      {
        startDate: parsed.startDate || new Date(),
        endDate: parsed.endDate || new Date(),
        openingBalance: parsed.openingBalance ?? 0,
        closingBalance: parsed.closingBalance ?? 0,
      }
    );

    return {
      statementId: result.statementId,
      transactionCount: result.transactionCount,
      autoCategorizedCount: result.autoCategorizedCount,
      duplicatesSkipped: result.duplicatesSkipped,
      newAccountCreated,
      bankAccountName: bankAccount.accountName,
    };
  }

  // ─── CSV parsing ─────────────────────────────────────────────────
  if (extension === 'csv' || extension === 'tsv' || extension === 'txt') {
    console.log('[IMPORT] Using CSV parser for', fileName);
    const transactions = parseCSV(content);
    console.log(`[IMPORT] CSV parsed: ${transactions.length} raw transactions`);

    const bankName = extractBankNameFromFilename(fileName);
    console.log('[IMPORT] Detected bank name:', bankName);

    const bankAccount = await findOrCreateBankAccount(
      companyId,
      bankAccountId,
      bankName,
      transactions
    );
    const newAccountCreated = !bankAccountId;
    console.log('[IMPORT] Using bank account:', bankAccount.accountName, bankAccount.id);

    const result = await importTransactions(
      companyId,
      bankAccount.id,
      transactions,
      'csv',
      fileName
    );

    return {
      statementId: result.statementId,
      transactionCount: result.transactionCount,
      autoCategorizedCount: result.autoCategorizedCount,
      duplicatesSkipped: result.duplicatesSkipped,
      newAccountCreated,
      bankAccountName: bankAccount.accountName,
    };
  }

  // ─── OFX/QFX parsing ─────────────────────────────────────────────
  if (extension === 'ofx' || extension === 'qfx') {
    console.log('[IMPORT] Using OFX parser for', fileName);
    const parsed = parseOFX(content);
    console.log(`[IMPORT] OFX parsed: ${parsed.transactions.length} raw transactions`);

    const bankName = parsed.bankName;
    console.log('[IMPORT] Detected bank name:', bankName || '(none)');

    const bankAccount = await findOrCreateBankAccount(
      companyId,
      bankAccountId,
      bankName,
      parsed.transactions,
      parsed.accountNumber
    );
    const newAccountCreated = !bankAccountId;
    console.log('[IMPORT] Using bank account:', bankAccount.accountName, bankAccount.id);

    const result = await importTransactions(
      companyId,
      bankAccount.id,
      parsed.transactions,
      extension as 'ofx' | 'qfx',
      fileName,
      {
        startDate: parsed.startDate || new Date(),
        endDate: parsed.endDate || new Date(),
        openingBalance: parsed.openingBalance ?? 0,
        closingBalance: parsed.closingBalance ?? 0,
      }
    );

    return {
      statementId: result.statementId,
      transactionCount: result.transactionCount,
      autoCategorizedCount: result.autoCategorizedCount,
      duplicatesSkipped: result.duplicatesSkipped,
      newAccountCreated,
      bankAccountName: bankAccount.accountName,
    };
  }

  // Should never reach here due to extension check above
  throw new Error(`Unsupported file format: .${extension}`);
}

// ─── Helper: Find or Create Bank Account ──────────────────────────────

async function findOrCreateBankAccount(
  companyId: string,
  bankAccountId: string | null,
  bankName: string,
  transactions: { description: string; amount: number }[],
  accountNumber?: string
) {
  // If a specific bank account was provided, use it
  if (bankAccountId) {
    console.log('[IMPORT] Looking for specific bank account:', bankAccountId);
    const account = await db.bankAccount.findFirst({
      where: { id: bankAccountId, companyId },
    });
    if (!account) {
      throw new Error('Specified bank account not found');
    }
    return account;
  }

  // Try to match existing account by bank name
  if (bankName) {
    console.log('[IMPORT] Searching for existing bank account by name:', bankName);
    const existing = await db.bankAccount.findFirst({
      where: { companyId, bankName, isActive: true },
    });
    if (existing) {
      console.log('[IMPORT] Found existing bank account:', existing.id);
      return existing;
    }
  }

  // Try to match by account number
  if (accountNumber) {
    console.log('[IMPORT] Searching for existing bank account by number:', accountNumber);
    const existing = await db.bankAccount.findFirst({
      where: { companyId, accountNo: accountNumber, isActive: true },
    });
    if (existing) {
      console.log('[IMPORT] Found existing bank account by number:', existing.id);
      return existing;
    }
  }

  // Create new account — find the default cash GL account
  console.log('[IMPORT] No existing bank account found, creating new one');
  const cashAccount = await db.glAccount.findFirst({
    where: { companyId, code: '1010', isActive: true },
  });

  let glAccount;
  if (!cashAccount) {
    console.log('[IMPORT] No GL account with code 1010, searching for any asset account');
    const anyAsset = await db.glAccount.findFirst({
      where: { companyId, accountType: 'asset', isActive: true },
    });
    if (!anyAsset) {
      throw new Error(
        'No asset-type GL account found. Please create one before importing statements.'
      );
    }
    glAccount = anyAsset;
    console.log('[IMPORT] Using asset GL account:', glAccount.id);
  } else {
    glAccount = cashAccount;
    console.log('[IMPORT] Using cash GL account:', glAccount.id);
  }

  const displayName = bankName || 'Imported Bank Account';

  return db.bankAccount.create({
    data: {
      companyId,
      accountName: displayName,
      bankName: displayName,
      accountNo: accountNumber || null,
      glAccountId: glAccount.id,
      balance: 0,
      currency: 'USD',
      isActive: true,
    },
  });
}

// ─── Helper: Import Transactions ──────────────────────────────────────

interface ImportResult {
  statementId: string;
  transactionCount: number;
  autoCategorizedCount: number;
  duplicatesSkipped: number;
}

async function importTransactions(
  companyId: string,
  bankAccountId: string,
  transactions: { date: Date; description: string; amount: number; reference?: string }[],
  format: string,
  fileName: string,
  balanceInfo?: {
    startDate: Date;
    endDate: Date;
    openingBalance: number;
    closingBalance: number;
  }
): Promise<ImportResult> {
  if (transactions.length === 0) {
    throw new Error('No valid transactions found in the file');
  }

  console.log(`[IMPORT] Importing ${transactions.length} transactions for bank account ${bankAccountId}`);

  // Sort by date ascending
  const sorted = [...transactions].sort(
    (a, b) => a.date.getTime() - b.date.getTime()
  );

  const startDate = balanceInfo?.startDate || sorted[0].date;
  const endDate = balanceInfo?.endDate || sorted[sorted.length - 1].date;
  const openingBalance = balanceInfo?.openingBalance ?? 0;
  const closingBalance = balanceInfo?.closingBalance ?? 0;

  // ── Duplicate detection ──
  console.log('[IMPORT] Checking for duplicates...');
  const existingStatements = await db.bankStatement.findMany({
    where: { bankAccountId },
    select: { id: true },
  });
  const existingStatementIds = existingStatements.map((s) => s.id);
  const existingTransactions = await db.bankTransaction.findMany({
    where: { statementId: { in: existingStatementIds } },
    select: { date: true, amount: true, description: true, reference: true },
  });

  // Build a set of unique keys for duplicate checking: date+amount+description(first 30 chars)
  const existingKeys = new Set<string>();
  for (const et of existingTransactions) {
    const key = `${et.date.toISOString().split('T')[0]}|${et.amount}|${et.description.substring(0, 30).toUpperCase()}`;
    existingKeys.add(key);
  }

  // Filter out duplicates
  const uniqueTransactions = sorted.filter((txn) => {
    const key = `${txn.date.toISOString().split('T')[0]}|${txn.amount}|${txn.description.substring(0, 30).toUpperCase()}`;
    return !existingKeys.has(key);
  });

  const duplicatesSkipped = sorted.length - uniqueTransactions.length;

  if (duplicatesSkipped > 0) {
    console.log(`[IMPORT] Skipped ${duplicatesSkipped} duplicate transactions`);
  }

  if (uniqueTransactions.length === 0) {
    console.log('[IMPORT] All transactions were duplicates, nothing new to import');
    return {
      statementId: '',
      transactionCount: 0,
      autoCategorizedCount: 0,
      duplicatesSkipped,
    };
  }

  // Calculate totals (from unique only)
  const totalCredits = uniqueTransactions
    .filter((t) => t.amount > 0)
    .reduce((s, t) => s + t.amount, 0);
  const totalDebits = uniqueTransactions
    .filter((t) => t.amount < 0)
    .reduce((s, t) => s + Math.abs(t.amount), 0);

  // Load bank rules for auto-categorization
  const bankRules = await db.bankRule.findMany({
    where: { companyId, isActive: true },
    orderBy: { priority: 'asc' },
    include: {
      glAccount: { select: { id: true } },
    },
  });
  console.log(`[IMPORT] Loaded ${bankRules.length} bank rules for auto-categorization`);

  // Create statement + transactions in a transaction
  console.log(`[IMPORT] Creating statement and ${uniqueTransactions.length} transactions in DB transaction...`);
  const result = await db.$transaction(async (tx) => {
    const statement = await tx.bankStatement.create({
      data: {
        companyId,
        bankAccountId,
        startDate,
        endDate,
        openingBalance,
        closingBalance: closingBalance || openingBalance + totalCredits - totalDebits,
        totalCredits,
        totalDebits,
        format,
        fileName,
      },
    });
    console.log('[IMPORT] Statement created:', statement.id);

    let autoCategorizedCount = 0;

    for (const txn of uniqueTransactions) {
      const { matchedRuleId, glAccountId } = applyBankRule(
        txn.description,
        txn.amount,
        bankRules
      );

      if (matchedRuleId) autoCategorizedCount++;

      await tx.bankTransaction.create({
        data: {
          statementId: statement.id,
          date: txn.date,
          description: txn.description,
          amount: txn.amount,
          reference: txn.reference || null,
          isReconciled: false,
          glAccountId: glAccountId || null,
          matchedRuleId: matchedRuleId || null,
        },
      });
    }

    // Update bank account balance (only for unique/new transactions)
    await tx.bankAccount.update({
      where: { id: bankAccountId },
      data: {
        balance: {
          increment: totalCredits - totalDebits,
        },
      },
    });

    console.log(`[IMPORT] DB transaction complete. Auto-categorized: ${autoCategorizedCount}`);
    return { statementId: statement.id, autoCategorizedCount };
  });

  return {
    statementId: result.statementId,
    transactionCount: uniqueTransactions.length,
    autoCategorizedCount: result.autoCategorizedCount,
    duplicatesSkipped,
  };
}

// ─── Helper: Apply Bank Rules ─────────────────────────────────────────

function applyBankRule(
  description: string,
  amount: number,
  rules: { id: string; conditionType: string; conditionValue: string; transactionDirection: string; glAccount: { id: string }; isActive: boolean; priority: number }[]
): { matchedRuleId: string | null; glAccountId: string | null } {
  const desc = description.toUpperCase();
  const isCredit = amount > 0;
  const isDebit = amount < 0;

  for (const rule of rules) {
    // Check direction
    if (rule.transactionDirection === 'credit' && !isCredit) continue;
    if (rule.transactionDirection === 'debit' && !isDebit) continue;

    const condValue = rule.conditionValue.toUpperCase();

    switch (rule.conditionType) {
      case 'contains':
        if (desc.includes(condValue)) {
          return {
            matchedRuleId: rule.id,
            glAccountId: rule.glAccount.id,
          };
        }
        break;
      case 'starts_with':
        if (desc.startsWith(condValue)) {
          return {
            matchedRuleId: rule.id,
            glAccountId: rule.glAccount.id,
          };
        }
        break;
      case 'ends_with':
        if (desc.endsWith(condValue)) {
          return {
            matchedRuleId: rule.id,
            glAccountId: rule.glAccount.id,
          };
        }
        break;
      case 'equals':
        if (desc === condValue) {
          return {
            matchedRuleId: rule.id,
            glAccountId: rule.glAccount.id,
          };
        }
        break;
      case 'amount_greater':
        if (Math.abs(amount) > parseFloat(rule.conditionValue)) {
          return {
            matchedRuleId: rule.id,
            glAccountId: rule.glAccount.id,
          };
        }
        break;
      case 'amount_less':
        if (Math.abs(amount) < parseFloat(rule.conditionValue)) {
          return {
            matchedRuleId: rule.id,
            glAccountId: rule.glAccount.id,
          };
        }
        break;
    }
  }

  return { matchedRuleId: null, glAccountId: null };
}

// ─── Helper: Extract bank name from filename ─────────────────────────

function extractBankNameFromFilename(fileName: string): string {
  // Try to extract a bank-like name from the filename
  // e.g., "chase-statement-jan2026.csv" → "Chase"
  // e.g., "bankofamerica_2026.csv" → "Bankofamerica"
  const base = fileName.replace(/\.[^.]+$/, ''); // remove extension
  const parts = base.split(/[-_\s]+/).filter(Boolean);

  // Common bank name keywords to look for
  const bankKeywords = [
    'chase',
    'bank',
    'wells',
    'fargo',
    'citi',
    'america',
    'bofa',
    'hsbc',
    'paypal',
    'venmo',
    'cashapp',
  ];

  const matchingParts = parts.filter((p) =>
    bankKeywords.some((kw) => p.toLowerCase().includes(kw))
  );

  if (matchingParts.length > 0) {
    // Capitalize first letter of each part
    return matchingParts
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join(' ');
  }

  // If no bank keyword found, use the first meaningful part
  if (parts.length > 0 && parts[0].length > 2) {
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
  }

  return 'Imported Account';
}
