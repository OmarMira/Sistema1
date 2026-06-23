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

    it('rechaza importación de statement duplicado con ConflictError', async () => {
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
      await ImportService.importFile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        fileName: 'eStmt_2025-03-31.pdf',
        extension: 'pdf',
        buffer: pdfBuffer,
        content: '',
      });

      // Segunda importación (debe lanzar ConflictError)
      await expect(
        ImportService.importFile({
          companyId: company.id,
          bankAccountId: bankAccount.id,
          fileName: 'eStmt_2025-03-31.pdf',
          extension: 'pdf',
          buffer: pdfBuffer,
          content: '',
        }),
      ).rejects.toThrow(ConflictError);
    });
  });
});
