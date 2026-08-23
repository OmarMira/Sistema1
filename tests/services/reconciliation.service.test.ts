import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ReconciliationService } from '@/lib/services/reconciliation.service';
import { JournalEntryService } from '@/lib/services/journal-entry.service';
import { ValidationError } from '@/lib/api-error';
import {
  createTestUser,
  createTestCompany,
  createTestCompanyMember,
  createTestBankAccount,
  createTestGlAccount,
  createTestBankStatement,
  createTestBankTransaction,
  clearDatabase,
} from '../helpers/factories';
import { db } from '@/lib/db';

async function createFiscalPeriod(companyId: string) {
  await db.fiscalPeriod.create({
    data: {
      companyId,
      name: 'March 2025',
      startDate: new Date('2025-03-01T00:00:00.000Z'),
      endDate: new Date('2025-03-31T23:59:59.999Z'),
      isLocked: false,
    },
  });
}

describe('ReconciliationService split validation', () => {
  it('creates balanced entry when splits sum matches transaction amount', async () => {
    const company = await createTestCompany();
    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    await createFiscalPeriod(company.id);

    const bankTx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-15',
      amount: 500.0,
      description: 'Ingreso dividido',
    });

    const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Sales', accountType: 'revenue', normalBalance: 'credit' });
    const taxGl = await createTestGlAccount({ companyId: company.id, code: '2010', name: 'Tax Payable', accountType: 'liability', normalBalance: 'credit' });

    const result = await ReconciliationService.reconcile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      transactions: [{
        id: bankTx.id,
        glAccountId: revenueGl.id,
        splits: [
          { glAccountId: revenueGl.id, amount: 400, description: 'Revenue portion' },
          { glAccountId: taxGl.id, amount: 100, description: 'Tax portion' },
        ],
      }],
      createJournalEntries: true,
    });

    expect(result.reconciledCount).toBe(1);
    expect(result.journalEntriesCreated).toBe(1);

    const entries = await db.journalEntry.findMany({
      where: { companyId: company.id },
      include: { lines: true },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].lines).toHaveLength(3); // bank + 2 splits
    // Entry must be balanced
    const totalDebit = entries[0].lines.reduce((s, l) => s + l.debit, 0);
    const totalCredit = entries[0].lines.reduce((s, l) => s + l.credit, 0);
    expect(Math.abs(totalDebit - totalCredit)).toBeLessThan(0.01);
  });

  it('throws ValidationError when split sum does not match transaction amount', async () => {
    const company = await createTestCompany();
    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    await createFiscalPeriod(company.id);

    const bankTx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-15',
      amount: 500.0,
      description: 'Split descuadrado',
    });

    const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Sales', accountType: 'revenue', normalBalance: 'credit' });

    await expect(ReconciliationService.reconcile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      transactions: [{
        id: bankTx.id,
        glAccountId: revenueGl.id,
        splits: [
          { glAccountId: revenueGl.id, amount: 300, description: 'Suma incorrecta' },
        ],
      }],
      createJournalEntries: true,
    })).rejects.toThrow('Split amounts sum to 300.00 but transaction amount is 500.00');
  });

  it('throws ValidationError when split has zero amount', async () => {
    const company = await createTestCompany();
    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    await createFiscalPeriod(company.id);

    const bankTx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-15',
      amount: 500.0,
      description: 'Split con cero',
    });

    const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Sales', accountType: 'revenue', normalBalance: 'credit' });

    await expect(ReconciliationService.reconcile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      transactions: [{
        id: bankTx.id,
        glAccountId: revenueGl.id,
        splits: [
          { glAccountId: revenueGl.id, amount: 500, description: 'OK' },
          { glAccountId: revenueGl.id, amount: 0, description: 'Zero' },
        ],
      }],
      createJournalEntries: true,
    })).rejects.toThrow('Split amounts must be greater than zero');
  });
});

describe('ReconciliationService', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('debe conciliar una transacción bancaria marcándola y actualizando la cuenta GL asignada', async () => {
    const company = await createTestCompany();
    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    await createFiscalPeriod(company.id);

    const bankTx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-03',
      amount: 1100.0,
      description: 'Zelle payment from RODRIGO OCHOA',
      reference: 'T0YKY6RCL',
    });

    const incomeGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Sales Revenue', accountType: 'revenue', normalBalance: 'credit' });

    const result = await ReconciliationService.reconcile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      transactions: [
        {
          id: bankTx.id,
          glAccountId: incomeGl.id,
          splits: null,
        },
      ],
      createJournalEntries: false,
    });

    expect(result.reconciledCount).toBe(1);

    const updatedTx = await db.bankTransaction.findUnique({
      where: { id: bankTx.id },
    });
    expect(updatedTx?.isReconciled).toBe(true);
    expect(updatedTx?.glAccountId).toBe(incomeGl.id);
  });

  it('debe crear un asiento contable automático cuadrado al conciliar si se solicita', async () => {
    const company = await createTestCompany();
    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);
    await createFiscalPeriod(company.id);

    const bankTx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-03',
      amount: 1100.0, // Depósito positivo
      description: 'Zelle payment from RODRIGO OCHOA',
      reference: 'T0YKY6RCL',
    });

    const incomeGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Sales Revenue', accountType: 'revenue', normalBalance: 'credit' });

    const result = await ReconciliationService.reconcile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      transactions: [
        {
          id: bankTx.id,
          glAccountId: incomeGl.id,
          splits: null,
        },
      ],
      createJournalEntries: true,
    });

    expect(result.reconciledCount).toBe(1);
    expect(result.journalEntriesCreated).toBe(1);

    // Verificar que se creó el asiento en contabilidad
    const journalEntries = await db.journalEntry.findMany({
      where: { companyId: company.id },
      include: { lines: true },
    });
    expect(journalEntries).toHaveLength(1);
    expect(journalEntries[0].lines).toHaveLength(2);

    const debitLine = journalEntries[0].lines.find((l) => l.debit === 1100.0);
    const creditLine = journalEntries[0].lines.find((l) => l.credit === 1100.0);

    expect(debitLine?.glAccountId).toBe(cashGl.id); // Débito a Caja
    expect(creditLine?.glAccountId).toBe(incomeGl.id); // Crédito a Ingresos
  });

  describe('Semantic validation → pending_review', () => {
    it('debe marcar status pending_review si hay warning semántico (débito a patrimonio sin keywords)', async () => {
      const company = await createTestCompany();
      const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
      const bankAccount = await createTestBankAccount(company.id, cashGl.id);
      const statement = await createTestBankStatement(company.id, bankAccount.id);
      await createFiscalPeriod(company.id);

      // Pago (amount < 0) → desde banco, debit del destino
      const bankTx = await createTestBankTransaction(company.id, statement.id, {
        date: '2025-03-15',
        amount: -100,
        description: 'Compra de muebles de oficina',
      });

      // Cuenta Clase 3 (Patrimonio) sin keywords de retiro → warning
      const equityGl = await createTestGlAccount({
        companyId: company.id,
        code: '3010',
        name: 'Owner Equity',
        accountType: 'equity',
        normalBalance: 'credit',
      });

      const result = await ReconciliationService.reconcile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        transactions: [{ id: bankTx.id, glAccountId: equityGl.id }],
        createJournalEntries: true,
      });

      expect(result.reconciledCount).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Advertencia semántica: La cuenta de patrimonio registra un débito');

      const updatedTx = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
      expect(updatedTx?.status).toBe('pending_review');

      const entries = await db.journalEntry.findMany({
        where: { companyId: company.id },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe('pending_review');
    });

    it('debe dejar status posted si NO hay warning semántico (débito a gastos es normal)', async () => {
      const company = await createTestCompany();
      const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
      const bankAccount = await createTestBankAccount(company.id, cashGl.id);
      const statement = await createTestBankStatement(company.id, bankAccount.id);
      await createFiscalPeriod(company.id);

      // Pago (amount < 0) → al ser gasto normal, débito a 6010 es normal
      const bankTx = await createTestBankTransaction(company.id, statement.id, {
        date: '2025-03-15',
        amount: -100,
        description: 'Pago de alquiler oficina',
      });

      const expenseGl = await createTestGlAccount({
        companyId: company.id,
        code: '6010',
        name: 'Rent Expense',
        accountType: 'expense',
        normalBalance: 'debit',
      });

      const result = await ReconciliationService.reconcile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        transactions: [{ id: bankTx.id, glAccountId: expenseGl.id }],
        createJournalEntries: true,
      });

      expect(result.warnings).toHaveLength(0);
      expect(result.reconciledCount).toBe(1);

      const updatedTx = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
      expect(updatedTx?.status).toBe('posted');

      const entries = await db.journalEntry.findMany({
        where: { companyId: company.id },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe('posted');
    });
  });

  describe('Journal entry linking & GL balance sync (BRE fix: reconciliation contract 1:1)', () => {
    beforeEach(async () => {
      await clearDatabase();
    });

    afterEach(async () => {
      await clearDatabase();
    });

    it('sin JE previo + createJournalEntries=true: crea 1 JE, 2 líneas balanceadas, vincula journalEntryId y actualiza balances GL', async () => {
      const company = await createTestCompany();
      const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
      const bankAccount = await createTestBankAccount(company.id, cashGl.id);
      const statement = await createTestBankStatement(company.id, bankAccount.id);
      await createFiscalPeriod(company.id);

      const bankTx = await createTestBankTransaction(company.id, statement.id, {
        date: '2025-03-03',
        amount: 1100.0,
        description: 'Zelle payment from RODRIGO OCHOA',
        reference: 'T0YKY6RCL',
      });

      const incomeGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Sales Revenue', accountType: 'revenue', normalBalance: 'credit' });

      const result = await ReconciliationService.reconcile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        transactions: [{ id: bankTx.id, glAccountId: incomeGl.id, splits: null }],
        createJournalEntries: true,
      });

      expect(result.reconciledCount).toBe(1);
      expect(result.journalEntriesCreated).toBe(1);

      const entries = await db.journalEntry.findMany({
        where: { companyId: company.id },
        include: { lines: true },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].lines).toHaveLength(2);
      const dr = entries[0].lines.reduce((s, l) => s + Number(l.debit), 0);
      const cr = entries[0].lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(Math.abs(dr - cr)).toBeLessThan(0.01);

      const updatedTx = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
      expect(updatedTx?.journalEntryId).toBe(entries[0].id);
      expect(updatedTx?.isReconciled).toBe(true);

      const cash = await db.glAccount.findUnique({ where: { id: cashGl.id } });
      const income = await db.glAccount.findUnique({ where: { id: incomeGl.id } });
      expect(Number(cash?.balance)).toBeCloseTo(1100.0, 2);
      expect(Number(income?.balance)).toBeCloseTo(1100.0, 2);
    });

    it('con JE previo de apply-all + createJournalEntries=true: NO crea otro JE, conserva journalEntryId, balances no cambian dos veces', async () => {
      const company = await createTestCompany();
      const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
      const bankAccount = await createTestBankAccount(company.id, cashGl.id);
      const statement = await createTestBankStatement(company.id, bankAccount.id);
      await createFiscalPeriod(company.id);

      const bankTx = await createTestBankTransaction(company.id, statement.id, {
        date: '2025-03-03',
        amount: 1100.0,
        description: 'Zelle payment from RODRIGO OCHOA',
        reference: 'T0YKY6RCL',
      });

      const incomeGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Sales Revenue', accountType: 'revenue', normalBalance: 'credit' });

      // Simula apply-all: el JE ya existe y la tx ya está vinculada
      const entryId = await JournalEntryService.createFromBankTransaction(db as any, {
        bankTxId: bankTx.id,
        bankTxDate: bankTx.date,
        bankTxAmount: Number(bankTx.amount),
        bankTxDescription: bankTx.description,
        bankGlAccountId: cashGl.id,
        counterpartyGlAccountId: incomeGl.id,
        companyId: company.id,
      });
      expect(entryId).toBeTruthy();

      const jeCountBefore = await db.journalEntry.count({ where: { companyId: company.id } });

      const result = await ReconciliationService.reconcile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        transactions: [{ id: bankTx.id, glAccountId: incomeGl.id, splits: null }],
        createJournalEntries: true,
      });

      expect(result.reconciledCount).toBe(1);
      expect(result.journalEntriesCreated).toBe(0);

      const jeCountAfter = await db.journalEntry.count({ where: { companyId: company.id } });
      expect(jeCountAfter).toBe(jeCountBefore);

      const updatedTx = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
      expect(updatedTx?.journalEntryId).toBe(entryId);
      expect(updatedTx?.isReconciled).toBe(true);

      // El balance NO debe duplicarse: sigue siendo 1100, no 2200
      const cash = await db.glAccount.findUnique({ where: { id: cashGl.id } });
      const income = await db.glAccount.findUnique({ where: { id: incomeGl.id } });
      expect(Number(cash?.balance)).toBeCloseTo(1100.0, 2);
      expect(Number(income?.balance)).toBeCloseTo(1100.0, 2);
    });

    it('createJournalEntries=false: no crea JE pero la reconciliación sigue funcionando', async () => {
      const company = await createTestCompany();
      const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
      const bankAccount = await createTestBankAccount(company.id, cashGl.id);
      const statement = await createTestBankStatement(company.id, bankAccount.id);
      await createFiscalPeriod(company.id);

      const bankTx = await createTestBankTransaction(company.id, statement.id, {
        date: '2025-03-03',
        amount: 1100.0,
        description: 'Zelle payment from RODRIGO OCHOA',
      });

      const incomeGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Sales Revenue', accountType: 'revenue', normalBalance: 'credit' });

      const result = await ReconciliationService.reconcile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        transactions: [{ id: bankTx.id, glAccountId: incomeGl.id, splits: null }],
        createJournalEntries: false,
      });

      expect(result.reconciledCount).toBe(1);
      expect(result.journalEntriesCreated).toBe(0);

      const jeCount = await db.journalEntry.count({ where: { companyId: company.id } });
      expect(jeCount).toBe(0);

      const updatedTx = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
      expect(updatedTx?.isReconciled).toBe(true);
      expect(updatedTx?.journalEntryId).toBeNull();
    });

    it('con splits: JE multi-línea balanceado, journalEntryId vinculado y balances de TODAS las cuentas recalculados', async () => {
      const company = await createTestCompany();
      const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
      const bankAccount = await createTestBankAccount(company.id, cashGl.id);
      const statement = await createTestBankStatement(company.id, bankAccount.id);
      await createFiscalPeriod(company.id);

      const bankTx = await createTestBankTransaction(company.id, statement.id, {
        date: '2025-03-15',
        amount: 500.0,
        description: 'Ingreso dividido',
      });

      const revenueGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Sales', accountType: 'revenue', normalBalance: 'credit' });
      const taxGl = await createTestGlAccount({ companyId: company.id, code: '2010', name: 'Tax Payable', accountType: 'liability', normalBalance: 'credit' });

      const result = await ReconciliationService.reconcile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        transactions: [{
          id: bankTx.id,
          glAccountId: revenueGl.id,
          splits: [
            { glAccountId: revenueGl.id, amount: 400, description: 'Revenue portion' },
            { glAccountId: taxGl.id, amount: 100, description: 'Tax portion' },
          ],
        }],
        createJournalEntries: true,
      });

      expect(result.reconciledCount).toBe(1);
      expect(result.journalEntriesCreated).toBe(1);

      const entries = await db.journalEntry.findMany({
        where: { companyId: company.id },
        include: { lines: true },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].lines).toHaveLength(3);

      const updatedTx = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
      expect(updatedTx?.journalEntryId).toBe(entries[0].id);

      const cash = await db.glAccount.findUnique({ where: { id: cashGl.id } });
      const revenue = await db.glAccount.findUnique({ where: { id: revenueGl.id } });
      const tax = await db.glAccount.findUnique({ where: { id: taxGl.id } });
      expect(Number(cash?.balance)).toBeCloseTo(500.0, 2);
      expect(Number(revenue?.balance)).toBeCloseTo(400.0, 2);
      expect(Number(tax?.balance)).toBeCloseTo(100.0, 2);
    });
  });
});

// ───────────────────────────────────────────────
// P14 — Tenant isolation: split GL accounts
// ───────────────────────────────────────────────

describe('P14 — splits con GL accounts foráneas (aislamiento de tenant)', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('A→B: rechaza conciliar con split.glAccountId de otra empresa y deja a B intacta', async () => {
    const userA = await createTestUser('p14-a@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);

    const userB = await createTestUser('p14-b@example.com');
    const companyB = await createTestCompany('Company B');
    await createTestCompanyMember(userB.id, companyB.id);

    const bankGlA = await createTestGlAccount({ companyId: companyA.id, code: '1010', name: 'Cash' });
    const bankA = await createTestBankAccount(companyA.id, bankGlA.id);
    const statementA = await createTestBankStatement(companyA.id, bankA.id);
    await createFiscalPeriod(companyA.id);

    const bankTx = await createTestBankTransaction(companyA.id, statementA.id, {
      date: '2025-03-15',
      amount: 500.0,
      description: 'Ingreso dividido cross-tenant',
    });

    const glB = await createTestGlAccount({
      companyId: companyB.id,
      code: '4010',
      name: 'Foreign Revenue',
      accountType: 'revenue',
      normalBalance: 'credit',
    });
    await db.glAccount.update({ where: { id: glB.id }, data: { balance: 1234.56 } });

    const jeCountBefore = await db.journalEntry.count();

    let thrown: unknown = null;
    try {
      await ReconciliationService.reconcile({
        companyId: companyA.id,
        bankAccountId: bankA.id,
        transactions: [{
          id: bankTx.id,
          glAccountId: bankGlA.id,
          splits: [{ glAccountId: glB.id, amount: 500, description: 'Foreign split' }],
        }],
        createJournalEntries: true,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ValidationError);

    const txAfter = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
    expect(txAfter?.isReconciled).toBe(false);

    const jeCountAfter = await db.journalEntry.count();
    expect(jeCountAfter).toBe(jeCountBefore);

    const linesOnGlB = await db.journalLine.findMany({ where: { glAccountId: glB.id } });
    expect(linesOnGlB).toHaveLength(0);

    const glBAfter = await db.glAccount.findUnique({ where: { id: glB.id } });
    expect(Number(glBAfter?.balance)).toBe(1234.56);
  });

  it('A→A: conciliación con splits propios sigue funcionando', async () => {
    const userA = await createTestUser('p14-c@example.com');
    const companyA = await createTestCompany('Company A');
    await createTestCompanyMember(userA.id, companyA.id);

    const bankGlA = await createTestGlAccount({ companyId: companyA.id, code: '1010', name: 'Cash' });
    const bankA = await createTestBankAccount(companyA.id, bankGlA.id);
    const statementA = await createTestBankStatement(companyA.id, bankA.id);
    await createFiscalPeriod(companyA.id);

    const bankTx = await createTestBankTransaction(companyA.id, statementA.id, {
      date: '2025-03-15',
      amount: 500.0,
      description: 'Ingreso dividido',
    });

    const revenueA = await createTestGlAccount({ companyId: companyA.id, code: '4010', name: 'Sales', accountType: 'revenue', normalBalance: 'credit' });
    const taxA = await createTestGlAccount({ companyId: companyA.id, code: '2010', name: 'Tax Payable', accountType: 'liability', normalBalance: 'credit' });

    const result = await ReconciliationService.reconcile({
      companyId: companyA.id,
      bankAccountId: bankA.id,
      transactions: [{
        id: bankTx.id,
        glAccountId: revenueA.id,
        splits: [
          { glAccountId: revenueA.id, amount: 400, description: 'Revenue portion' },
          { glAccountId: taxA.id, amount: 100, description: 'Tax portion' },
        ],
      }],
      createJournalEntries: true,
    });

    expect(result.reconciledCount).toBe(1);
    expect(result.journalEntriesCreated).toBe(1);

    const updatedTx = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
    expect(updatedTx?.isReconciled).toBe(true);

    const entries = await db.journalEntry.findMany({
      where: { companyId: companyA.id },
      include: { lines: true },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].lines).toHaveLength(3);

    const cash = await db.glAccount.findUnique({ where: { id: bankGlA.id } });
    const revenue = await db.glAccount.findUnique({ where: { id: revenueA.id } });
    const tax = await db.glAccount.findUnique({ where: { id: taxA.id } });
    expect(Number(cash?.balance)).toBeCloseTo(500.0, 2);
    expect(Number(revenue?.balance)).toBeCloseTo(400.0, 2);
    expect(Number(tax?.balance)).toBeCloseTo(100.0, 2);
  });

  it('D2-H11: createFromBankTransaction rechaza fecha en período cerrado', async () => {
    const company = await createTestCompany();
    const cashGl = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const bankAccount = await createTestBankAccount(company.id, cashGl.id);
    const statement = await createTestBankStatement(company.id, bankAccount.id);

    await db.fiscalPeriod.create({
      data: {
        companyId: company.id,
        name: 'March 2025 Closed',
        startDate: new Date('2025-03-01T00:00:00.000Z'),
        endDate: new Date('2025-03-31T23:59:59.999Z'),
        isLocked: true,
      },
    });

    const bankTx = await createTestBankTransaction(company.id, statement.id, {
      date: '2025-03-15',
      amount: 500.0,
      description: 'Test closed period',
    });

    const incomeGl = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Revenue', accountType: 'revenue', normalBalance: 'credit' });

    const jeCountBefore = await db.journalEntry.count({ where: { companyId: company.id } });

    await expect(
      JournalEntryService.createFromBankTransaction(db as any, {
        bankTxId: bankTx.id,
        bankTxDate: bankTx.date,
        bankTxAmount: Number(bankTx.amount),
        bankTxDescription: bankTx.description,
        bankGlAccountId: cashGl.id,
        counterpartyGlAccountId: incomeGl.id,
        companyId: company.id,
      }),
    ).rejects.toThrow();

    const jeCountAfter = await db.journalEntry.count({ where: { companyId: company.id } });
    expect(jeCountAfter).toBe(jeCountBefore);

    const tx = await db.bankTransaction.findUnique({ where: { id: bankTx.id } });
    expect(tx?.journalEntryId).toBeNull();
  });
});
