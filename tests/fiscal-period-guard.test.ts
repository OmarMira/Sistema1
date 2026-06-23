import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { ReconciliationService } from '@/lib/services/reconciliation.service';
import { createTestCompany, createTestGlAccount, clearDatabase, createTestCompanyMember } from './helpers/factories';
import { db } from '@/lib/db';

describe('Fiscal Period Guard', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('debe permitir transacciones en periodos activos (no bloqueados)', async () => {
    const company = await createTestCompany();
    
    // Período no bloqueado
    await db.fiscalPeriod.create({
      data: {
        companyId: company.id,
        name: 'June 2026',
        startDate: new Date('2026-06-01T00:00:00.000Z'),
        endDate: new Date('2026-06-30T23:59:59.999Z'),
        isLocked: false,
      },
    });

    await expect(assertActiveFiscalPeriod(company.id, '2026-06-15')).resolves.not.toThrow();
  });

  it('debe bloquear transacciones en periodos cerrados/bloqueados', async () => {
    const company = await createTestCompany();
    
    // Período bloqueado
    await db.fiscalPeriod.create({
      data: {
        companyId: company.id,
        name: 'May 2026',
        startDate: new Date('2026-05-01T00:00:00.000Z'),
        endDate: new Date('2026-05-31T23:59:59.999Z'),
        isLocked: true,
      },
    });

    await expect(assertActiveFiscalPeriod(company.id, '2026-05-15')).rejects.toThrow(
      'Cannot post transactions to a closed period'
    );
  });

  it('debe fallar la reconciliación si la transacción cae en un periodo bloqueado', async () => {
    const company = await createTestCompany();
    const bankAccount = await db.bankAccount.create({
      data: {
        companyId: company.id,
        accountName: 'Bank Account Test',
        bankName: 'BoA',
        accountNo: '1234',
        balance: 1000,
        currency: 'USD',
        glAccountId: (await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' })).id,
      },
    });

    const statement = await db.bankStatement.create({
      data: {
        companyId: company.id,
        bankAccountId: bankAccount.id,
        startDate: new Date('2026-05-01T00:00:00.000Z'),
        endDate: new Date('2026-05-31T23:59:59.999Z'),
        openingBalance: 1000,
        closingBalance: 1100,
        format: 'pdf',
      },
    });

    const bankTx = await db.bankTransaction.create({
      data: {
        statementId: statement.id,
        date: new Date('2026-05-15T12:00:00.000Z'), // En mayo
        description: 'Zelle Deposit',
        amount: 100,
        isReconciled: false,
      },
    });

    // Bloquear mayo 2026
    await db.fiscalPeriod.create({
      data: {
        companyId: company.id,
        name: 'May 2026',
        startDate: new Date('2026-05-01T00:00:00.000Z'),
        endDate: new Date('2026-05-31T23:59:59.999Z'),
        isLocked: true,
      },
    });

    const glAccount = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Revenue' });

    await expect(
      ReconciliationService.reconcile({
        companyId: company.id,
        bankAccountId: bankAccount.id,
        createJournalEntries: true,
        transactions: [
          {
            id: bankTx.id,
            glAccountId: glAccount.id,
          },
        ],
      })
    ).rejects.toThrow('Cannot post transactions to a closed period');
  });
});
