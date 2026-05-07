/**
 * Database seeder for AccountExpress
 *
 * Creates:
 *  - A super_admin user (admin@accountexpress.com / Admin123!)
 *  - A demo company (Demo Business LLC)
 *  - Full US GAAP chart of accounts (hierarchical, isSystem = true)
 *  - Fiscal periods Q1–Q4 2026
 *  - Sample journal entries and bank rules
 *
 * Run:  bun run prisma/seed.ts
 */

import bcrypt from 'bcryptjs';
import { db } from '../src/lib/db';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

interface AccountSeed {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normalBalance: 'debit' | 'credit';
  parentCode?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Chart of Accounts – US GAAP
// ─────────────────────────────────────────────────────────────────────

const CHART_OF_ACCOUNTS: AccountSeed[] = [
  // ── Assets ──────────────────────────────────────────────
  { code: '1000', name: 'Assets', type: 'asset', normalBalance: 'debit' },
  { code: '1010', name: 'Cash & Cash Equivalents', type: 'asset', normalBalance: 'debit', parentCode: '1000' },
  { code: '1020', name: 'Accounts Receivable', type: 'asset', normalBalance: 'debit', parentCode: '1000' },
  { code: '1030', name: 'Inventory', type: 'asset', normalBalance: 'debit', parentCode: '1000' },
  { code: '1040', name: 'Prepaid Expenses', type: 'asset', normalBalance: 'debit', parentCode: '1000' },
  { code: '1100', name: 'Fixed Assets', type: 'asset', normalBalance: 'debit', parentCode: '1000' },
  { code: '1110', name: 'Equipment', type: 'asset', normalBalance: 'debit', parentCode: '1100' },
  { code: '1120', name: 'Vehicles', type: 'asset', normalBalance: 'debit', parentCode: '1100' },
  { code: '1130', name: 'Accumulated Depreciation', type: 'asset', normalBalance: 'credit', parentCode: '1100' },
  { code: '1200', name: 'Other Assets', type: 'asset', normalBalance: 'debit', parentCode: '1000' },

  // ── Liabilities ─────────────────────────────────────────
  { code: '2000', name: 'Liabilities', type: 'liability', normalBalance: 'credit' },
  { code: '2010', name: 'Accounts Payable', type: 'liability', normalBalance: 'credit', parentCode: '2000' },
  { code: '2020', name: 'Credit Cards Payable', type: 'liability', normalBalance: 'credit', parentCode: '2000' },
  { code: '2030', name: 'Accrued Expenses', type: 'liability', normalBalance: 'credit', parentCode: '2000' },
  { code: '2040', name: 'Loans Payable', type: 'liability', normalBalance: 'credit', parentCode: '2000' },
  { code: '2100', name: 'Tax Liabilities', type: 'liability', normalBalance: 'credit', parentCode: '2000' },
  { code: '2110', name: 'Sales Tax Payable', type: 'liability', normalBalance: 'credit', parentCode: '2100' },
  { code: '2120', name: 'Payroll Liabilities', type: 'liability', normalBalance: 'credit', parentCode: '2100' },

  // ── Equity ──────────────────────────────────────────────
  { code: '3000', name: 'Equity', type: 'equity', normalBalance: 'credit' },
  { code: '3010', name: "Owner's Equity", type: 'equity', normalBalance: 'credit', parentCode: '3000' },
  { code: '3020', name: 'Retained Earnings', type: 'equity', normalBalance: 'credit', parentCode: '3000' },
  { code: '3030', name: 'Current Year Earnings', type: 'equity', normalBalance: 'credit', parentCode: '3000' },

  // ── Revenue ─────────────────────────────────────────────
  { code: '4000', name: 'Revenue', type: 'revenue', normalBalance: 'credit' },
  { code: '4010', name: 'Sales Revenue', type: 'revenue', normalBalance: 'credit', parentCode: '4000' },
  { code: '4020', name: 'Service Revenue', type: 'revenue', normalBalance: 'credit', parentCode: '4000' },
  { code: '4030', name: 'Other Revenue', type: 'revenue', normalBalance: 'credit', parentCode: '4000' },
  { code: '4040', name: 'Sales Discounts', type: 'revenue', normalBalance: 'debit', parentCode: '4000' },

  // ── Cost of Goods Sold ─────────────────────────────────
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', normalBalance: 'debit' },
  { code: '5010', name: 'Purchases', type: 'expense', normalBalance: 'debit', parentCode: '5000' },
  { code: '5020', name: 'Cost of Labor', type: 'expense', normalBalance: 'debit', parentCode: '5000' },
  { code: '5030', name: 'Freight & Shipping', type: 'expense', normalBalance: 'debit', parentCode: '5000' },

  // ── Operating Expenses ──────────────────────────────────
  { code: '6000', name: 'Operating Expenses', type: 'expense', normalBalance: 'debit' },
  { code: '6010', name: 'Rent Expense', type: 'expense', normalBalance: 'debit', parentCode: '6000' },
  { code: '6020', name: 'Utilities Expense', type: 'expense', normalBalance: 'debit', parentCode: '6000' },
  { code: '6030', name: 'Salaries & Wages', type: 'expense', normalBalance: 'debit', parentCode: '6000' },
  { code: '6040', name: 'Payroll Taxes', type: 'expense', normalBalance: 'debit', parentCode: '6000' },
  { code: '6050', name: 'Insurance Expense', type: 'expense', normalBalance: 'debit', parentCode: '6000' },
  { code: '6060', name: 'Office Supplies', type: 'expense', normalBalance: 'debit', parentCode: '6000' },
  { code: '6070', name: 'Professional Fees', type: 'expense', normalBalance: 'debit', parentCode: '6000' },
  { code: '6080', name: 'Marketing Expense', type: 'expense', normalBalance: 'debit', parentCode: '6000' },
  { code: '6090', name: 'Travel Expense', type: 'expense', normalBalance: 'debit', parentCode: '6000' },
  { code: '6100', name: 'Maintenance & Repairs', type: 'expense', normalBalance: 'debit', parentCode: '6000' },
  { code: '6110', name: 'Telecommunications', type: 'expense', normalBalance: 'debit', parentCode: '6000' },
  { code: '6120', name: 'Depreciation Expense', type: 'expense', normalBalance: 'debit', parentCode: '6000' },
  { code: '6130', name: 'Bad Debt Expense', type: 'expense', normalBalance: 'debit', parentCode: '6000' },

  // ── Other Expenses ──────────────────────────────────────
  { code: '7000', name: 'Other Expenses', type: 'expense', normalBalance: 'debit' },
  { code: '7010', name: 'Interest Expense', type: 'expense', normalBalance: 'debit', parentCode: '7000' },
  { code: '7020', name: 'Tax Expense', type: 'expense', normalBalance: 'debit', parentCode: '7000' },
  { code: '7030', name: 'Miscellaneous Expense', type: 'expense', normalBalance: 'debit', parentCode: '7000' },

  // ── Income Tax ──────────────────────────────────────────
  { code: '8000', name: 'Income Tax', type: 'expense', normalBalance: 'debit' },
  { code: '8010', name: 'Federal Income Tax', type: 'expense', normalBalance: 'debit', parentCode: '8000' },
  { code: '8020', name: 'State Income Tax', type: 'expense', normalBalance: 'debit', parentCode: '8000' },
];

// ─────────────────────────────────────────────────────────────────────
// Fiscal periods
// ─────────────────────────────────────────────────────────────────────

const FISCAL_PERIODS = [
  { name: 'Q1 2026', start: '2026-01-01', end: '2026-03-31' },
  { name: 'Q2 2026', start: '2026-04-01', end: '2026-06-30' },
  { name: 'Q3 2026', start: '2026-07-01', end: '2026-09-30' },
  { name: 'Q4 2026', start: '2026-10-01', end: '2026-12-31' },
];

// ─────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────

async function seedChartOfAccounts(companyId: string) {
  console.log('  Seeding chart of accounts...');
  const idMap = new Map<string, string>();

  for (const account of CHART_OF_ACCOUNTS) {
    const created = await db.glAccount.create({
      data: {
        companyId,
        code: account.code,
        name: account.name,
        accountType: account.type,
        normalBalance: account.normalBalance,
        parentId: account.parentCode ? idMap.get(account.parentCode) : null,
        isSystem: true,
        isActive: true,
      },
    });
    idMap.set(account.code, created.id);
  }

  console.log(`  Created ${CHART_OF_ACCOUNTS.length} accounts`);
  return idMap;
}

async function seedFiscalPeriods(companyId: string) {
  console.log('  Seeding fiscal periods...');
  for (const period of FISCAL_PERIODS) {
    await db.fiscalPeriod.create({
      data: {
        companyId,
        name: period.name,
        startDate: new Date(period.start + 'T00:00:00.000Z'),
        endDate: new Date(period.end + 'T23:59:59.999Z'),
        isLocked: false,
      },
    });
  }
  console.log(`  Created ${FISCAL_PERIODS.length} fiscal periods`);
}

async function seedSampleJournalEntries(companyId: string, accountIdMap: Map<string, string>) {
  console.log('  Seeding sample journal entries...');

  const entries = [
    {
      date: '2026-01-15',
      description: 'Initial cash investment by owner',
      reference: 'JE-001',
      status: 'posted',
      lines: [
        { accountCode: '1010', debit: 50000, credit: 0 },
        { accountCode: '3010', debit: 0, credit: 50000 },
      ],
    },
    {
      date: '2026-01-20',
      description: 'Monthly office rent payment',
      reference: 'JE-002',
      status: 'posted',
      lines: [
        { accountCode: '6010', debit: 2500, credit: 0 },
        { accountCode: '1010', debit: 0, credit: 2500 },
      ],
    },
    {
      date: '2026-02-01',
      description: 'Sales revenue for January',
      reference: 'JE-003',
      status: 'posted',
      lines: [
        { accountCode: '1010', debit: 12500, credit: 0 },
        { accountCode: '4010', debit: 0, credit: 12500 },
      ],
    },
    {
      date: '2026-02-05',
      description: 'Purchase of office equipment',
      reference: 'JE-004',
      status: 'posted',
      lines: [
        { accountCode: '1110', debit: 3500, credit: 0 },
        { accountCode: '1010', debit: 0, credit: 3500 },
      ],
    },
    {
      date: '2026-02-15',
      description: 'Monthly payroll',
      reference: 'JE-005',
      status: 'posted',
      lines: [
        { accountCode: '6030', debit: 8000, credit: 0 },
        { accountCode: '6040', debit: 612, credit: 0 },
        { accountCode: '2120', debit: 0, credit: 612 },
        { accountCode: '1010', debit: 0, credit: 8000 },
      ],
    },
    {
      date: '2026-03-01',
      description: 'Invoice payment received from client',
      reference: 'JE-006',
      status: 'posted',
      lines: [
        { accountCode: '1010', debit: 7500, credit: 0 },
        { accountCode: '1020', debit: 0, credit: 7500 },
      ],
    },
  ];

  for (const entry of entries) {
    await db.journalEntry.create({
      data: {
        companyId,
        date: new Date(entry.date + 'T12:00:00.000Z'),
        description: entry.description,
        reference: entry.reference,
        status: entry.status,
        lines: {
          create: entry.lines.map((line) => ({
            glAccountId: accountIdMap.get(line.accountCode)!,
            debit: line.debit,
            credit: line.credit,
          })),
        },
      },
    });
  }

  console.log(`  Created ${entries.length} sample journal entries`);
}

async function seedSampleBankRules(companyId: string, accountIdMap: Map<string, string>) {
  console.log('  Seeding sample bank rules...');

  const rules = [
    {
      name: 'Rent Payments',
      conditionType: 'contains',
      conditionValue: 'RENT',
      direction: 'debit',
      accountCode: '6010',
      priority: 10,
    },
    {
      name: 'Payroll Deposits',
      conditionType: 'contains',
      conditionValue: 'PAYROLL',
      direction: 'credit',
      accountCode: '4010',
      priority: 20,
    },
    {
      name: 'Utility Bills',
      conditionType: 'contains',
      conditionValue: 'ELECTRIC',
      direction: 'debit',
      accountCode: '6020',
      priority: 30,
    },
    {
      name: 'Office Supplies',
      conditionType: 'contains',
      conditionValue: 'AMAZON',
      direction: 'debit',
      accountCode: '6060',
      priority: 40,
    },
    {
      name: 'Client Payments',
      conditionType: 'starts_with',
      conditionValue: 'TRANSFER IN',
      direction: 'credit',
      accountCode: '4010',
      priority: 50,
    },
    {
      name: 'Bank Fees',
      conditionType: 'contains',
      conditionValue: 'FEE',
      direction: 'debit',
      accountCode: '7010',
      priority: 60,
    },
  ];

  for (const rule of rules) {
    await db.bankRule.create({
      data: {
        companyId,
        name: rule.name,
        conditionType: rule.conditionType,
        conditionValue: rule.conditionValue,
        transactionDirection: rule.direction,
        glAccountId: accountIdMap.get(rule.accountCode)!,
        priority: rule.priority,
        isActive: true,
      },
    });
  }

  console.log(`  Created ${rules.length} sample bank rules`);
}

// ─────────────────────────────────────────────────────────────────────
// Main seed
// ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌱 Seeding AccountExpress database...\n');

  // 1. Create super_admin user
  console.log('1. Creating super_admin user...');
  const existingAdmin = await db.user.findUnique({
    where: { email: 'admin@accountexpress.com' },
  });

  if (existingAdmin) {
    console.log('   ⚠️  Super admin already exists, skipping.');
  } else {
    const passwordHash = await bcrypt.hash('Admin123!', 12);
    await db.user.create({
      data: {
        email: 'admin@accountexpress.com',
        passwordHash,
        firstName: 'Admin',
        lastName: 'User',
        role: 'super_admin',
        isActive: true,
      },
    });
    console.log('   ✅ Created super_admin (admin@accountexpress.com)');
  }

  // 2. Create demo company
  console.log('\n2. Creating demo company...');
  const existingCompany = await db.company.findFirst({
    where: { legalName: 'Demo Business LLC' },
  });

  let companyId: string;
  if (existingCompany) {
    console.log('   ⚠️  Demo company already exists, skipping account seeding.');
    companyId = existingCompany.id;
  } else {
    const company = await db.company.create({
      data: {
        legalName: 'Demo Business LLC',
        taxId: '12-3456789',
        isActive: true,
      },
    });
    companyId = company.id;
    console.log('   ✅ Created Demo Business LLC');
  }

  // 3. Link admin to demo company (if not already linked)
  const admin = await db.user.findUnique({
    where: { email: 'admin@accountexpress.com' },
  });
  if (admin) {
    const existingMembership = await db.companyMember.findUnique({
      where: {
        userId_companyId: {
          userId: admin.id,
          companyId,
        },
      },
    });
    if (!existingMembership) {
      await db.companyMember.create({
        data: {
          userId: admin.id,
          companyId,
          role: 'company_admin',
        },
      });
      console.log('   ✅ Linked admin to demo company');
    }
  }

  // 4. Seed chart of accounts (only if no accounts exist for this company)
  console.log('\n3. Seeding chart of accounts...');
  const existingAccounts = await db.glAccount.count({
    where: { companyId },
  });
  let accountIdMap: Map<string, string>;

  if (existingAccounts > 0) {
    console.log(`   ⚠️  Company already has ${existingAccounts} accounts, skipping.`);
    // Build idMap from existing accounts
    accountIdMap = new Map<string, string>();
    const accounts = await db.glAccount.findMany({
      where: { companyId },
      select: { code: true, id: true },
    });
    for (const a of accounts) {
      accountIdMap.set(a.code, a.id);
    }
  } else {
    accountIdMap = await seedChartOfAccounts(companyId);
  }

  // 5. Seed fiscal periods
  console.log('\n4. Seeding fiscal periods...');
  const existingPeriods = await db.fiscalPeriod.count({
    where: { companyId },
  });
  if (existingPeriods > 0) {
    console.log(`   ⚠️  Company already has ${existingPeriods} periods, skipping.`);
  } else {
    await seedFiscalPeriods(companyId);
  }

  // 6. Seed sample journal entries
  console.log('\n5. Seeding sample journal entries...');
  const existingEntries = await db.journalEntry.count({
    where: { companyId },
  });
  if (existingEntries > 0) {
    console.log(`   ⚠️  Company already has ${existingEntries} entries, skipping.`);
  } else {
    await seedSampleJournalEntries(companyId, accountIdMap);
  }

  // 7. Seed sample bank rules
  console.log('\n6. Seeding sample bank rules...');
  const existingRules = await db.bankRule.count({
    where: { companyId },
  });
  if (existingRules > 0) {
    console.log(`   ⚠️  Company already has ${existingRules} rules, skipping.`);
  } else {
    await seedSampleBankRules(companyId, accountIdMap);
  }

  console.log('\n✅ Seed completed successfully!\n');
  console.log('═══════════════════════════════════════════');
  console.log('  Login: admin@accountexpress.com');
  console.log('  Password: Admin123!');
  console.log('  Company: Demo Business LLC');
  console.log('═══════════════════════════════════════════\n');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
