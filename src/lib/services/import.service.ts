import { Prisma } from '@prisma/client';
import { logger } from '@/lib/logger';
import { db } from '@/lib/db';
import { createAuditLogWithRetry } from '@/lib/audit';
import { parseCSV } from '@/lib/csv-parser';
import { parseOFX } from '@/lib/ofx-parser';
import { parsePDFAsync } from '@/lib/pdf-processor';
import {
  validateAccountHolder,
  isStrictModeEnabled,
} from '@/lib/validation/account-holder-validator';
import { JournalEntryService } from '@/lib/services/journal-entry.service';
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  BankAccountRequiredError,
  MathMismatchError,
} from '@/lib/api-error';
import { trackPDFParseDuration } from '@/lib/metrics';
import { withTiming } from '@/lib/timing';
import { generateImportHash } from '@/lib/accounting/import-hash';
import { toStatementMonth, toDateString } from '@/lib/accounting/date-window';
import type { ParsedTransaction, StatementBalanceInfo, RuleCondition } from '@/lib/types/shared';
import {
  findMatchingRule,
  type Transaction,
  type MatchingRule,
} from '@/lib/services/rule-matching-engine';

export interface ImportResult {
  statementId: string;
  transactionCount: number;
  autoCategorizedCount: number;
  duplicatesSkipped: number;
  newAccountCreated: boolean;
  bankAccountName: string;
}

export class ImportService {
  static async importFile({
    companyId,
    bankAccountId,
    fileName,
    extension,
    buffer,
    content,
    userId,
    bypassHolderValidation = false,
  }: {
    companyId: string;
    bankAccountId: string | null;
    fileName: string;
    extension: string;
    buffer: Buffer;
    content: string;
    userId?: string;
    bypassHolderValidation?: boolean;
  }): Promise<ImportResult> {
    // ─── PDF parsing ──────────────────────────────────────────────────
    if (extension === 'pdf') {
      let transactions: ParsedTransaction[] = [];
      let bankName = '';
      let accountNo: string | undefined;
      let openingBalance: number | undefined;
      let closingBalance: number | undefined;
      let startDate: Date | undefined;
      let endDate: Date | undefined;
      let accountHolder: string | undefined;

      try {
        const pdfStart = performance.now();
        logger.info('Starting PDF parse', { fileName });
        const parsed = await parsePDFAsync(buffer, { fileName, companyId, userId });
        trackPDFParseDuration(fileName, performance.now() - pdfStart);
        logger.info('PDF parsed', {
          fileName,
          durationSec: Number(((performance.now() - pdfStart) / 1000).toFixed(1)),
          transactionCount: parsed.transactions.length,
        });

        if (parsed.mathValid === false) {
          logger.warn('Math mismatch — saving with warning for manual review', {
            mismatch: parsed.mismatch,
          });
        }

        transactions = parsed.transactions;
        bankName = parsed.bankName || this.extractBankNameFromFilename(fileName);
        accountNo = parsed.accountNo;
        openingBalance = parsed.openingBalance;
        closingBalance = parsed.closingBalance;
        startDate = parsed.startDate;
        endDate = parsed.endDate;
        accountHolder = parsed.accountHolder;
      } catch (parseError) {
        if (parseError instanceof MathMismatchError) {
          throw parseError;
        }
        throw new ValidationError(
          parseError instanceof Error ? parseError.message : 'Error al parsear el archivo PDF',
        );
      }

      // Pre-validation of account holder name
      const company = await db.company.findUnique({
        where: { id: companyId },
        select: { legalName: true, entityType: true },
      });

      let holderDecision: 'auto_approved' | 'user_approved' | 'rejected' = 'auto_approved';
      let similarityScore = 1.0;

      if (bypassHolderValidation) {
        logger.info('Account holder validation skipped (bypass flag)', {
          extractedHolder: accountHolder,
          legalName: company?.legalName,
        });
      } else if (company && accountHolder) {
        const entityType = (company.entityType ?? 'BUSINESS') as 'INDIVIDUAL' | 'BUSINESS';
        const validation = validateAccountHolder(accountHolder, company.legalName, entityType);
        similarityScore = validation.score;

        if (validation.requiresApproval) {
          logger.warn('Account holder mismatch — saving with warning', {
            extractedHolder: accountHolder,
            legalName: company.legalName,
            entityType,
            score: validation.score,
            method: validation.method,
          });
          holderDecision = validation.score > 0.3 ? 'user_approved' : 'rejected';
          if (holderDecision === 'rejected') {
            throw new ValidationError(
              `EL_TITULAR_NO_COINCIDE:${accountHolder}:${company.legalName}:${Math.round(validation.score * 100)}`,
            );
          }
        }
      }

      // Guard: validate before touching the DB — no phantom accounts on failed imports
      if (transactions.length === 0) {
        throw new ValidationError('No hay transacciones para importar');
      }

      logger.info('Looking up bank account', { bankName, accountNo: accountNo || null });
      const { account: bankAccount, newAccountCreated: pdfNewAccount } =
        await this.findOrCreateBankAccount(
          companyId,
          bankAccountId,
          bankName,
          transactions,
          accountNo,
          openingBalance || 0,
        );
      logger.info('Bank account resolved', {
        accountName: bankAccount.accountName,
        accountId: bankAccount.id,
      });

      const balanceInfo: Partial<StatementBalanceInfo> = {};
      if (startDate) balanceInfo.startDate = startDate;
      if (endDate) balanceInfo.endDate = endDate;
      if (openingBalance !== undefined) balanceInfo.openingBalance = openingBalance;
      if (closingBalance !== undefined) balanceInfo.closingBalance = closingBalance;

      logger.info('Saving transactions to database', { count: transactions.length });
      const result = await this.importTransactions(
        companyId,
        bankAccount.id,
        bankAccount.glAccountId,
        transactions,
        'pdf',
        fileName,
        balanceInfo,
      );
      logger.info('Import done', {
        saved: result.transactionCount,
        duplicatesSkipped: result.duplicatesSkipped,
      });

      // Create Audit Log for holder validation
      if (userId && accountHolder && company) {
        await createAuditLogWithRetry({
          companyId,
          userId,
          action:
            holderDecision === 'auto_approved'
              ? 'HOLDER_VALIDATION_AUTO_APPROVED'
              : 'HOLDER_VALIDATION_USER_APPROVED',
          entity: 'BankStatement',
          entityId: result.statementId,
          details: JSON.stringify({
            fileName,
            companyLegalName: company.legalName,
            extractedHolderName: accountHolder,
            similarityScore: Math.round(similarityScore * 100) / 100,
            decision: holderDecision,
          }),
        }).catch(() => {});
      }

      return {
        ...result,
        newAccountCreated: pdfNewAccount,
        bankAccountName: bankAccount.accountName,
      };
    }

    // ─── CSV parsing ─────────────────────────────────────────────────
    if (extension === 'csv' || extension === 'tsv' || extension === 'txt') {
      let transactions: ParsedTransaction[];
      let bankName = '';

      try {
        transactions = parseCSV(content);
        bankName = this.extractBankNameFromFilename(fileName);
      } catch (parseError) {
        throw new ValidationError(
          parseError instanceof Error ? parseError.message : 'Error al parsear el archivo CSV',
        );
      }

      const { account: bankAccount, newAccountCreated: csvNewAccount } =
        await this.findOrCreateBankAccount(companyId, bankAccountId, bankName, transactions);

      const result = await this.importTransactions(
        companyId,
        bankAccount.id,
        bankAccount.glAccountId,
        transactions,
        'csv',
        fileName,
      );

      return {
        ...result,
        newAccountCreated: csvNewAccount,
        bankAccountName: bankAccount.accountName,
      };
    }

    // ─── OFX/QFX parsing ─────────────────────────────────────────────
    if (extension === 'ofx' || extension === 'qfx') {
      let parsed: { bankName: string; transactions: ParsedTransaction[]; accountNumber?: string; openingBalance?: number; closingBalance?: number; startDate?: Date; endDate?: Date };

      try {
        parsed = parseOFX(content);
      } catch (parseError) {
        throw new ValidationError(
          parseError instanceof Error ? parseError.message : 'Error al parsear el archivo OFX/QFX',
        );
      }

      const bankName = parsed.bankName;

      const { account: bankAccount, newAccountCreated: ofxNewAccount } =
        await this.findOrCreateBankAccount(
          companyId,
          bankAccountId,
          bankName,
          parsed.transactions,
          parsed.accountNumber,
          parsed.openingBalance || 0,
        );

      const result = await this.importTransactions(
        companyId,
        bankAccount.id,
        bankAccount.glAccountId,
        parsed.transactions,
        extension as 'ofx' | 'qfx',
        fileName,
        {
          startDate: parsed.startDate,
          endDate: parsed.endDate,
          openingBalance: parsed.openingBalance,
          closingBalance: parsed.closingBalance,
        },
      );

      return {
        ...result,
        newAccountCreated: ofxNewAccount,
        bankAccountName: bankAccount.accountName,
      };
    }

    throw new ValidationError(
      `Formato de archivo no soportado: .${extension}. Los formatos soportados son: .csv, .ofx, .qfx, .pdf`,
    );
  }

  private static async findOrCreateBankAccount(
    companyId: string,
    bankAccountId: string | null,
    bankName: string,
    transactions: { description: string; amount: number }[],
    accountNumber?: string,
    openingBalance: number = 0,
    currency: string = 'USD',
  ): Promise<{ account: { id: string; accountName: string; accountNo?: string | null; bankName: string; companyId: string; glAccountId: string }; newAccountCreated: boolean }> {
    if (bankAccountId) {
      const account = await db.bankAccount.findFirst({
        where: { id: bankAccountId, companyId },
      });
      if (!account) {
        throw new NotFoundError('La cuenta bancaria especificada no existe');
      }
      return { account, newAccountCreated: false };
    }

    if (bankName) {
      const existing = await db.bankAccount.findFirst({
        where: { companyId, bankName, isActive: true },
      });
      if (existing) return { account: existing, newAccountCreated: false };
    }

    if (accountNumber) {
      const existing = await db.bankAccount.findFirst({
        where: { companyId, accountNo: accountNumber, isActive: true },
      });
      if (existing) return { account: existing, newAccountCreated: false };
    }

    // Si no existe, lanzamos un error que pre-rellenará el modal de creación
    throw new BankAccountRequiredError({
      bankName: bankName || 'Cuenta Bancaria Importada',
      accountNo: accountNumber || null,
      openingBalance,
      currency,
    });
  }

  private static async importTransactions(
    companyId: string,
    bankAccountId: string,
    bankGlAccountId: string,
    transactions: { date: Date; description: string; amount: number; reference?: string }[],
    format: string,
    fileName: string,
    balanceInfo?: Partial<StatementBalanceInfo>,
  ) {
    if (transactions.length === 0) {
      throw new ValidationError('No hay transacciones para importar');
    }

    const sorted = [...transactions].sort((a, b) => a.date.getTime() - b.date.getTime());

    const startDate = balanceInfo?.startDate || sorted[0].date;
    const endDate = balanceInfo?.endDate || sorted[sorted.length - 1].date;
    const openingBalance = balanceInfo?.openingBalance ?? 0;
    const closingBalance = balanceInfo?.closingBalance ?? 0;

    const bankAccount = await db.bankAccount.findFirst({
      where: { id: bankAccountId },
      select: { accountNo: true },
    });
    const accountNumber = bankAccount?.accountNo || 'unknown';
    const statementMonth = toStatementMonth(startDate);

    // ─── Deduplicación por importHash (SHA-256) ───────────────────────
    // Detecta reimportaciones del mismo extracto sin cargar todo en memoria.
    const hashList = sorted.map((txn) =>
      generateImportHash({
        companyId,
        accountNumber,
        statementMonth,
        txDate: toDateString(txn.date),
        amount: txn.amount,
        description: txn.description,
      }),
    );

    const existingHashes = await db.bankTransaction.findMany({
      where: { importHash: { in: hashList } },
      select: { importHash: true },
    });
    const existingHashSet = new Set(existingHashes.map((t) => t.importHash));

    const uniqueTransactions = sorted.filter((_txn, idx) => !existingHashSet.has(hashList[idx]));
    const uniqueHashes = hashList.filter((_, idx) => !existingHashSet.has(hashList[idx]));

    const duplicatesSkipped = sorted.length - uniqueTransactions.length;

    if (uniqueTransactions.length === 0) {
      return {
        statementId: '',
        transactionCount: 0,
        autoCategorizedCount: 0,
        duplicatesSkipped,
      };
    }

    const totalCredits = uniqueTransactions
      .filter((t) => t.amount > 0)
      .reduce((s, t) => s.add(new Prisma.Decimal(t.amount)), new Prisma.Decimal(0))
      .toNumber();
    const totalDebits = uniqueTransactions
      .filter((t) => t.amount < 0)
      .reduce((s, t) => s.add(new Prisma.Decimal(t.amount).abs()), new Prisma.Decimal(0))
      .toNumber();

    const bankRules = await db.bankRule.findMany({
      where: { companyId, isActive: true },
      orderBy: { priority: 'asc' },
      include: {
        glAccount: { select: { id: true } },
        debitGlAccount: { select: { id: true } },
        creditGlAccount: { select: { id: true } },
      },
    });

    const result = await db.$transaction(async (tx) => {
      // Duplicate check inside TX (atomic — prevents race conditions)
      const existingStatement = await tx.bankStatement.findFirst({
        where: { bankAccountId, startDate, endDate },
      });
      if (existingStatement) {
        throw new ConflictError(
          `Ya existe un extracto para el período ${startDate.toISOString().split('T')[0]} – ${endDate.toISOString().split('T')[0]}. Elimine el anterior o use un período diferente.`,
        );
      }

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
      const transactionsToInsert: Prisma.BankTransactionCreateManyInput[] = [];

      for (let idx = 0; idx < uniqueTransactions.length; idx++) {
        const txn = uniqueTransactions[idx];
        const { matchedRuleId, glAccountId } = await findMatchingRule(
          { description: txn.description, amount: txn.amount } as Transaction,
          bankRules as unknown as MatchingRule[],
          companyId,
        );

        if (matchedRuleId) autoCategorizedCount++;

        transactionsToInsert.push({
          statementId: statement.id,
          date: txn.date,
          description: txn.description,
          amount: txn.amount,
          reference: txn.reference || null,
          isReconciled: false,
          glAccountId: glAccountId || null,
          matchedRuleId: matchedRuleId || null,
          importHash: uniqueHashes[idx], // SHA-256 para idempotencia
        });
      }

      await tx.bankTransaction.createMany({
        data: transactionsToInsert,
      });

      // Create journal entries for transactions with auto-assigned GL accounts
      const createdTxs = await tx.bankTransaction.findMany({
        where: { statementId: statement.id, glAccountId: { not: null }, journalEntryId: null },
        select: { id: true, date: true, amount: true, description: true, glAccountId: true },
      });
      for (const bt of createdTxs) {
         
        await JournalEntryService.createFromBankTransaction(tx as any, {
          bankTxId: bt.id,
          bankTxDate: bt.date,
          bankTxAmount: Number(bt.amount),
          bankTxDescription: bt.description,
          bankGlAccountId,
          counterpartyGlAccountId: bt.glAccountId!,
          companyId,
        });
      }

       
      await ImportService.recalculateBalances(tx as any, bankAccountId);

      return { statementId: statement.id, autoCategorizedCount };
    });

    return {
      statementId: result.statementId,
      transactionCount: uniqueTransactions.length,
      autoCategorizedCount: result.autoCategorizedCount,
      duplicatesSkipped,
    };
  }

  private static extractBankNameFromFilename(fileName: string): string {
    const base = fileName.replace(/\.[^.]+$/, '');
    const parts = base.split(/[-_\s]+/).filter(Boolean);

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

  public static async recalculateBalances(tx: Prisma.TransactionClient, bankAccountId: string) {
    const statements = await tx.bankStatement.findMany({
      where: { bankAccountId },
      orderBy: [{ startDate: 'asc' }, { endDate: 'asc' }],
    });

    if (statements.length === 0) return;

    const oldest = statements[0];
    const newest = statements[statements.length - 1];

    await tx.bankAccount.update({
      where: { id: bankAccountId },
      data: {
        initialBalance: oldest.openingBalance,
        balance: newest.closingBalance,
      },
    });
  }
}
