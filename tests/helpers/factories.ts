import { db } from '@/lib/db';

export async function createTestUser(email: string = 'test@example.com') {
  return db.user.create({
    data: {
      email,
      passwordHash: 'hashed_password_placeholder',
      firstName: 'Test',
      lastName: 'User',
      role: 'company_admin',
    },
  });
}

export async function createTestCompany(
  name: string = 'Test Company',
  entityType: 'INDIVIDUAL' | 'BUSINESS' = 'BUSINESS',
  overrides: Partial<{ autoRoleAssignment: boolean }> = {},
) {
  return db.company.create({
    data: {
      legalName: name,
      entityType,
      taxId: '12-3456789',
      ...overrides,
    },
  });
}

export async function createTestCompanyMember(userId: string, companyId: string) {
  return db.companyMember.create({
    data: {
      userId,
      companyId,
      role: 'company_admin',
    },
  });
}

export async function createTestGlAccount({
  companyId,
  code,
  name,
  accountType = 'asset',
  normalBalance = 'debit',
}: {
  companyId: string;
  code: string;
  name: string;
  accountType?: string;
  normalBalance?: string;
}) {
  return db.glAccount.create({
    data: {
      companyId,
      code,
      name,
      accountType,
      normalBalance,
      isActive: true,
    },
  });
}

export async function createTestBankAccount(companyId: string, glAccountId: string, bankName: string = 'Test Bank') {
  return db.bankAccount.create({
    data: {
      companyId,
      accountName: bankName,
      bankName,
      glAccountId,
      balance: 1000.0,
      initialBalance: 1000.0,
      isActive: true,
    },
  });
}

export async function createTestBankTransaction(
  companyId: string,
  statementId: string,
  data: {
    date: string;
    amount: number;
    description: string;
    reference?: string | null;
  }
) {
  return db.bankTransaction.create({
    data: {
      statementId,
      date: new Date(data.date),
      amount: data.amount,
      description: data.description,
      reference: data.reference || null,
      isReconciled: false,
    },
  });
}

export async function createTestBankStatement(companyId: string, bankAccountId: string) {
  return db.bankStatement.create({
    data: {
      companyId,
      bankAccountId,
      startDate: new Date('2025-03-01'),
      endDate: new Date('2025-03-31'),
      openingBalance: 1000.0,
      closingBalance: 2000.0,
      format: 'pdf',
      fileName: 'test.pdf',
    },
  });
}

export async function createTestJournalEntry(
  companyId: string,
  data: {
    date: string;
    description: string;
    reference?: string | null;
    lines: { glAccountId: string; debit: number; credit: number; description?: string }[];
  }
) {
  return db.journalEntry.create({
    data: {
      companyId,
      date: new Date(data.date),
      description: data.description,
      reference: data.reference || null,
      status: 'posted',
      lines: {
        create: data.lines.map((l) => ({
          glAccountId: l.glAccountId,
          description: l.description || null,
          debit: l.debit,
          credit: l.credit,
        })),
      },
    },
  });
}

export async function clearDatabase() {
  // HARD STOP: Never clear a production/development database.
  // Only allow clearing if DATABASE_URL points to a test database.
  const url = process.env.DATABASE_URL ?? '';
  if (!url.includes('test')) {
    throw new Error(
      `clearDatabase() REFUSED: DATABASE_URL does not contain 'test'. ` +
      `Current: ${url.slice(0, 40)}... — Fix your test setup to use a test database.`
    );
  }

  // SAFETY: Only delete test data. Test users always have @example.com emails.
  // Find test user IDs first, then find their companies, then cascade deletes.
  const testUsers = await db.user.findMany({
    where: { email: { contains: '@example.com' } },
    select: { id: true },
  });
  const testUserIds = testUsers.map((u) => u.id);

  if (testUserIds.length === 0) {
    // No test data exists — nothing to clean.
    return;
  }

  // Find companies that have test users as members
  const testMemberships = await db.companyMember.findMany({
    where: { userId: { in: testUserIds } },
    select: { companyId: true },
  });
  const testCompanyIds = [...new Set(testMemberships.map((m) => m.companyId))];

  if (testCompanyIds.length === 0) {
    // Test users exist but no companies — just delete the users.
    await db.user.deleteMany({ where: { id: { in: testUserIds } } }).catch(() => {});
    return;
  }

  // Cascade delete: children first, then parents. Only touches test company data.
  if ('session' in db) {
    await db.session.deleteMany({ where: { user: { id: { in: testUserIds } } } }).catch(() => {});
  }

  // Delete entities scoped to test companies
  const companyFilter = { companyId: { in: testCompanyIds } };

  // Find statements and entries scoped to test companies for nested deletes
  const [testStatements, testEntries] = await Promise.all([
    db.bankStatement.findMany({ where: companyFilter, select: { id: true } }),
    db.journalEntry.findMany({ where: companyFilter, select: { id: true } }),
  ]);
  const testStatementIds = testStatements.map((s) => s.id);
  const testEntryIds = testEntries.map((e) => e.id);

  if (testStatementIds.length > 0) {
    await db.bankTransaction.deleteMany({ where: { statementId: { in: testStatementIds } } }).catch(() => {});
  }
  if (testEntryIds.length > 0) {
    await db.journalLine.deleteMany({ where: { entryId: { in: testEntryIds } } }).catch(() => {});
  }

  await db.entityContext.deleteMany({ where: companyFilter }).catch(() => {});
  await db.auditLog.deleteMany({ where: companyFilter }).catch(() => {});
  await db.journalEntry.deleteMany({ where: companyFilter }).catch(() => {});
  await db.bankStatement.deleteMany({ where: companyFilter }).catch(() => {});
  await db.bankAccount.deleteMany({ where: companyFilter }).catch(() => {});
  await db.glAccount.deleteMany({ where: companyFilter }).catch(() => {});
  await db.fiscalPeriod.deleteMany({ where: companyFilter }).catch(() => {});
  await db.companyMember.deleteMany({ where: { companyId: { in: testCompanyIds } } }).catch(() => {});
  await db.company.deleteMany({ where: { id: { in: testCompanyIds } } }).catch(() => {});

  // Finally delete test users
  await db.user.deleteMany({ where: { id: { in: testUserIds } } }).catch(() => {});
}
