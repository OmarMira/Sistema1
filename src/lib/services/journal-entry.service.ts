import { Prisma } from '@prisma/client';
import { toNum } from '@/lib/utils/decimal';

/**
 * Creates journal entries from bank transactions.
 *
 * Each matched bank transaction generates a double-entry journal entry:
 *   - Deposit (amount > 0):   Dr Bank GL / Cr Counterparty GL
 *   - Withdrawal (amount < 0): Cr Bank GL / Dr Counterparty GL
 */
export class JournalEntryService {
  /**
   * Create a journal entry for a single bank transaction.
   * Skips if the transaction already has a journal entry.
   *
   * @returns The journal entry ID, or null if skipped.
   */
  static async createFromBankTransaction(
    prisma: Prisma.TransactionClient,
    params: {
      bankTxId: string;
      bankTxDate: Date;
      bankTxAmount: number;
      bankTxDescription: string;
      bankGlAccountId: string;
      counterpartyGlAccountId: string;
      companyId: string;
    },
  ): Promise<string | null> {
    const { bankTxId, bankTxDate, bankTxAmount, bankTxDescription, bankGlAccountId, counterpartyGlAccountId, companyId } = params;

    const amount = Math.abs(bankTxAmount);
    if (amount < 0.01) return null;

    const isDeposit = bankTxAmount > 0;
    const debitAccountId = isDeposit ? bankGlAccountId : counterpartyGlAccountId;
    const creditAccountId = isDeposit ? counterpartyGlAccountId : bankGlAccountId;

    const description = `Bank: ${bankTxDescription}`;

    const entry = await prisma.journalEntry.create({
      data: {
        companyId,
        date: bankTxDate,
        description,
        status: 'posted',
        lines: {
          create: [
            { glAccountId: debitAccountId, description, debit: amount, credit: 0 },
            { glAccountId: creditAccountId, description, debit: 0, credit: amount },
          ],
        },
      },
    });

    // Link the transaction to the journal entry (skip for standalone entries like opening balance)
    if (bankTxId) {
      await prisma.bankTransaction.update({
        where: { id: bankTxId },
        data: { journalEntryId: entry.id },
      });
    }

    // Update balances for both affected GL accounts from their journal lines
    await JournalEntryService.recalculateBalance(prisma, debitAccountId);
    await JournalEntryService.recalculateBalance(prisma, creditAccountId);

    return entry.id;
  }

  /**
   * Recalculate a single GL account's balance from its journal lines.
   * For debit-normal accounts: balance = SUM(debit) - SUM(credit)
   * For credit-normal accounts: balance = SUM(credit) - SUM(debit)
   */
  static async recalculateBalance(
    prisma: Prisma.TransactionClient,
    glAccountId: string,
  ): Promise<void> {
    const totals = await prisma.journalLine.aggregate({
      where: {
        glAccountId,
        entry: { status: 'posted' },
      },
      _sum: { debit: true, credit: true },
    });

    const totalDebit = Number(totals._sum.debit || 0);
    const totalCredit = Number(totals._sum.credit || 0);

    const glAccount = await prisma.glAccount.findUnique({
      where: { id: glAccountId },
      select: { normalBalance: true },
    });
    if (!glAccount) return;

    // Debit-normal (asset, expense): balance = debit - credit
    // Credit-normal (liability, equity, revenue): balance = credit - debit
    const balance =
      glAccount.normalBalance === 'debit'
        ? totalDebit - totalCredit
        : totalCredit - totalDebit;

    await prisma.glAccount.update({
      where: { id: glAccountId },
      data: { balance },
    });
  }

  /**
   * Create journal entries for all bank transactions in a list that have
   * a glAccountId but no journalEntryId yet.
   *
   * @param bankGlAccountId The bank account's linked GL account ID.
   * @returns Number of journal entries created.
   */
  static async createMissingForBank(
    prisma: Prisma.TransactionClient,
    companyId: string,
    bankGlAccountId: string,
  ): Promise<number> {
    const pending = await prisma.bankTransaction.findMany({
      where: {
        glAccountId: { not: null },
        journalEntryId: null,
        statement: { companyId },
      },
      take: 500,
    });

    let created = 0;
    for (const tx of pending) {
      if (!tx.glAccountId) continue;
      const result = await JournalEntryService.createFromBankTransaction(prisma, {
        bankTxId: tx.id,
        bankTxDate: tx.date,
        bankTxAmount: toNum(tx.amount),
        bankTxDescription: tx.description,
        bankGlAccountId,
        counterpartyGlAccountId: tx.glAccountId,
        companyId,
      });
      if (result) created++;
    }
    return created;
  }

  /**
   * Find or create the Opening Balance Equity account for a company.
   * Uses the chart-of-accounts seed data — never hardcodes an ID.
   */
  static async ensureOpeningBalanceEquity(
    prisma: Prisma.TransactionClient,
    companyId: string,
  ): Promise<string> {
    const existing = await prisma.glAccount.findFirst({
      where: { companyId, name: 'Opening Balance Equity', isActive: true },
      select: { id: true },
    });
    if (existing) return existing.id;

    // Create it under the Equity parent account
    const equityParent = await prisma.glAccount.findFirst({
      where: { companyId, accountType: 'equity', parentId: null, isActive: true },
      select: { id: true },
    });

    const created = await prisma.glAccount.create({
      data: {
        companyId,
        code: '3050',
        name: 'Opening Balance Equity',
        accountType: 'equity',
        normalBalance: 'credit',
        parentId: equityParent?.id || null,
        isSystem: true,
        isActive: true,
      },
    });
    return created.id;
  }
}
