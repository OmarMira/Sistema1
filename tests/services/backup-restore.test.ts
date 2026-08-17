import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import fs from 'fs';

const glAccountCreates: Array<{ code: string; parentId: string | null }> = [];
const companyUpsertCalls: any[] = [];
const userUpsertCalls: any[] = [];
const companyMemberCreates: any[] = [];
// D10-E: capture calls for the reconciliation subsystem
const reconciliationPeriodCreates: any[] = [];
const bankTransactionCreates: any[] = [];
const companyKnowledgeCreates: any[] = [];
const companyKnowledgeUpdates: any[] = [];
const knowledgeAuditCreates: any[] = [];

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
          if (model === 'reconciliationPeriod' && method === 'create') {
            return vi.fn((args: any) => {
              reconciliationPeriodCreates.push(args.data);
              return { id: `new-recon-${reconciliationPeriodCreates.length}` };
            });
          }
          if (model === 'bankTransaction' && method === 'create') {
            return vi.fn((args: any) => {
              bankTransactionCreates.push(args.data);
              return { id: `new-tx-${bankTransactionCreates.length}` };
            });
          }
          if (model === 'companyKnowledge' && method === 'create') {
            return vi.fn((args: any) => {
              companyKnowledgeCreates.push(args.data);
              return { id: `new-kn-${companyKnowledgeCreates.length}` };
            });
          }
          if (model === 'companyKnowledge' && method === 'update') {
            return vi.fn((args: any) => {
              companyKnowledgeUpdates.push(args);
              return { id: args.where.id };
            });
          }
          if (model === 'knowledgeAudit' && method === 'create') {
            return vi.fn((args: any) => {
              knowledgeAuditCreates.push(args.data);
              return { id: `new-ka-${knowledgeAuditCreates.length}` };
            });
          }
          if (model === 'company' && method === 'upsert') {
            return vi.fn((args: any) => {
              companyUpsertCalls.push(args);
              return { id: args.where.id };
            });
          }
          if (model === 'bankAccount' && method === 'create') {
            return vi.fn((args: any) => {
              return { id: `new-${args.data.id}` };
            });
          }
          if (model === 'bankStatement' && method === 'create') {
            return vi.fn((args: any) => {
              return { id: `new-${args.data.id}` };
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
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit-log' }),
    },
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
        systemConfig: 0,
        companyConfig: false,
        reconciliationPeriods: 0,
        companyKnowledge: 0,
        knowledgeAudit: 0,
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
      systemConfig: [],
      companyConfig: null,
      reconciliationPeriods: [],
      companyKnowledge: [],
      knowledgeAudit: [],
      ...overrides,
    },
  };
}

describe('restoreBackup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.$transaction as Mock).mockImplementation((cb: any) => {
      currentTx = buildTx();
      return cb(currentTx);
    });
    glAccountCreates.length = 0;
    companyUpsertCalls.length = 0;
    userUpsertCalls.length = 0;
    companyMemberCreates.length = 0;
    reconciliationPeriodCreates.length = 0;
    bankTransactionCreates.length = 0;
    companyKnowledgeCreates.length = 0;
    companyKnowledgeUpdates.length = 0;
    knowledgeAuditCreates.length = 0;
    currentTx = null;
  });

  it('restores company, users, and GL accounts on clean DB', async () => {
    const data = buildBackupData();

    const result = await restoreBackup('company-1', data, 'test-user');

    expect(result.success).toBe(true);

    // Company upsert
    expect(companyUpsertCalls).toHaveLength(1);
    expect(companyUpsertCalls[0].where.id).toBe('company-1');
    expect(companyUpsertCalls[0].create.legalName).toBe('Test Company S.A.');

    // User upsert (3 users)
    expect(userUpsertCalls).toHaveLength(3);
    expect(userUpsertCalls[0].where.id).toBe('user-1');
    // update contains user data minus createdAt, updatedAt, passwordHash
    expect(userUpsertCalls[0].update.email).toBe('user1@test.com');
    expect(userUpsertCalls[0].update.firstName).toBe('Test');

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

    const result = await restoreBackup('company-1', data, 'test-user');

    expect(result.success).toBe(true);
    expect(glAccountCreates).toHaveLength(2);
    expect(glAccountCreates[0].code).toBe('1000');
    expect(glAccountCreates[1].code).toBe('2000');
  });

  it('rejects mismatched companyId', async () => {
    const data = buildBackupData();

    const result = await restoreBackup('other-company', data, 'test-user');

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/does not match/i);
    expect(glAccountCreates).toHaveLength(0);
  });

  it('rejects invalid backup structure', async () => {
    const invalid = { manifest: {}, data: {} } as any;

    const result = await restoreBackup('company-1', invalid, 'test-user');

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/invalid backup/i);
  });

  it('logs error and returns failure when transaction throws', async () => {
    const data = buildBackupData();
    // Force a failure by making company data empty (company[0] will be undefined)
    // The upsert will not be called, but the company member insert will fail
    // because the mock tx finds no company. Or better: make the tx throw.
    (db.$transaction as Mock).mockRejectedValueOnce(new Error('DB locked'));

    const result = await restoreBackup('company-1', data, 'test-user');

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/DB locked/);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('D10-E reconciliation + knowledge restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.$transaction as Mock).mockImplementation((cb: any) => {
      currentTx = buildTx();
      return cb(currentTx);
    });
    glAccountCreates.length = 0;
    companyUpsertCalls.length = 0;
    userUpsertCalls.length = 0;
    companyMemberCreates.length = 0;
    reconciliationPeriodCreates.length = 0;
    bankTransactionCreates.length = 0;
    companyKnowledgeCreates.length = 0;
    companyKnowledgeUpdates.length = 0;
    knowledgeAuditCreates.length = 0;
    currentTx = null;
  });

  it('restores reconciliation periods, remaps bankTransaction.reconciliationPeriodId, and restores knowledge + audit', async () => {
    const data = buildBackupData();
    data.data.bankAccounts = [
      { id: 'ba-1', companyId: 'company-1', glAccountId: 'gl-1000', name: 'Caja', accountType: 'asset', normalBalance: 'debit', isActive: true },
    ];
    data.data.bankStatements = [
      { id: 'bs-1', companyId: 'company-1', bankAccountId: 'ba-1', startDate: '2026-01-01', endDate: '2026-01-31', openingBalance: 0, closingBalance: 0, status: 'open' },
    ];
    data.data.reconciliationPeriods = [
      { id: 'rp-1', companyId: 'company-1', bankAccountId: 'ba-1', userId: 'user-1', status: 'open' },
    ];
    data.data.bankTransactions = [
      { id: 'tx-1', companyId: 'company-1', statementId: 'bs-1', glAccountId: 'gl-1000', amount: 100, description: 'Deposito', date: '2026-01-02', type: 'credit', reconciliationPeriodId: 'rp-1' },
    ];
    data.data.companyKnowledge = [
      { id: 'kn-1', companyId: 'company-1', type: 'CONTACT', canonicalName: 'ACME SA', aliases: [], metadata: {}, status: 'active', version: 1 },
      { id: 'kn-2', companyId: 'company-1', type: 'CONTACT', canonicalName: 'Acme Corp', aliases: [], metadata: {}, status: 'merged', version: 2, mergedIntoId: 'kn-1' },
    ];
    data.data.knowledgeAudit = [
      { id: 'ka-1', knowledgeId: 'kn-1', action: 'CREATE', version: 1, changedByUserId: 'user-1', timestamp: '2026-01-02T00:00:00.000Z', source: 'backup-test', reason: 'initial' },
    ];
    data.manifest.recordCounts.reconciliationPeriods = 1;
    data.manifest.recordCounts.companyKnowledge = 2;
    data.manifest.recordCounts.knowledgeAudit = 1;

    const result = await restoreBackup('company-1', data, 'test-user');

    expect(result.success).toBe(true);
    expect(result.restoredCounts.reconciliationPeriods).toBe(1);
    expect(result.restoredCounts.companyKnowledge).toBe(2);
    expect(result.restoredCounts.knowledgeAudit).toBe(1);

    // Reconciliation period created with remapped bankAccountId
    expect(reconciliationPeriodCreates).toHaveLength(1);
    expect(reconciliationPeriodCreates[0].bankAccountId).toBe('new-ba-1');

    // bankTransaction keeps a (remapped) reconciliationPeriodId instead of dropping it
    expect(bankTransactionCreates).toHaveLength(1);
    expect(bankTransactionCreates[0].reconciliationPeriodId).toBe('new-recon-1');
    expect(bankTransactionCreates[0].glAccountId).toBe('new-1000');
    expect(bankTransactionCreates[0].statementId).toBe('new-bs-1');

    // Company knowledge created without mergedInto FK, linked in second pass
    expect(companyKnowledgeCreates).toHaveLength(2);
    expect(companyKnowledgeCreates[0].mergedIntoId).toBeUndefined();
    const mergeUpdate = companyKnowledgeUpdates.find((u) => u.where.id === 'new-kn-2');
    expect(mergeUpdate).toBeDefined();
    expect(mergeUpdate.data.mergedIntoId).toBe('new-kn-1');

    // Knowledge audit references the remapped knowledge id
    expect(knowledgeAuditCreates).toHaveLength(1);
    expect(knowledgeAuditCreates[0].knowledgeId).toBe('new-kn-1');
  });

  it('restores legacy 1.0.0 backups without reconciliation sections (backwards compatibility)', async () => {
    const data = buildBackupData();
    // Simulate a legacy backup: sections absent
    delete data.data.reconciliationPeriods;
    delete data.data.companyKnowledge;
    delete data.data.knowledgeAudit;

    const result = await restoreBackup('company-1', data, 'test-user');

    expect(result.success).toBe(true);
    expect(reconciliationPeriodCreates).toHaveLength(0);
    expect(companyKnowledgeCreates).toHaveLength(0);
    expect(knowledgeAuditCreates).toHaveLength(0);
    expect(result.restoredCounts.reconciliationPeriods ?? 0).toBe(0);
  });
});

describe('D10-B company-config write after transaction commit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    companyUpsertCalls.length = 0;
    userUpsertCalls.length = 0;
    companyMemberCreates.length = 0;
    reconciliationPeriodCreates.length = 0;
    bankTransactionCreates.length = 0;
    currentTx = null;
  });

  it('writes company-config.json only after the $transaction resolves', async () => {
    const data = buildBackupData();
    data.data.companyConfig = { currency: 'ARS', periodType: 'MONTHLY' };

    const order: string[] = [];
    (db.$transaction as Mock).mockImplementation(async (cb: any) => {
      currentTx = buildTx();
      const r = await cb(currentTx);
      order.push('tx-resolved');
      return r;
    });
    const fsWriteSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file: unknown) => {
      if (String(file).includes('company-config')) order.push('config-write');
      return undefined;
    });

    const result = await restoreBackup('company-1', data, 'test-user');

    expect(result.success).toBe(true);
    expect(order[order.length - 1]).toBe('config-write');
    expect(order).toContain('tx-resolved');
    fsWriteSpy.mockRestore();
  });

  it('does NOT write company-config.json when the transaction rolls back', async () => {
    const data = buildBackupData();
    data.data.companyConfig = { currency: 'ARS', periodType: 'MONTHLY' };

    const fsWriteSpy = vi.spyOn(fs, 'writeFileSync');
    // auditLog RESTORE_COMPLETED fails inside the tx → tx rejects → rollback
    (db.$transaction as Mock).mockImplementationOnce(async (cb: any) => {
      currentTx = new Proxy(
        { auditLog: { create: vi.fn().mockRejectedValueOnce(new Error('audit write failed')) } },
        {
          get(t, m) {
            if (m === 'auditLog') return Reflect.get(t, m);
            return new Proxy({} as any, {
              get(_t2, method: string) {
                if (method === 'create' || method === 'upsert' || method === 'update') {
                  return vi.fn().mockResolvedValue({ id: `new-${m}` });
                }
                if (method === 'findMany' || method === 'deleteMany') {
                  return vi.fn().mockResolvedValue({ count: 0 });
                }
                return vi.fn().mockResolvedValue({ count: 0 });
              },
            });
          },
        },
      );
      return cb(currentTx);
    });

    const result = await restoreBackup('company-1', data, 'test-user');

    expect(result.success).toBe(false);
    const configCalls = fsWriteSpy.mock.calls.filter((c) =>
      String(c[0]).includes('company-config'),
    );
    expect(configCalls).toHaveLength(0);
    fsWriteSpy.mockRestore();
  });

  it('returns success with a warning when the post-commit config write fails', async () => {
    const data = buildBackupData();
    data.data.companyConfig = { currency: 'ARS', periodType: 'MONTHLY' };

    (db.$transaction as Mock).mockImplementation(async (cb: any) => {
      currentTx = buildTx();
      return cb(currentTx);
    });
    const fsWriteSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file: unknown) => {
      if (String(file).includes('company-config')) {
        throw new Error('ENOSPC: no space left on device');
      }
      return undefined;
    });
    const auditCreateSpy = vi.mocked(db.auditLog.create);

    const result = await restoreBackup('company-1', data, 'test-user');

    expect(result.success).toBe(true);
    expect(result.message).toContain('Backup restored successfully');
    expect(result.message).toContain('company-config.json could not be updated');
    expect(result.message).not.toContain('rolled back');
    const failedAudits = auditCreateSpy.mock.calls.filter(
      (c) => c[0]?.data?.action === 'RESTORE_FAILED',
    );
    expect(failedAudits).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('company-config.json could not be updated'),
      expect.objectContaining({ error: expect.stringContaining('ENOSPC') }),
    );
    fsWriteSpy.mockRestore();
  });
});

describe('computeDepths', () => {
  beforeEach(() => {
    glAccountCreates.length = 0;
    companyUpsertCalls.length = 0;
    userUpsertCalls.length = 0;
    companyMemberCreates.length = 0;
    reconciliationPeriodCreates.length = 0;
    bankTransactionCreates.length = 0;
    currentTx = null;
  });

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

    const result = await restoreBackup('company-1', data, 'test-user');

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
