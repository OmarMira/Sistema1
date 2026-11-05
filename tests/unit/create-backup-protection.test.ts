import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Shared mock state ───────────────────────────────────────────────────
const mockDbData: Record<string, unknown[]> = {};
const mockSystemConfig: Array<{ key: string; value: string }> = [];
let mockCompany: Record<string, unknown> | null = null;
let mockUUID = '00000000-0000-0000-0000-000000000000';
const mockFSFiles: Record<string, string> = {};
const mockFSSync = {
  existsSync: false,
  readFileSync: '',
};

// ─── Mocks (hoisted by vitest) ───────────────────────────────────────────

vi.mock('@/lib/db', () => {
  const db = {
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
    // D10-E + operational capture batches: these tenants hold no rows here, so
    // the snapshot stays empty and the assertion targets systemConfig only.
    entityContext: { findMany: vi.fn(() => Promise.resolve([])) },
    detectionConfig: { findMany: vi.fn(() => Promise.resolve([])) },
    companyModuleEntitlement: { findMany: vi.fn(() => Promise.resolve([])) },
    csvLayoutProfile: { findMany: vi.fn(() => Promise.resolve([])) },
    ruleApplyRecord: { findMany: vi.fn(() => Promise.resolve([])) },
    ruleExecutionAudit: { findMany: vi.fn(() => Promise.resolve([])) },
    auditLog: { findMany: vi.fn(() => Promise.resolve([])) },
    pendingApproval: { findMany: vi.fn(() => Promise.resolve([])) },
  };
  return { db, withCompanyBackupTransaction: (callback: (tx: typeof db) => unknown) => callback(db) };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/constants/ai-config', () => ({
  AI_CONFIG: {
    STORAGE_KEYS_SET: new Set(['ai_encrypted_key', 'ai_model', 'ai_base_url']),
  },
}));

// Deterministic UUIDs only: sealing a backup still needs real crypto
// (pbkdf2Sync/createHmac/AES-GCM), so the rest of the module stays genuine.
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  const actualDefault = (actual as unknown as { default?: Record<string, unknown> }).default ?? actual;
  const randomUUID = vi.fn(() => mockUUID);
  return {
    ...actual,
    default: { ...actualDefault, randomUUID },
    randomUUID,
  };
});

// The virtual filesystem has exactly one knob per file: existence and content.
// Real fs.readFileSync on a path that does not exist throws ENOENT (backup
// storage treats that as "no company config"); returning '' would instead feed
// an empty payload to JSON.parse.
function enoent(file: unknown): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, open '${String(file)}'`),
    { code: 'ENOENT' },
  );
}

function mockReadFileSync(file?: unknown): string {
  if (!mockFSSync.existsSync) throw enoent(file);
  return mockFSSync.readFileSync;
}

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => mockFSSync.existsSync),
    readFileSync: vi.fn(mockReadFileSync),
    writeFileSync: vi.fn(() => undefined),
    mkdirSync: vi.fn(() => undefined),
    // backup-storage.assertNoLinks walks every component with lstatSync;
    // ensureDirectory then checks the leaf really is a directory. The mock
    // paths are never symlinks.
    lstatSync: vi.fn(() => ({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => true })),
    // Publication writes through an exclusive temp file and then links it into
    // place (see backup-storage.writeAtomic). Storage side effects are no-ops
    // here — the assertion targets the returned snapshot payload.
    readdirSync: vi.fn(() => { throw enoent('/fake/backups'); }),
    openSync: vi.fn(() => 1),
    fsyncSync: vi.fn(() => undefined),
    closeSync: vi.fn(() => undefined),
    linkSync: vi.fn(() => undefined),
    renameSync: vi.fn(() => undefined),
    unlinkSync: vi.fn(() => undefined),
  },
  existsSync: vi.fn(() => mockFSSync.existsSync),
  readFileSync: vi.fn(mockReadFileSync),
  writeFileSync: vi.fn(() => undefined),
  mkdirSync: vi.fn(() => undefined),
  lstatSync: vi.fn(() => ({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => true })),
  readdirSync: vi.fn(() => { throw enoent('/fake/backups'); }),
  openSync: vi.fn(() => 1),
  fsyncSync: vi.fn(() => undefined),
  closeSync: vi.fn(() => undefined),
  linkSync: vi.fn(() => undefined),
  renameSync: vi.fn(() => undefined),
  unlinkSync: vi.fn(() => undefined),
}));

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
    mockFSSync.existsSync = false;
    mockFSSync.readFileSync = '';
    Object.keys(mockFSFiles).forEach((k) => delete mockFSFiles[k]);
    vi.clearAllMocks();
  });

  it('excludes global systemConfig from backups entirely, so AI config keys can never leak (createBackup con implementación real, dependencias mockeadas)', async () => {
    const { createBackup } = await import('@/lib/backup');
    const result = await createBackup('test-company');

    const raw = Buffer.from(result.data, 'base64').toString('utf-8');
    const backupData = JSON.parse(raw);

    // captureCompanySnapshot hardcodes systemConfig = [] ("global configuration
    // is never company-restorable state"), which subsumes the AI-config
    // exclusion: no key — secret or ordinary — may reach a company backup.
    expect(backupData.data.systemConfig).toHaveLength(0);
    expect(result.recordCounts.systemConfig).toBe(0);
  });
});
