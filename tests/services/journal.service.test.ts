import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JournalService } from '@/lib/services/journal.service';
import { createTestCompany, createTestGlAccount, clearDatabase } from '../helpers/factories';
import { db } from '@/lib/db';

describe('JournalService', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('debe crear un asiento contable cuadrado exitosamente', async () => {
    const company = await createTestCompany();
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

    const entry = await JournalService.create({
      companyId: company.id,
      date: '2026-05-25',
      description: 'Capital investment',
      status: 'draft',
      lines: [
        { glAccountId: cash.id, debit: 1000.0, credit: 0.0, description: 'Cash receipt' },
        { glAccountId: equity.id, debit: 0.0, credit: 1000.0, description: 'Capital contribution' },
      ],
    });

    expect(entry.id).toBeDefined();
    expect(entry.description).toBe('Capital investment');
    expect(entry.lines).toHaveLength(2);

    const dbLines = await db.journalLine.findMany({
      where: { entryId: entry.id },
    });
    expect(dbLines).toHaveLength(2);
  });

  it('debe fallar al crear un asiento contable descuadrado', async () => {
    const company = await createTestCompany();
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

    await expect(
      JournalService.create({
        companyId: company.id,
        date: '2026-05-25',
        description: 'Imbalanced entry',
        status: 'draft',
        lines: [
          { glAccountId: cash.id, debit: 1000.0, credit: 0.0 },
          { glAccountId: equity.id, debit: 0.0, credit: 900.0 }, // Descuadrado por 100
        ],
      })
    ).rejects.toThrow('Unbalanced journal entry. Debits must equal Credits.');
  });

  it('debe fallar al crear un asiento contable en un periodo fiscal cerrado', async () => {
    const company = await createTestCompany();
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

    // Create a closed fiscal period for May 2026
    await db.fiscalPeriod.create({
      data: {
        companyId: company.id,
        name: 'May 2026',
        startDate: new Date('2026-05-01T00:00:00.000Z'),
        endDate: new Date('2026-05-31T23:59:59.999Z'),
        isLocked: true,
      },
    });

    await expect(
      JournalService.create({
        companyId: company.id,
        date: '2026-05-25',
        description: 'Entry in closed period',
        status: 'draft',
        lines: [
          { glAccountId: cash.id, debit: 1000.0, credit: 0.0 },
          { glAccountId: equity.id, debit: 0.0, credit: 1000.0 },
        ],
      })
    ).rejects.toThrow('Cannot post transactions to a closed period.');
  });

  it('debe fallar al crear un asiento con menos de 2 líneas', async () => {
    const company = await createTestCompany();
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });

    // Zod validación fallará o Service fallará. Aquí probamos la validación del service / zod.
    await expect(
      JournalService.create({
        companyId: company.id,
        date: '2026-05-25',
        description: 'Single line entry',
        status: 'draft',
        lines: [
          { glAccountId: cash.id, debit: 1000.0, credit: 1000.0 },
        ],
      })
    ).rejects.toThrow();
  });
});
