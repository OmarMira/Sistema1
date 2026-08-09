import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parsePDF } from '@/lib/pdf-parser';
import { ImportService } from '@/lib/services/import.service';
import { ConflictError, BankAccountRequiredError } from '@/lib/api-error';
import { createTestCompany, createTestGlAccount, clearDatabase } from '../helpers/factories';
import { readFileSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';

describe('PDF Parser - Bank of America PDF Parser', () => {
  const fixturesPath = join(__dirname, '../fixtures/boa-statements');

  describe('parsePDF - Enero 2025 (mes con mayor actividad)', () => {
    it('parsea correctamente eStmt_2025-01-31.pdf', async () => {
      const pdfBuffer = readFileSync(join(fixturesPath, 'eStmt_2025-01-31.pdf'));
      const result = await parsePDF(pdfBuffer);

      expect(result.transactions).toBeDefined();
      expect(result.transactions.length).toBeGreaterThan(0);

      const referencedTxs = result.transactions.filter((t) => t.reference);
      expect(referencedTxs.length).toBeGreaterThan(0);
    });
  });

  describe('parsePDF - Marzo 2025', () => {
    it('parsea correctamente eStmt_2025-03-31.pdf', async () => {
      const pdfBuffer = readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf'));
      const result = await parsePDF(pdfBuffer);

      expect(result.transactions.length).toBeGreaterThan(0);

      const matchingRef = result.transactions.find((t) => t.reference === 'T0YKY6RCL');
      expect(matchingRef).toBeDefined();
    });
  });

  describe('ImportService - importFile integration', () => {
    beforeEach(async () => {
      await clearDatabase();
    });

    afterEach(async () => {
      await clearDatabase();
    });

    it('debe importar el PDF de Marzo de BOA exitosamente en la base de datos', async () => {
      const company = await createTestCompany('LQ&OM LLC');
      const glAccount = await createTestGlAccount({
        companyId: company.id,
        code: '1010',
        name: 'Cash and Cash Equivalents',
        accountType: 'asset',
        normalBalance: 'debit',
      });
      const pdfBuffer = readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf'));

      // 1. Debe lanzar BankAccountRequiredError si la cuenta no existe
      await expect(
        ImportService.importFile({
          companyId: company.id,
          bankAccountId: null,
          fileName: 'eStmt_2025-03-31.pdf',
          extension: 'pdf',
          buffer: pdfBuffer,
          content: '',
        })
      ).rejects.toThrow(BankAccountRequiredError);

      // 2. Crear la cuenta bancaria en la base de datos
      const bankAccount = await db.bankAccount.create({
        data: {
          companyId: company.id,
          accountName: 'Bank of America Checking',
          bankName: 'Bank of America',
          accountNo: 'XXXX-1234',
          glAccountId: glAccount.id,
          balance: 0,
          currency: 'USD',
          isActive: true
        }
      });

      // 3. Volver a intentar (debe tener éxito)
      const result = await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'eStmt_2025-03-31.pdf',
        extension: 'pdf',
        buffer: pdfBuffer,
        content: '',
      });

      expect(result.statementId).toBeDefined();
      expect(result.transactionCount).toBeGreaterThan(0);
      expect(result.newAccountCreated).toBe(false);
      expect(result.bankAccountName).toBe('Bank of America Checking');
    });

    it('skips duplicate transactions on re-import instead of throwing ConflictError', async () => {
      const company = await createTestCompany('LQ&OM LLC');
      const glAccount = await createTestGlAccount({
        companyId: company.id,
        code: '1010',
        name: 'Cash and Cash Equivalents',
        accountType: 'asset',
        normalBalance: 'debit',
      });
      const pdfBuffer = readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf'));

      // Crear la cuenta bancaria en la base de datos
      const bankAccount = await db.bankAccount.create({
        data: {
          companyId: company.id,
          accountName: 'Bank of America Checking',
          bankName: 'Bank of America',
          accountNo: 'XXXX-1234',
          glAccountId: glAccount.id,
          balance: 0,
          currency: 'USD',
          isActive: true
        }
      });

      // Primera importación (éxito)
      const firstResult = await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'eStmt_2025-03-31.pdf',
        extension: 'pdf',
        buffer: pdfBuffer,
        content: '',
      });

      expect(firstResult.transactionCount).toBeGreaterThan(0);

      // Segunda importación (duplicatesSkipped, no error)
      const secondResult = await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'eStmt_2025-03-31.pdf',
        extension: 'pdf',
        buffer: pdfBuffer,
        content: '',
      });

      expect(secondResult.duplicatesSkipped).toBeGreaterThan(0);
      expect(secondResult.transactionCount).toBe(0);
    });
  });

  describe('ImportService - período fiscal cerrado', () => {
    beforeEach(async () => {
      await clearDatabase();
    });

    afterEach(async () => {
      await clearDatabase();
    });

    it('rechaza importar transacciones en período fiscal cerrado: sin JEs nuevos ni estado parcial', async () => {
      const company = await createTestCompany('Closed Period Co');
      const cashGl = await createTestGlAccount({
        companyId: company.id,
        code: '1010',
        name: 'Cash',
        accountType: 'asset',
        normalBalance: 'debit',
      });
      const revenueGl = await createTestGlAccount({
        companyId: company.id,
        code: '4010',
        name: 'Revenue',
        accountType: 'revenue',
        normalBalance: 'credit',
      });

      const bankAccount = await db.bankAccount.create({
        data: {
          companyId: company.id,
          accountName: 'Checking',
          bankName: 'Test Bank',
          accountNo: 'XXX-1',
          glAccountId: cashGl.id,
          balance: 0,
          currency: 'USD',
          isActive: true,
        },
      });

      await db.bankRule.create({
        data: {
          companyId: company.id,
          name: 'Client Payment',
          conditionType: 'contains',
          conditionValue: 'CLIENT PAYMENT',
          transactionDirection: 'any',
          glAccountId: revenueGl.id,
          priority: 10,
          isActive: true,
        },
      });

      await db.fiscalPeriod.create({
        data: {
          companyId: company.id,
          name: 'June 2025 (locked)',
          startDate: new Date('2025-06-01T00:00:00.000Z'),
          endDate: new Date('2025-06-30T23:59:59.999Z'),
          isLocked: true,
        },
      });

      const csvContent = 'date,description,amount\n2025-06-15,CLIENT PAYMENT,500.00\n';

      const jeCountBefore = await db.journalEntry.count({ where: { companyId: company.id } });

      await expect(
        ImportService.importFile({
          companyId: company.id,
          bankAccountId: bankAccount.id,
          fileName: 'june-2025.csv',
          extension: 'csv',
          buffer: Buffer.from(csvContent),
          content: csvContent,
        }),
      ).rejects.toThrow(/period/i);

      const jeCountAfter = await db.journalEntry.count({ where: { companyId: company.id } });
      expect(jeCountAfter).toBe(jeCountBefore);

      const statementCount = await db.bankStatement.count({
        where: { bankAccountId: bankAccount.id },
      });
      expect(statementCount).toBe(0);

      const txCount = await db.bankTransaction.count({
        where: { statement: { bankAccountId: bankAccount.id } },
      });
      expect(txCount).toBe(0);
    });
  });
});
