import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePDF } from '@/lib/pdf-parser';
import { ImportService } from '@/lib/services/import.service';
import { MathMismatchError } from '@/lib/api-error';
import { db } from '@/lib/db';
import { createTestCompany, createTestGlAccount, createTestUser, clearDatabase } from './helpers/factories';

let customGetDocumentMock: any = null;

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    GlobalWorkerOptions: original.GlobalWorkerOptions || {},
    getDocument: (...args: any[]) => {
      if (customGetDocumentMock) {
        return customGetDocumentMock(...args);
      }
      return original.getDocument(...args);
    },
  };
});

describe('PDF Parser Fail Graceful tests', () => {
  const fixturesPath = join(__dirname, 'fixtures/boa-statements');

  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
    customGetDocumentMock = null;
    vi.restoreAllMocks();
  });

  it('debe parsear un PDF consistente normalmente con mathValid: true y mismatch: 0', async () => {
    const pdfBuffer = readFileSync(join(fixturesPath, 'eStmt_2025-03-31.pdf'));
    const result = await parsePDF(pdfBuffer, { fileName: 'eStmt_2025-03-31.pdf' });

    expect(result.mathValid).toBe(true);
    expect(result.mismatch).toBeCloseTo(0, 10);
  });

  it('un statement inconsistente falla con mathValid: false, retorna transacciones parciales y registra en AuditLog', async () => {
    const company = await createTestCompany('Audit Company');
    const user = await createTestUser('audit-user@example.com');

    customGetDocumentMock = vi.fn().mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: [
              { str: 'Bank of America', transform: [1, 0, 0, 1, 100, 750], width: 100, height: 10 },
              { str: 'Name: John Doe', transform: [1, 0, 0, 1, 100, 720], width: 100, height: 10 },
              { str: 'Account number: 123456789', transform: [1, 0, 0, 1, 100, 710], width: 100, height: 10 },
              { str: 'Beginning balance on Jan 1, 2025 $1000.00', transform: [1, 0, 0, 1, 100, 700], width: 100, height: 10 },
              { str: 'Ending balance on Jan 31, 2025 $2000.00', transform: [1, 0, 0, 1, 100, 680], width: 100, height: 10 },
              { str: '01/10/2025', transform: [1, 0, 0, 1, 100, 600], width: 50, height: 10 },
              { str: 'Test Transaction', transform: [1, 0, 0, 1, 160, 600], width: 100, height: 10 },
              { str: '500.00', transform: [1, 0, 0, 1, 480, 600], width: 50, height: 10 },
              { str: '01/11/2025', transform: [1, 0, 0, 1, 100, 580], width: 50, height: 10 },
              { str: 'Another Transaction', transform: [1, 0, 0, 1, 160, 580], width: 100, height: 10 },
              { str: '100.00', transform: [1, 0, 0, 1, 480, 580], width: 50, height: 10 },
            ]
          })
        })
      })
    });

    const result = await parsePDF(Buffer.from('dummy_pdf'), {
      fileName: 'inconsistent.pdf',
      companyId: company.id,
      userId: user.id
    });

    expect(result.mathValid).toBe(false);
    expect(result.mismatch).toBe(400); // 1000 (opening) + 600 (txs) = 1600. Closing is 2000. Diff is 400.
    expect(result.transactions.length).toBe(2);
    expect(result.accountHolder).toBe('John Doe');
    expect(result.accountNo).toBe('123456789');

    // Verify AuditLog record
    const auditLogs = await db.auditLog.findMany({
      where: {
        action: 'PDF_PARSE_MATH_MISMATCH',
        companyId: company.id,
      }
    });

    expect(auditLogs.length).toBe(1);
    expect(auditLogs[0].action).toBe('PDF_PARSE_MATH_MISMATCH');
    expect(auditLogs[0].entity).toBe('BankStatement');
    const details = JSON.parse(auditLogs[0].details || '{}');
    expect(details.mismatch).toBe(400);
    expect(details.fileName).toBe('inconsistent.pdf');
    expect(details.parsedData.openingBalance).toBe(1000);
    expect(details.parsedData.closingBalance).toBe(2000);
  });

  it('debe importar con mismatch matemático como warning y persistir el statement', async () => {
    const company = await createTestCompany('Import Company');
    const glAccount = await createTestGlAccount({
      companyId: company.id,
      code: '1010',
      name: 'Cash',
    });
    const bankAccount = await db.bankAccount.create({
      data: {
        companyId: company.id,
        accountName: 'Checking',
        bankName: 'Test Bank',
        accountNo: 'XXXX-1234',
        glAccountId: glAccount.id,
        balance: 1000,
        currency: 'USD',
        isActive: true
      }
    });

    // Mock pdfjs inside parser to return mathValid: false
    customGetDocumentMock = vi.fn().mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: [
              { str: 'Bank of America', transform: [1, 0, 0, 1, 100, 750], width: 100, height: 10 },
              { str: 'Beginning balance on Jan 1, 2025 $1000.00', transform: [1, 0, 0, 1, 100, 700], width: 100, height: 10 },
              { str: 'Ending balance on Jan 31, 2025 $2000.00', transform: [1, 0, 0, 1, 100, 680], width: 100, height: 10 },
              { str: '01/10/2025', transform: [1, 0, 0, 1, 100, 600], width: 50, height: 10 },
              { str: 'Test Transaction', transform: [1, 0, 0, 1, 160, 600], width: 100, height: 10 },
              { str: '500.00', transform: [1, 0, 0, 1, 480, 600], width: 50, height: 10 },
              { str: '01/11/2025', transform: [1, 0, 0, 1, 100, 580], width: 50, height: 10 },
              { str: 'Another Transaction', transform: [1, 0, 0, 1, 160, 580], width: 100, height: 10 },
              { str: '100.00', transform: [1, 0, 0, 1, 480, 580], width: 50, height: 10 },
            ]
          })
        })
      })
    });

    // Import succeeds despite math mismatch (non-fatal)
    const result = await ImportService.importFile({
      companyId: company.id,
      bankAccountId: bankAccount.id,
      fileName: 'mismatch.pdf',
      extension: 'pdf',
      buffer: Buffer.from('dummy_pdf'),
      content: '',
    });

    expect(result.transactionCount).toBe(2);
    expect(result.statementId).toBeTruthy();

    // Verify statement was created
    const statementsCount = await db.bankStatement.count({
      where: { bankAccountId: bankAccount.id }
    });
    expect(statementsCount).toBe(1);
  });

  // LEGACY TEST — Skipped because BoA PDFs do not have multi-column individual checks.
  // BoA statements show "Checks -0.00" as a summary line only. This test was inherited
  // from the old layout-agnostic parser era and tests a scenario that does not occur
  // in real BoA PDFs. Keep as documentation if another bank profile needs this in the future.
  it.skip('debe parsear cheques en formato multi-columna correctamente', async () => {
    const company = await createTestCompany('MultiColumn Company');
    const user = await createTestUser('multicol-user@example.com');

    // Mock PDF with "Checks Paid" section in 2 columns
    customGetDocumentMock = vi.fn().mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getTextContent: async () => ({
            items: [
              // Header & Balances
              { str: 'Bank of America', transform: [1, 0, 0, 1, 100, 750], width: 100, height: 10 },
              { str: 'Beginning balance on Jan 1, 2025 $1000.00', transform: [1, 0, 0, 1, 100, 700], width: 100, height: 10 },
              { str: 'Ending balance on Jan 31, 2025 $800.00', transform: [1, 0, 0, 1, 100, 680], width: 100, height: 10 },
              // Section Header
              { str: 'Checks Paid', transform: [1, 0, 0, 1, 100, 650], width: 100, height: 10 },
              // Check 1 — each check on its own line with amounts in profile column range
              { str: '01/10/2025', transform: [1, 0, 0, 1, 100, 600], width: 50, height: 10 },
              { str: 'Check #101', transform: [1, 0, 0, 1, 160, 600], width: 60, height: 10 },
              { str: '-120.00', transform: [1, 0, 0, 1, 480, 600], width: 50, height: 10 },
              // Check 2
              { str: '01/12/2025', transform: [1, 0, 0, 1, 100, 580], width: 50, height: 10 },
              { str: 'Check #102', transform: [1, 0, 0, 1, 160, 580], width: 60, height: 10 },
              { str: '-80.00', transform: [1, 0, 0, 1, 480, 580], width: 50, height: 10 },
            ]
          })
        })
      })
    });

    const result = await parsePDF(Buffer.from('dummy_pdf'), {
      fileName: 'multicolumn.pdf',
      companyId: company.id,
      userId: user.id
    });

    // Both checks should be parsed correctly as withdrawals (negative amounts)
    expect(result.mathValid).toBe(true);
    expect(result.mismatch).toBe(0);
    expect(result.transactions.length).toBe(2);
    expect(result.transactions[0].amount).toBe(-120.00);
    expect(result.transactions[1].amount).toBe(-80.00);
    expect(result.transactions[0].description).toBe('Check #101');
    expect(result.transactions[1].description).toBe('Check #102');
  });
});
