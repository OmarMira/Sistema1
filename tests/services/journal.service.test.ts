import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JournalService } from '@/lib/services/journal.service';
import { createTestUser, createTestCompany, createTestCompanyMember, createTestGlAccount, clearDatabase } from '../helpers/factories';
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
    const user = await createTestUser('orig-cuadrado@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

    const { entry } = await JournalService.create(
      {
        companyId: company.id,
        date: '2026-05-25',
        description: 'Capital investment',
        status: 'draft',
        lines: [
          { glAccountId: cash.id, debit: 1000.0, credit: 0.0, description: 'Cash receipt' },
          { glAccountId: equity.id, debit: 0.0, credit: 1000.0, description: 'Capital contribution' },
        ],
      },
      user.id,
    );

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
          { glAccountId: equity.id, debit: 0.0, credit: 900.0 },
        ],
      })
    ).rejects.toThrow('Unbalanced journal entry. Debits must equal Credits.');
  });

  it('debe fallar al crear un asiento contable en un periodo fiscal cerrado', async () => {
    const company = await createTestCompany();
    const user = await createTestUser('orig-periodo@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

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
      JournalService.create(
        {
          companyId: company.id,
          date: '2026-05-25',
          description: 'Entry in closed period',
          status: 'draft',
          lines: [
            { glAccountId: cash.id, debit: 1000.0, credit: 0.0 },
            { glAccountId: equity.id, debit: 0.0, credit: 1000.0 },
          ],
        },
        user.id,
      )
    ).rejects.toThrow('Cannot post transactions to a closed period.');
  });

  it('debe fallar al crear un asiento con menos de 2 líneas', async () => {
    const company = await createTestCompany();
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });

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

// ─── D2-H4: POST /api/journal creates posted without AuditLog or recalculateBalance ───
describe('D2-H4 — POST created posted entry with audit + balance recalculation', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('POST with status:posted creates the entry with status posted', async () => {
    const company = await createTestCompany();
    const user = await createTestUser('d2h4-post@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

    const { entry } = await JournalService.create(
      {
        companyId: company.id,
        date: '2026-08-22',
        description: 'Direct posted entry',
        status: 'posted',
        lines: [
          { glAccountId: cash.id, debit: 500, credit: 0 },
          { glAccountId: equity.id, debit: 0, credit: 500 },
        ],
      },
      user.id,
    );

    expect(entry.id).toBeDefined();
    expect(entry.status).toBe('posted');

    const dbEntry = await db.journalEntry.findUnique({ where: { id: entry.id } });
    expect(dbEntry?.status).toBe('posted');
  });

  it('POST with status:posted creates AuditLog with correct actor', async () => {
    const company = await createTestCompany();
    const user = await createTestUser('d2h4-audit@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

    const { entry } = await JournalService.create(
      {
        companyId: company.id,
        date: '2026-08-22',
        description: 'Audit test entry',
        status: 'posted',
        lines: [
          { glAccountId: cash.id, debit: 200, credit: 0 },
          { glAccountId: equity.id, debit: 0, credit: 200 },
        ],
      },
      user.id,
    );

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'journalEntry', entityId: entry.id },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].userId).toBe(user.id);
    expect(auditLogs[0].action).toBe('create');
    expect(auditLogs[0].companyId).toBe(company.id);
  });

  it('POST with status:posted recalculates all affected GL account balances', async () => {
    const company = await createTestCompany();
    const user = await createTestUser('d2h4-balance@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash', normalBalance: 'debit' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital', normalBalance: 'credit', accountType: 'equity' });

    const beforeCash = await db.glAccount.findUnique({ where: { id: cash.id }, select: { balance: true, normalBalance: true } });
    const beforeEquity = await db.glAccount.findUnique({ where: { id: equity.id }, select: { balance: true, normalBalance: true } });
    expect(Number(beforeCash?.balance)).toBe(0);
    expect(Number(beforeEquity?.balance)).toBe(0);
    expect(beforeCash?.normalBalance).toBe('debit');
    expect(beforeEquity?.normalBalance).toBe('credit');

    await JournalService.create(
      {
        companyId: company.id,
        date: '2026-08-22',
        description: 'Balance recalc test',
        status: 'posted',
        lines: [
          { glAccountId: cash.id, debit: 750, credit: 0 },
          { glAccountId: equity.id, debit: 0, credit: 750 },
        ],
      },
      user.id,
    );

    const afterCash = await db.glAccount.findUnique({ where: { id: cash.id }, select: { balance: true } });
    const afterEquity = await db.glAccount.findUnique({ where: { id: equity.id }, select: { balance: true } });
    expect(Number(afterCash?.balance)).toBe(750);
    expect(Number(afterEquity?.balance)).toBe(750);
  });

  it('duplicate account IDs in lines do not cause duplicate balance recalculations', async () => {
    const company = await createTestCompany();
    const user = await createTestUser('d2h4-dedup@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const expense = await createTestGlAccount({ companyId: company.id, code: '4010', name: 'Expense' });

    // Balanced entry: debits = 300+200 = 500, credits = 100+400 = 500
    await JournalService.create(
      {
        companyId: company.id,
        date: '2026-08-22',
        description: 'Dedup test',
        status: 'posted',
        lines: [
          { glAccountId: cash.id, debit: 300, credit: 0 },
          { glAccountId: cash.id, debit: 0, credit: 100 },
          { glAccountId: expense.id, debit: 200, credit: 0 },
          { glAccountId: expense.id, debit: 0, credit: 400 },
        ],
      },
      user.id,
    );

    const afterCash = await db.glAccount.findUnique({ where: { id: cash.id }, select: { balance: true } });
    const afterExpense = await db.glAccount.findUnique({ where: { id: expense.id }, select: { balance: true } });
    // cash: debit-normal, (300 - 100) = 200
    expect(Number(afterCash?.balance)).toBe(200);
    // expense: debit-normal, (200 - 400) = -200
    expect(Number(afterExpense?.balance)).toBe(-200);
  });

  it('if AuditLog fails, JournalEntry is not persisted (full rollback)', async () => {
    const auditModule = await import('@/lib/audit');
    const auditSpy = vi.spyOn(auditModule, 'createAuditLogWithRetry');
    auditSpy.mockRejectedValueOnce(new Error('Simulated audit log failure'));

    const company = await createTestCompany();
    const user = await createTestUser('d2h4-rollback-audit@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

    await expect(
      JournalService.create(
        {
          companyId: company.id,
          date: '2026-08-22',
          description: 'Should rollback on audit failure',
          status: 'posted',
          lines: [
            { glAccountId: cash.id, debit: 500, credit: 0 },
            { glAccountId: equity.id, debit: 0, credit: 500 },
          ],
        },
        user.id,
      )
    ).rejects.toThrow('Simulated audit log failure');

    const entries = await db.journalEntry.findMany({
      where: { companyId: company.id, description: 'Should rollback on audit failure' },
    });
    expect(entries).toHaveLength(0);

    const afterCash = await db.glAccount.findUnique({ where: { id: cash.id }, select: { balance: true } });
    const afterEquity = await db.glAccount.findUnique({ where: { id: equity.id }, select: { balance: true } });
    expect(afterCash?.balance).toBe(0);
    expect(afterEquity?.balance).toBe(0);

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'journalEntry', companyId: company.id },
    });
    expect(auditLogs).toHaveLength(0);

    auditSpy.mockRestore();
  });

  it('if recalculateBalance fails, JournalEntry + AuditLog + balances revert', async () => {
    const { JournalEntryService } = await import('@/lib/services/journal-entry.service');
    const recalcSpy = vi.spyOn(JournalEntryService, 'recalculateBalance');
    recalcSpy.mockRejectedValueOnce(new Error('Simulated recalc failure'));

    const company = await createTestCompany();
    const user = await createTestUser('d2h4-rollback-recalc@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

    await expect(
      JournalService.create(
        {
          companyId: company.id,
          date: '2026-08-22',
          description: 'Should rollback on recalc failure',
          status: 'posted',
          lines: [
            { glAccountId: cash.id, debit: 400, credit: 0 },
            { glAccountId: equity.id, debit: 0, credit: 400 },
          ],
        },
        user.id,
      )
    ).rejects.toThrow('Simulated recalc failure');

    const entries = await db.journalEntry.findMany({
      where: { companyId: company.id, description: 'Should rollback on recalc failure' },
    });
    expect(entries).toHaveLength(0);

    const afterCash = await db.glAccount.findUnique({ where: { id: cash.id }, select: { balance: true } });
    const afterEquity = await db.glAccount.findUnique({ where: { id: equity.id }, select: { balance: true } });
    expect(afterCash?.balance).toBe(0);
    expect(afterEquity?.balance).toBe(0);

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'journalEntry', companyId: company.id },
    });
    expect(auditLogs).toHaveLength(0);

    recalcSpy.mockRestore();
  });

  it('draft creation creates AuditLog but does not recalculateBalance', async () => {
    const company = await createTestCompany();
    const user = await createTestUser('d2h5-draft-audit@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

    const { entry } = await JournalService.create(
      {
        companyId: company.id,
        date: '2026-08-22',
        description: 'Draft should audit but not recalc',
        status: 'draft',
        lines: [
          { glAccountId: cash.id, debit: 300, credit: 0 },
          { glAccountId: equity.id, debit: 0, credit: 300 },
        ],
      },
      user.id,
    );

    expect(entry.status).toBe('draft');

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'journalEntry', entityId: entry.id },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].userId).toBe(user.id);
    expect(auditLogs[0].action).toBe('create');
    expect(auditLogs[0].companyId).toBe(company.id);

    const afterCash = await db.glAccount.findUnique({ where: { id: cash.id }, select: { balance: true } });
    const afterEquity = await db.glAccount.findUnique({ where: { id: equity.id }, select: { balance: true } });
    expect(Number(afterCash?.balance)).toBe(0);
    expect(Number(afterEquity?.balance)).toBe(0);
  });

  it('default status (no status field) creates draft with AuditLog but no recalc', async () => {
    const company = await createTestCompany();
    const user = await createTestUser('d2h5-default-status@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

    const { entry } = await JournalService.create(
      {
        companyId: company.id,
        date: '2026-08-22',
        description: 'Default status entry',
        lines: [
          { glAccountId: cash.id, debit: 100, credit: 0 },
          { glAccountId: equity.id, debit: 0, credit: 100 },
        ],
      },
      user.id,
    );

    expect(entry.status).toBe('draft');

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'journalEntry', entityId: entry.id },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].userId).toBe(user.id);
    expect(auditLogs[0].action).toBe('create');
  });

  it('creation without userId is rejected (draft or posted)', async () => {
    const company = await createTestCompany();
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

    await expect(
      JournalService.create({
        companyId: company.id,
        date: '2026-08-22',
        description: 'Entry without userId should fail',
        status: 'posted',
        lines: [
          { glAccountId: cash.id, debit: 500, credit: 0 },
          { glAccountId: equity.id, debit: 0, credit: 500 },
        ],
      }),
    ).rejects.toThrow('userId is required when creating a journal entry');

    await expect(
      JournalService.create({
        companyId: company.id,
        date: '2026-08-22',
        description: 'Draft without userId should also fail',
        status: 'draft',
        lines: [
          { glAccountId: cash.id, debit: 200, credit: 0 },
          { glAccountId: equity.id, debit: 0, credit: 200 },
        ],
      }),
    ).rejects.toThrow('userId is required when creating a journal entry');

    const entries = await db.journalEntry.findMany({
      where: { companyId: company.id },
    });
    expect(entries).toHaveLength(0);

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'journalEntry', companyId: company.id },
    });
    expect(auditLogs).toHaveLength(0);
  });
});

// ─── D2-H5: draft creation now audited atomically ───
describe('D2-H5 — draft creation creates AuditLog atomically', () => {
  beforeEach(async () => {
    await clearDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  it('status:draft creates exactly one AuditLog with correct fields', async () => {
    const company = await createTestCompany();
    const user = await createTestUser('d2h5-exact-audit@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

    const { entry } = await JournalService.create(
      {
        companyId: company.id,
        date: '2026-08-22',
        description: 'Draft audit test',
        status: 'draft',
        lines: [
          { glAccountId: cash.id, debit: 100, credit: 0 },
          { glAccountId: equity.id, debit: 0, credit: 100 },
        ],
      },
      user.id,
    );

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'journalEntry', entityId: entry.id },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].userId).toBe(user.id);
    expect(auditLogs[0].action).toBe('create');
    expect(auditLogs[0].entity).toBe('journalEntry');
    expect(auditLogs[0].entityId).toBe(entry.id);
    expect(auditLogs[0].companyId).toBe(company.id);
  });

  it('draft does NOT recalculate GL account balances', async () => {
    const company = await createTestCompany();
    const user = await createTestUser('d2h5-no-recalc@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash', normalBalance: 'debit' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital', normalBalance: 'credit', accountType: 'equity' });

    await JournalService.create(
      {
        companyId: company.id,
        date: '2026-08-22',
        description: 'Draft no recalc',
        status: 'draft',
        lines: [
          { glAccountId: cash.id, debit: 500, credit: 0 },
          { glAccountId: equity.id, debit: 0, credit: 500 },
        ],
      },
      user.id,
    );

    const afterCash = await db.glAccount.findUnique({ where: { id: cash.id }, select: { balance: true } });
    const afterEquity = await db.glAccount.findUnique({ where: { id: equity.id }, select: { balance: true } });
    expect(Number(afterCash?.balance)).toBe(0);
    expect(Number(afterEquity?.balance)).toBe(0);
  });

  it('if AuditLog fails during draft creation, JournalEntry is not persisted', async () => {
    const auditModule = await import('@/lib/audit');
    const auditSpy = vi.spyOn(auditModule, 'createAuditLogWithRetry');
    auditSpy.mockRejectedValueOnce(new Error('Simulated audit failure on draft'));

    const company = await createTestCompany();
    const user = await createTestUser('d2h5-rollback-draft@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital' });

    await expect(
      JournalService.create(
        {
          companyId: company.id,
          date: '2026-08-22',
          description: 'Draft rollback test',
          status: 'draft',
          lines: [
            { glAccountId: cash.id, debit: 200, credit: 0 },
            { glAccountId: equity.id, debit: 0, credit: 200 },
          ],
        },
        user.id,
      ),
    ).rejects.toThrow('Simulated audit failure on draft');

    const entries = await db.journalEntry.findMany({
      where: { companyId: company.id, description: 'Draft rollback test' },
    });
    expect(entries).toHaveLength(0);

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'journalEntry', companyId: company.id },
    });
    expect(auditLogs).toHaveLength(0);

    auditSpy.mockRestore();
  });

  it('posted creates exactly one AuditLog (no duplicates) and recalculates balances', async () => {
    const company = await createTestCompany();
    const user = await createTestUser('d2h5-posted-single-audit@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash', normalBalance: 'debit' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital', normalBalance: 'credit', accountType: 'equity' });

    const { entry } = await JournalService.create(
      {
        companyId: company.id,
        date: '2026-08-22',
        description: 'Posted single audit',
        status: 'posted',
        lines: [
          { glAccountId: cash.id, debit: 300, credit: 0 },
          { glAccountId: equity.id, debit: 0, credit: 300 },
        ],
      },
      user.id,
    );

    const auditLogs = await db.auditLog.findMany({
      where: { entity: 'journalEntry', entityId: entry.id },
    });
    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].action).toBe('create');

    const afterCash = await db.glAccount.findUnique({ where: { id: cash.id }, select: { balance: true } });
    const afterEquity = await db.glAccount.findUnique({ where: { id: equity.id }, select: { balance: true } });
    expect(Number(afterCash?.balance)).toBe(300);
    expect(Number(afterEquity?.balance)).toBe(300);
  });

  it('D2-H14 P2002 same hash replays winner', async () => {
    const company = await createTestCompany();
    const user = await createTestUser('d2h14-p2002-same@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash', normalBalance: 'debit' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital', normalBalance: 'credit', accountType: 'equity' });

    const input = {
      companyId: company.id,
      date: '2026-08-25',
      description: 'P2002 same hash',
      reference: null as string | null,
      status: 'draft' as const,
      idempotencyKey: 'd2-h14-p2002-same',
      lines: [
        { glAccountId: cash.id, description: null, debit: 500, credit: 0 },
        { glAccountId: equity.id, description: null, debit: 0, credit: 500 },
      ],
    };

    // mirror of D2-H14 canonical request hash (canonicalizeInput + computeRequestHash)
    const canonical = {
      date: input.date,
      description: input.description || null,
      reference: input.reference || null,
      status: input.status,
      lines: [...input.lines]
        .map((l) => ({
          glAccountId: l.glAccountId,
          description: l.description || null,
          debit: Number(l.debit),
          credit: Number(l.credit),
        }))
        .sort((a, b) =>
          a.glAccountId.localeCompare(b.glAccountId) ||
          (a.description ?? '').localeCompare(b.description ?? '') ||
          b.debit - a.debit ||
          b.credit - a.credit
        ),
    };

    const expectedHash = createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex');

    const winner = {
      id: 'winner-same-hash-id',
      companyId: company.id,
      date: new Date(input.date),
      description: input.description,
      reference: null,
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
      idempotencyKey: 'd2-h14-p2002-same',
      idempotencyRequestHash: expectedHash,
      lines: [] as {
        id: string;
        entryId: string;
        glAccountId: string;
        description: string | null;
        debit: number;
        credit: number;
        createdAt: Date;
        updatedAt: Date;
        glAccount: {
          id: string;
          code: string;
          name: string;
          accountType: string;
          normalBalance: string;
        };
      }[],
    };

    const findUniqueSpy = vi
      .spyOn(db.journalEntry, 'findUnique')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);

    const p2002 = Object.assign(new Error('unique violation'), {
      code: 'P2002',
    });

    const txSpy = vi
      .spyOn(db, '$transaction')
      .mockRejectedValueOnce(p2002);

    try {
      const result = await JournalService.create(input, user.id);

      expect(result.replayed).toBe(true);
      expect(result.entry.id).toBe(winner.id);
      expect(findUniqueSpy).toHaveBeenCalledTimes(2);
      expect(txSpy).toHaveBeenCalledTimes(1);
    } finally {
      findUniqueSpy.mockRestore();
      txSpy.mockRestore();
    }
  });

  it('D2-H14 P2002 different hash returns ConflictError', async () => {
    const company = await createTestCompany();
    const user = await createTestUser('d2h14-p2002-diff@example.com');
    await createTestCompanyMember(user.id, company.id);
    const cash = await createTestGlAccount({ companyId: company.id, code: '1010', name: 'Cash', normalBalance: 'debit' });
    const equity = await createTestGlAccount({ companyId: company.id, code: '3010', name: 'Capital', normalBalance: 'credit', accountType: 'equity' });

    const input = {
      companyId: company.id,
      date: '2026-08-25',
      description: 'P2002 different hash',
      reference: null as string | null,
      status: 'draft' as const,
      idempotencyKey: 'd2-h14-p2002-diff',
      lines: [
        { glAccountId: cash.id, description: null, debit: 500, credit: 0 },
        { glAccountId: equity.id, description: null, debit: 0, credit: 500 },
      ],
    };

    const winner = {
      id: 'winner-different-hash-id',
      companyId: company.id,
      date: new Date(input.date),
      description: input.description,
      reference: null,
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date(),
      idempotencyKey: 'd2-h14-p2002-diff',
      idempotencyRequestHash: 'hash-from-different-payload',
      lines: [] as {
        id: string;
        entryId: string;
        glAccountId: string;
        description: string | null;
        debit: number;
        credit: number;
        createdAt: Date;
        updatedAt: Date;
        glAccount: {
          id: string;
          code: string;
          name: string;
          accountType: string;
          normalBalance: string;
        };
      }[],
    };

    const findUniqueSpy = vi
      .spyOn(db.journalEntry, 'findUnique')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);

    const p2002 = Object.assign(new Error('unique violation'), {
      code: 'P2002',
    });

    const txSpy = vi
      .spyOn(db, '$transaction')
      .mockRejectedValueOnce(p2002);

    try {
      await expect(
        JournalService.create(input, user.id)
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'CONFLICT',
      });

      expect(findUniqueSpy).toHaveBeenCalledTimes(2);
      expect(txSpy).toHaveBeenCalledTimes(1);
    } finally {
      findUniqueSpy.mockRestore();
      txSpy.mockRestore();
    }
  });
});
