import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth';

// ─── POST /api/auth/register ──────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password, firstName, lastName, companyName, taxId } = body;

    // Validate required fields
    if (!email || !password || !firstName || !lastName || !companyName) {
      return NextResponse.json(
        { error: 'Email, password, first name, last name, and company name are required' },
        { status: 400 }
      );
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters' },
        { status: 400 }
      );
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user already exists
    const existingUser = await db.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existingUser) {
      return NextResponse.json(
        { error: 'An account with this email already exists' },
        { status: 409 }
      );
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user and company in a transaction
    const result = await db.$transaction(async (tx) => {
      // Create user
      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          role: 'company_admin',
        },
      });

      // Create company
      const company = await tx.company.create({
        data: {
          legalName: companyName.trim(),
          taxId: taxId?.trim() || null,
        },
      });

      // Create company membership
      await tx.companyMember.create({
        data: {
          userId: user.id,
          companyId: company.id,
          role: 'company_admin',
        },
      });

      // Seed US GAAP chart of accounts for the new company
      await seedChartOfAccounts(tx, company.id);

      // Seed fiscal periods for current year
      await seedFiscalPeriods(tx, company.id);

      return { user, company };
    });

    // Create session token
    const token = crypto.randomUUID();
    const { sessionStore } = await import('@/app/api/auth/me/route');
    sessionStore.set(token, { userId: result.user.id, createdAt: Date.now() });

    const response = NextResponse.json({
      user: {
        id: result.user.id,
        email: result.user.email,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
        role: result.user.role,
      },
      companies: [
        {
          id: result.company.id,
          legalName: result.company.legalName,
          taxId: result.company.taxId,
        },
      ],
    });

    // Set httpOnly cookie
    response.cookies.set('session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60, // 7 days
    });

    return response;
  } catch (error) {
    console.error('[AUTH REGISTER ERROR]', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Chart of accounts seed (US GAAP)
// ─────────────────────────────────────────────────────────────────────
interface AccountSeed {
  code: string;
  name: string;
  type: string;
  normalBalance: string;
  parentCode?: string;
}

const CHART_OF_ACCOUNTS: AccountSeed[] = [
  // Assets
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
  // Liabilities
  { code: '2000', name: 'Liabilities', type: 'liability', normalBalance: 'credit' },
  { code: '2010', name: 'Accounts Payable', type: 'liability', normalBalance: 'credit', parentCode: '2000' },
  { code: '2020', name: 'Credit Cards Payable', type: 'liability', normalBalance: 'credit', parentCode: '2000' },
  { code: '2030', name: 'Accrued Expenses', type: 'liability', normalBalance: 'credit', parentCode: '2000' },
  { code: '2040', name: 'Loans Payable', type: 'liability', normalBalance: 'credit', parentCode: '2000' },
  { code: '2100', name: 'Tax Liabilities', type: 'liability', normalBalance: 'credit', parentCode: '2000' },
  { code: '2110', name: 'Sales Tax Payable', type: 'liability', normalBalance: 'credit', parentCode: '2100' },
  { code: '2120', name: 'Payroll Liabilities', type: 'liability', normalBalance: 'credit', parentCode: '2100' },
  // Equity
  { code: '3000', name: 'Equity', type: 'equity', normalBalance: 'credit' },
  { code: '3010', name: "Owner's Equity", type: 'equity', normalBalance: 'credit', parentCode: '3000' },
  { code: '3020', name: 'Retained Earnings', type: 'equity', normalBalance: 'credit', parentCode: '3000' },
  { code: '3030', name: 'Current Year Earnings', type: 'equity', normalBalance: 'credit', parentCode: '3000' },
  // Revenue
  { code: '4000', name: 'Revenue', type: 'revenue', normalBalance: 'credit' },
  { code: '4010', name: 'Sales Revenue', type: 'revenue', normalBalance: 'credit', parentCode: '4000' },
  { code: '4020', name: 'Service Revenue', type: 'revenue', normalBalance: 'credit', parentCode: '4000' },
  { code: '4030', name: 'Other Revenue', type: 'revenue', normalBalance: 'credit', parentCode: '4000' },
  { code: '4040', name: 'Sales Discounts', type: 'revenue', normalBalance: 'debit', parentCode: '4000' },
  // COGS
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', normalBalance: 'debit' },
  { code: '5010', name: 'Purchases', type: 'expense', normalBalance: 'debit', parentCode: '5000' },
  { code: '5020', name: 'Cost of Labor', type: 'expense', normalBalance: 'debit', parentCode: '5000' },
  { code: '5030', name: 'Freight & Shipping', type: 'expense', normalBalance: 'debit', parentCode: '5000' },
  // Operating Expenses
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
  // Other Expenses
  { code: '7000', name: 'Other Expenses', type: 'expense', normalBalance: 'debit' },
  { code: '7010', name: 'Interest Expense', type: 'expense', normalBalance: 'debit', parentCode: '7000' },
  { code: '7020', name: 'Tax Expense', type: 'expense', normalBalance: 'debit', parentCode: '7000' },
  { code: '7030', name: 'Miscellaneous Expense', type: 'expense', normalBalance: 'debit', parentCode: '7000' },
  // Income Tax
  { code: '8000', name: 'Income Tax', type: 'expense', normalBalance: 'debit' },
  { code: '8010', name: 'Federal Income Tax', type: 'expense', normalBalance: 'debit', parentCode: '8000' },
  { code: '8020', name: 'State Income Tax', type: 'expense', normalBalance: 'debit', parentCode: '8000' },
];

async function seedChartOfAccounts(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  companyId: string
) {
  // Build a map of code -> id for parent lookups
  const idMap = new Map<string, string>();

  for (const account of CHART_OF_ACCOUNTS) {
    const created = await tx.glAccount.create({
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
}

async function seedFiscalPeriods(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  companyId: string
) {
  const year = new Date().getFullYear();
  const periods = [
    { name: `Q1 ${year}`, start: `${year}-01-01`, end: `${year}-03-31` },
    { name: `Q2 ${year}`, start: `${year}-04-01`, end: `${year}-06-30` },
    { name: `Q3 ${year}`, start: `${year}-07-01`, end: `${year}-09-30` },
    { name: `Q4 ${year}`, start: `${year}-10-01`, end: `${year}-12-31` },
  ];

  for (const period of periods) {
    await tx.fiscalPeriod.create({
      data: {
        companyId,
        name: period.name,
        startDate: new Date(period.start + 'T00:00:00.000Z'),
        endDate: new Date(period.end + 'T23:59:59.999Z'),
        isLocked: false,
      },
    });
  }
}
