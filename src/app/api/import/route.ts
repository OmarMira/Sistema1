import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';
import { parseCSV } from '@/lib/csv-parser';
import { parseOFX } from '@/lib/ofx-parser';

// ─── POST /api/import ─────────────────────────────────────────────────
// Accepts multipart/form-data with a file field.
// Supports CSV, OFX, QFX formats. PDF returns a placeholder message.
export async function POST(request: NextRequest) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const companyId = formData.get('companyId') as string | null;
    const bankAccountId = formData.get('bankAccountId') as string | null;

    if (!file) {
      return NextResponse.json(
        { error: 'No file uploaded. Provide a "file" field.' },
        { status: 400 }
      );
    }

    if (!companyId) {
      return NextResponse.json(
        { error: 'companyId is required' },
        { status: 400 }
      );
    }

    // Verify membership
    const membership = await db.companyMember.findUnique({
      where: { userId_companyId: { userId, companyId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Validate file size (max 10 MB)
    const MAX_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: 'File too large. Maximum size is 10 MB.' },
        { status: 400 }
      );
    }

    const fileName = file.name;
    const extension = fileName.split('.').pop()?.toLowerCase() || '';
    const buffer = Buffer.from(await file.arrayBuffer());
    const content = buffer.toString('utf-8');

    // ─── PDF: not fully implemented ──────────────────────────────────
    if (extension === 'pdf') {
      return NextResponse.json(
        {
          error:
            'PDF import requires OCR processing and is not yet fully implemented. Please export your bank statement as CSV or OFX format.',
          supportedFormats: ['csv', 'ofx', 'qfx'],
        },
        { status: 400 }
      );
    }

    // ─── CSV parsing ─────────────────────────────────────────────────
    if (extension === 'csv' || extension === 'tsv' || extension === 'txt') {
      let transactions: Awaited<ReturnType<typeof parseCSV>>;
      let bankName = '';

      try {
        transactions = parseCSV(content);
        // Try to extract bank name from first description or filename
        bankName = extractBankNameFromFilename(fileName);
      } catch (parseError) {
        const msg =
          parseError instanceof Error
            ? parseError.message
            : 'Failed to parse CSV file';
        return NextResponse.json({ error: msg }, { status: 400 });
      }

      // Find or create bank account
      const bankAccount = await findOrCreateBankAccount(
        companyId,
        bankAccountId,
        bankName,
        transactions
      );
      const newAccountCreated = !bankAccountId;

      // Create statement + transactions
      const result = await importTransactions(
        companyId,
        bankAccount.id,
        transactions,
        'csv',
        fileName
      );

      return NextResponse.json({
        statementId: result.statementId,
        transactionCount: result.transactionCount,
        autoCategorizedCount: result.autoCategorizedCount,
        duplicatesSkipped: result.duplicatesSkipped,
        newAccountCreated,
        bankAccountName: bankAccount.accountName,
      });
    }

    // ─── OFX/QFX parsing ─────────────────────────────────────────────
    if (extension === 'ofx' || extension === 'qfx') {
      let parsed: Awaited<ReturnType<typeof parseOFX>>;

      try {
        parsed = parseOFX(content);
      } catch (parseError) {
        const msg =
          parseError instanceof Error
            ? parseError.message
            : 'Failed to parse OFX/QFX file';
        return NextResponse.json({ error: msg }, { status: 400 });
      }

      const bankName = parsed.bankName;

      // Find or create bank account
      const bankAccount = await findOrCreateBankAccount(
        companyId,
        bankAccountId,
        bankName,
        parsed.transactions,
        parsed.accountNumber
      );
      const newAccountCreated = !bankAccountId;

      // Create statement + transactions
      const result = await importTransactions(
        companyId,
        bankAccount.id,
        parsed.transactions,
        extension as 'ofx' | 'qfx',
        fileName,
        {
          startDate: parsed.startDate,
          endDate: parsed.endDate,
          openingBalance: parsed.openingBalance,
          closingBalance: parsed.closingBalance,
        }
      );

      return NextResponse.json({
        statementId: result.statementId,
        transactionCount: result.transactionCount,
        autoCategorizedCount: result.autoCategorizedCount,
        duplicatesSkipped: result.duplicatesSkipped,
        newAccountCreated,
        bankAccountName: bankAccount.accountName,
      });
    }

    // ─── Unsupported format ──────────────────────────────────────────
    return NextResponse.json(
      {
        error: `Unsupported file format: .${extension}. Supported formats: .csv, .ofx, .qfx`,
      },
      { status: 400 }
    );
  } catch (error) {
    console.error('[IMPORT ERROR]', error);
    return NextResponse.json(
      { error: 'Failed to import bank statement' },
      { status: 500 }
    );
  }
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
    const existing = await db.bankAccount.findFirst({
      where: { companyId, bankName, isActive: true },
    });
    if (existing) return existing;
  }

  // Try to match by account number
  if (accountNumber) {
    const existing = await db.bankAccount.findFirst({
      where: { companyId, accountNo: accountNumber, isActive: true },
    });
    if (existing) return existing;
  }

  // Create new account — find the default cash GL account
  const cashAccount = await db.glAccount.findFirst({
    where: { companyId, code: '1010', isActive: true },
  });

  if (!cashAccount) {
    // Fallback to any asset account
    const anyAsset = await db.glAccount.findFirst({
      where: { companyId, accountType: 'asset', isActive: true },
    });
    if (!anyAsset) {
      throw new Error(
        'No asset-type GL account found. Please create one before importing statements.'
      );
    }
  }

  const glAccount = cashAccount! || (await db.glAccount.findFirst({
    where: { companyId, accountType: 'asset', isActive: true },
  }))!;

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
    throw new Error('No transactions to import');
  }

  // Sort by date ascending
  const sorted = [...transactions].sort(
    (a, b) => a.date.getTime() - b.date.getTime()
  );

  const startDate = balanceInfo?.startDate || sorted[0].date;
  const endDate = balanceInfo?.endDate || sorted[sorted.length - 1].date;
  const openingBalance = balanceInfo?.openingBalance ?? 0;
  const closingBalance = balanceInfo?.closingBalance ?? 0;

  // ── Duplicate detection ──
  // Get existing transactions for this bank account (from all its statements)
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

  if (uniqueTransactions.length === 0) {
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

  // Create statement + transactions in a transaction
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
  rules: { id: string; conditionType: string; conditionValue: string; transactionDirection: string; glAccountId: string; isActive: boolean; priority: number }[]
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
            glAccountId: rule.glAccountId.id,
          };
        }
        break;
      case 'starts_with':
        if (desc.startsWith(condValue)) {
          return {
            matchedRuleId: rule.id,
            glAccountId: rule.glAccountId.id,
          };
        }
        break;
      case 'ends_with':
        if (desc.endsWith(condValue)) {
          return {
            matchedRuleId: rule.id,
            glAccountId: rule.glAccountId.id,
          };
        }
        break;
      case 'equals':
        if (desc === condValue) {
          return {
            matchedRuleId: rule.id,
            glAccountId: rule.glAccountId.id,
          };
        }
        break;
      case 'amount_greater':
        if (Math.abs(amount) > parseFloat(rule.conditionValue)) {
          return {
            matchedRuleId: rule.id,
            glAccountId: rule.glAccountId.id,
          };
        }
        break;
      case 'amount_less':
        if (Math.abs(amount) < parseFloat(rule.conditionValue)) {
          return {
            matchedRuleId: rule.id,
            glAccountId: rule.glAccountId.id,
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
