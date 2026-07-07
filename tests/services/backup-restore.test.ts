import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

const glAccountCreates: Array<{ code: string; parentId: string | null }> = [];
const companyUpsertCalls: any[] = [];
const userUpsertCalls: any[] = [];
const companyMemberCreates: any[] = [];

function buildTx(): any {
  return new Proxy({} as any, {
    get(_target, model: string) {
      return new Proxy({} as any, {
        get(_t2, method: string) {
          if (model === 'glAccount' && method === 'create') {
            return vi.fn((args: any) => {
              glAccountCreates.push({
                code: args.data.code,
                parentId: args.data.parentId ?? null,
              });
              return { id: `new-${args.data.code}` };
            });
          }
          if (model === 'company' && method === 'upsert') {
            return vi.fn((args: any) => {
              companyUpsertCalls.push(args);
              return { id: args.where.id };
            });
          }
          if (model === 'user' && method === 'upsert') {
            return vi.fn((args: any) => {
              userUpsertCalls.push(args);
              return { id: args.where.id };
            });
          }
          if (model === 'companyMember' && method === 'create') {
            return vi.fn((args: any) => {
              companyMemberCreates.push(args.data);
              return { id: `new-member-${args.data.userId}` };
            });
          }
          return vi.fn().mockResolvedValue({ count: 0 });
        },
      });
    },
  });
}

let currentTx: any;

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: vi.fn((cb: (...args: any[]) => any) => {
      currentTx = buildTx();
      return cb(currentTx);
    }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

import { restoreBackup, validateBackup } from '@/lib/backup';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

function makeCompany(id = 'company-1') {
  return {
    id,
    legalName: 'Test Company S.A.',
    taxId: '30-12345678-9',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeUser(i: number) {
  return {
    id: `user-${i}`,
    email: `user${i}@test.com`,
    firstName: 'Test',
    lastName: `User${i}`,
    role: 'admin',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeMember(userId: string, companyId = 'company-1') {
  return {
    id: `member-${userId}`,
    companyId,
    userId,
    role: 'admin',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeGlAccount(overrides: Record<string, any>) {
  return {
    id: `gl-${overrides.code}`,
    companyId: 'company-1',
    code: overrides.code,
    name: overrides.name ?? `Account ${overrides.code}`,
    accountType: overrides.accountType ?? 'asset',
    normalBalance: overrides.normalBalance ?? 'debit',
    parentId: overrides.parentId ?? null,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function buildBackupData(overrides?: Partial<any>) {
  return {
    manifest: {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      companyId: 'company-1',
      companyInfo: { id: 'company-1', legalName: 'Test Company S.A.', taxId: '30-12345678-9' },
      recordCounts: {
        company: 1,
        glAccounts: 3,
        bankAccounts: 0,
        bankStatements: 0,
        bankTransactions: 0,
        bankRules: 0,
        journalEntries: 0,
        journalLines: 0,
        fiscalPeriods: 0,
        companyMembers: 3,
        users: 3,
      },
    },
    data: {
      company: [makeCompany()],
      glAccounts: [
        makeGlAccount({ code: '1000', name: 'Activo', accountType: 'asset', normalBalance: 'debit', parentId: null }),
        makeGlAccount({ code: '1010', name: 'Caja', accountType: 'asset', normalBalance: 'debit', parentId: 'gl-1000' }),
        makeGlAccount({ code: '1010-01', name: 'Caja Principal', accountType: 'asset', normalBalance: 'debit', parentId: 'gl-1010' }),
      ],
      bankAccounts: [],
      bankStatements: [],
      bankTransactions: [],
      bankRules: [],
      journalEntries: [],
      journalLines: [],
      fiscalPeriods: [],
      companyMembers: [
        makeMember('user-1'),
        makeMember('user-2'),
        makeMember('user-3'),
      ],
      users: [makeUser(1), makeUser(2), makeUser(3)],
      ...overrides,
    },
  };
}

describe('restoreBackup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    glAccountCreates.length = 0;
    companyUpsertCalls.length = 0;
    userUpsertCalls.length = 0;
    companyMemberCreates.length = 0;
    currentTx = null;
  });

  it('restores company, users, and GL accounts on clean DB', async () => {
    const data = buildBackupData();

    const result = await restoreBackup('company-1', data);

    expect(result.success).toBe(true);

    // Company upsert
    expect(companyUpsertCalls).toHaveLength(1);
    expect(companyUpsertCalls[0].where.id).toBe('company-1');
    expect(companyUpsertCalls[0].create.legalName).toBe('Test Company S.A.');

    // User upsert (3 users)
    expect(userUpsertCalls).toHaveLength(3);
    expect(userUpsertCalls[0].where.id).toBe('user-1');
    expect(userUpsertCalls[0].update).toEqual({}); // update: {} — preserve existing

    // Company members created
    expect(companyMemberCreates).toHaveLength(3);

    // GL accounts created in depth order
    expect(glAccountCreates).toHaveLength(3);
    expect(glAccountCreates[0].code).toBe('1000');
    expect(glAccountCreates[0].parentId).toBeNull();
    expect(glAccountCreates[1].code).toBe('1010');
    expect(glAccountCreates[1].parentId).toBe('new-1000'); // Remapped
    expect(glAccountCreates[2].code).toBe('1010-01');
    expect(glAccountCreates[2].parentId).toBe('new-1010'); // Remapped
  });

  it('handles single-level GL accounts (no parent)', async () => {
    const data = buildBackupData();
    data.data.glAccounts = [
      makeGlAccount({ code: '1000', parentId: null }),
      makeGlAccount({ code: '2000', parentId: null }),
    ];
    data.manifest.recordCounts.glAccounts = 2;

    const result = await restoreBackup('company-1', data);

    expect(result.success).toBe(true);
    expect(glAccountCreates).toHaveLength(2);
    expect(glAccountCreates[0].code).toBe('1000');
    expect(glAccountCreates[1].code).toBe('2000');
  });

  it('rejects mismatched companyId', async () => {
    const data = buildBackupData();

    const result = await restoreBackup('other-company', data);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/does not match/i);
    expect(glAccountCreates).toHaveLength(0);
  });

  it('rejects invalid backup structure', async () => {
    const invalid = { manifest: {}, data: {} } as any;

    const result = await restoreBackup('company-1', invalid);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/invalid backup/i);
  });

  it('logs error and returns failure when transaction throws', async () => {
    const data = buildBackupData();
    // Force a failure by making company data empty (company[0] will be undefined)
    // The upsert will not be called, but the company member insert will fail
    // because the mock tx finds no company. Or better: make the tx throw.
    (db.$transaction as Mock).mockRejectedValueOnce(new Error('DB locked'));

    const result = await restoreBackup('company-1', data);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/DB locked/);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('computeDepths', () => {
  it('sorts 3-level hierarchy deterministically', async () => {
    // Import directly to test the helper via restoreBackup
    // The test creates accounts in wrong order, restoreBackup should sort them
    const data = buildBackupData();
    // Deliberately reverse the GL accounts
    data.data.glAccounts = [
      makeGlAccount({ code: '1010-01', parentId: 'gl-1010' }),
      makeGlAccount({ code: '1010', parentId: 'gl-1000' }),
      makeGlAccount({ code: '1000', parentId: null }),
    ];

    const result = await restoreBackup('company-1', data);

    expect(result.success).toBe(true);
    expect(glAccountCreates).toHaveLength(3);
    // Must come out in depth order regardless of input order
    expect(glAccountCreates[0].code).toBe('1000');
    expect(glAccountCreates[1].code).toBe('1010');
    expect(glAccountCreates[2].code).toBe('1010-01');
  });
});

describe('validateBackup', () => {
  it('passes for valid backup', () => {
    const data = buildBackupData();
    expect(validateBackup(data).valid).toBe(true);
  });

  it('fails when company section is missing', () => {
    const data = buildBackupData({ company: undefined } as any);
    expect(validateBackup(data).valid).toBe(false);
  });

  it('fails when users section is missing', () => {
    const data = buildBackupData({ users: undefined } as any);
    expect(validateBackup(data).valid).toBe(false);
  });
});
