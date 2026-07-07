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

  if ('session' in db) {
    await db.session.deleteMany().catch(() => {});
  }
  await db.entityContext.deleteMany().catch(() => {});
  await db.auditLog.deleteMany().catch(() => {});
  await db.journalEntry.deleteMany().catch(() => {});
  await db.bankTransaction.deleteMany().catch(() => {});
  await db.bankStatement.deleteMany().catch(() => {});
  await db.bankAccount.deleteMany().catch(() => {});
  await db.glAccount.deleteMany().catch(() => {});
  await db.companyMember.deleteMany().catch(() => {});
  await db.company.deleteMany().catch(() => {});
  await db.user.deleteMany({ where: { email: { contains: '@example.com' } } }).catch(() => {});
}
