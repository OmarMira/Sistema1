import { Prisma } from '@prisma/client';
import { toNum } from '@/lib/utils/decimal';
import { fromCents, sumCents, toCents } from '@/lib/money';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { appendEntryToJournalChain } from '@/lib/journal-chain';

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
      skipRecalculate?: boolean;
    },
  ): Promise<string | null> {
    const { bankTxId, bankTxDate, bankTxAmount, bankTxDescription, bankGlAccountId, counterpartyGlAccountId, companyId, skipRecalculate } = params;

    await assertActiveFiscalPeriod(companyId, bankTxDate, prisma);

    // S3: the amount threshold is a money comparison in cents (identical to the
    // previous `< 0.01` test for every Decimal(18,2) amount) and the amount that
    // reaches the ledger is the exact cent value.
    const amountCents = Math.abs(toCents(bankTxAmount));
    if (amountCents === 0) return null;

    const isDeposit = toCents(bankTxAmount) > 0;
    const debitAccountId = isDeposit ? bankGlAccountId : counterpartyGlAccountId;
    const creditAccountId = isDeposit ? counterpartyGlAccountId : bankGlAccountId;

    const description = `Bank: ${bankTxDescription}`;
    const amount = fromCents(amountCents);

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

    // JH2 shared writer: every bank-created POSTED entry joins the chain
    // inside the caller's transaction. Single append site covers:
    // bank-account opening balance, missing-bank-entries, apply-all rules and
    // transaction reclassification (all funnel through this method).
    await appendEntryToJournalChain(prisma, { companyId, entryId: entry.id });

    // Link the transaction to the journal entry (skip for standalone entries like opening balance)
    if (bankTxId) {
      await prisma.bankTransaction.update({
        where: { id: bankTxId },
        data: { journalEntryId: entry.id },
      });
    }

    // Update balances for both affected GL accounts from their journal lines
    if (!skipRecalculate) {
      await JournalEntryService.recalculateBalance(prisma, debitAccountId);
      await JournalEntryService.recalculateBalance(prisma, creditAccountId);
    }

    return entry.id;
  }

  /**
   * Recalculate a single GL account's balance from its journal lines.
   * For debit-normal accounts: balance = SUM(debit) - SUM(credit)
   * For credit-normal accounts: balance = SUM(credit) - SUM(debit)
   *
   * S3: the aggregate `_sum` values arrive as Prisma.Decimal (aggregate/groupBy
   * results are not coerced by the db.ts result layer), so they are normalized
   * through src/lib/money.ts and the subtraction happens in integer cents. The
   * stored balance is derived from those cents, never from a float `+`/`-`.
   */
  static async recalculateBalance(
    prisma: Prisma.TransactionClient,
    glAccountId: string,
  ): Promise<void> {
    const glAccount = await prisma.glAccount.findUnique({
      where: { id: glAccountId },
      select: { normalBalance: true, companyId: true },
    });
    if (!glAccount) return;

    const totals = await prisma.journalLine.aggregate({
      where: {
        glAccountId,
        entry: {
          status: 'posted',
          // P15: only aggregate lines belonging to the account's own company.
          // Prevents a foreign journal line (e.g. via an invalid cross-tenant
          // rule) from corrupting this account's balance.
          companyId: glAccount.companyId,
        },
      },
      _sum: { debit: true, credit: true },
    });

    const totalDebitCents = toCents(totals._sum.debit ?? 0);
    const totalCreditCents = toCents(totals._sum.credit ?? 0);

    // Debit-normal (asset, expense): balance = debit - credit
    // Credit-normal (liability, equity, revenue): balance = credit - debit
    const balanceCents =
      glAccount.normalBalance === 'debit'
        ? sumCents(totalDebitCents, -totalCreditCents)
        : sumCents(totalCreditCents, -totalDebitCents);

    await prisma.glAccount.update({
      where: { id: glAccountId },
      data: { balance: fromCents(balanceCents) },
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
    const affectedGlAccountIds = new Set<string>();
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
        skipRecalculate: true,
      });
      if (result) {
        created++;
        affectedGlAccountIds.add(bankGlAccountId);
        affectedGlAccountIds.add(tx.glAccountId);
      }
    }
    for (const glAccountId of affectedGlAccountIds) {
      await JournalEntryService.recalculateBalance(prisma, glAccountId);
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
    // Find the Equity parent account
    const equityParent = await prisma.glAccount.findFirst({
      where: { companyId, accountType: 'equity', parentId: null, isActive: true },
      select: { id: true },
    });

    // Atomic upsert using unique constraint @@unique([companyId, code])
    // Prevents TOCTOU race condition on concurrent bank connection creation
    const result = await prisma.glAccount.upsert({
      where: {
        companyId_code: { companyId, code: '3050' },
      },
      create: {
        companyId,
        code: '3050',
        name: 'Opening Balance Equity',
        accountType: 'equity',
        normalBalance: 'credit',
        parentId: equityParent?.id || null,
        isSystem: true,
        isActive: true,
      },
      update: {}, // no-op — just ensure the row exists
    });
    return result.id;
  }
}
