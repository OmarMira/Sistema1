import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Shared mock state ───────────────────────────────────────────────────
const mockDbData: Record<string, unknown[]> = {};
const mockSystemConfig: Array<{ key: string; value: string }> = [];
let mockCompany: Record<string, unknown> | null = null;
let mockUUID = '00000000-0000-0000-0000-000000000000';
const mockFSFiles: Record<string, string> = {};

/** The fixture filesystem is EMPTY: no runtime company config and no stored
 * backup. A real absence is an ENOENT fault, which is what the storage layer
 * treats as "not there" (returning an empty string is malformed JSON instead). */
function enoent(what: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, ${what}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}
const statResult = {
  isSymbolicLink: () => false,
  isFile: () => true,
  isDirectory: () => true,
};

// ─── Mocks (hoisted by vitest) ───────────────────────────────────────────

vi.mock('@/lib/db', () => {
  const known = {
    company: {
      findUnique: vi.fn(() => Promise.resolve(mockCompany)),
    },
    glAccount: { findMany: vi.fn(() => Promise.resolve([])) },
    bankAccount: { findMany: vi.fn(() => Promise.resolve([])) },
    bankStatement: { findMany: vi.fn(() => Promise.resolve([])) },
    bankTransaction: { findMany: vi.fn(() => Promise.resolve([])) },
    bankRule: { findMany: vi.fn(() => Promise.resolve([])) },
    journalEntry: { findMany: vi.fn(() => Promise.resolve([])) },
    journalLine: { findMany: vi.fn(() => Promise.resolve([])) },
    fiscalPeriod: { findMany: vi.fn(() => Promise.resolve([])) },
    companyMember: { findMany: vi.fn(() => Promise.resolve([])) },
    user: { findMany: vi.fn(() => Promise.resolve([])) },
    systemConfig: {
      findMany: vi.fn(() => Promise.resolve(mockSystemConfig)),
    },
    reconciliationPeriod: { findMany: vi.fn(() => Promise.resolve([])) },
    companyKnowledge: { findMany: vi.fn(() => Promise.resolve([])) },
    knowledgeAudit: { findMany: vi.fn(() => Promise.resolve([])) },
    // H-DR-1C: Memory Core fetch now participates in createBackup.
    systemMemory: { findMany: vi.fn(() => Promise.resolve([])) },
    memoryItem: { findMany: vi.fn(() => Promise.resolve([])) },
    memoryVersion: { findMany: vi.fn(() => Promise.resolve([])) },
    relationship: { findMany: vi.fn(() => Promise.resolve([])) },
    contradiction: { findMany: vi.fn(() => Promise.resolve([])) },
    evolutionLink: { findMany: vi.fn(() => Promise.resolve([])) },
    traceabilityLog: { findMany: vi.fn(() => Promise.resolve([])) },
    confidenceLog: { findMany: vi.fn(() => Promise.resolve([])) },
    // JH2.13C: the model did not exist when this mock was written. The unit
    // under test is the AI-config exclusion of createBackup — not the chain
    // head (fully covered against real PostgreSQL by tests/forensic/jh2-*).
    journalChainHead: { findUnique: vi.fn(() => Promise.resolve(null)) },
  };
  // Every model this fixture does not name explicitly is an empty, read-only
  // table. The unit under test is the AI-config exclusion of createBackup
  // (the snapshot itself is covered against real PostgreSQL elsewhere), and
  // enumerating every Prisma model here only breaks again on the next addition.
  const db = new Proxy(known as Record<string, unknown>, {
    get(target, property, receiver) {
      if (!(property in target)) {
        target[property as string] = {
          findMany: vi.fn(() => Promise.resolve([])),
          findUnique: vi.fn(() => Promise.resolve(null)),
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { db, withCompanyBackupTransaction: (callback: (tx: unknown) => unknown) => callback(db) };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/constants/ai-config', () => ({
  AI_CONFIG: {
    STORAGE_KEYS_SET: new Set(['ai_encrypted_key', 'ai_model', 'ai_base_url']),
  },
}));

// Only the UUID is pinned: the snapshot seal is real cryptography in the unit
// under test, so every other primitive must stay the genuine one.
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  const randomUUID = vi.fn(() => mockUUID);
  return {
    ...actual,
    default: { ...actual, randomUUID },
    randomUUID,
  };
});

vi.mock('fs', () => {
  const fs = {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => { throw enoent('open'); }),
    readdirSync: vi.fn(() => { throw enoent('scandir'); }),
    writeFileSync: vi.fn(() => undefined),
    mkdirSync: vi.fn(() => undefined),
    lstatSync: vi.fn(() => statResult),
    openSync: vi.fn(() => 1),
    fsyncSync: vi.fn(() => undefined),
    closeSync: vi.fn(() => undefined),
    linkSync: vi.fn(() => undefined),
    renameSync: vi.fn(() => undefined),
    unlinkSync: vi.fn(() => undefined),
  };
  return { default: fs, ...fs };
});

vi.mock('@/lib/config/paths', () => ({
  RUNTIME_FILES: { companyConfig: '/fake/company-config.json' },
  BACKUP_DIR: '/fake/backups',
}));

// ─── Test ────────────────────────────────────────────────────────────────

describe('createBackup AI config protection', () => {
  beforeEach(() => {
    mockCompany = { id: 'test-company', legalName: 'Test Inc', taxId: '123' };
    mockSystemConfig.length = 0;
    mockSystemConfig.push(
      { key: 'ai_encrypted_key', value: 'should-be-excluded' },
      { key: 'ai_model', value: 'should-be-excluded' },
      { key: 'ai_base_url', value: 'should-be-excluded' },
      { key: 'normal_setting', value: 'keep-me' },
    );
    mockUUID = '11111111-1111-1111-1111-111111111111';
    Object.keys(mockFSFiles).forEach((k) => delete mockFSFiles[k]);
    vi.clearAllMocks();
  });

  it('never exports systemConfig, so no AI secret can reach the backup file', async () => {
    const { createBackup } = await import('@/lib/backup');
    const result = await createBackup('test-company');

    const raw = Buffer.from(result.data, 'base64').toString('utf-8');
    const backupData = JSON.parse(raw);

    // Current contract: global configuration is never company-restorable state,
    // so the whole section is excluded — which subsumes the AI-key exclusion
    // (the fixture still seeds the secret keys to prove they cannot reappear).
    expect(backupData.data.systemConfig).toEqual([]);
    expect(result.recordCounts.systemConfig).toBe(0);
    const exported = raw.includes('should-be-excluded') || raw.includes('keep-me');
    expect(exported).toBe(false);
    expect(raw).not.toContain('ai_encrypted_key');
  });
});
