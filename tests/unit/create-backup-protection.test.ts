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

vi.mock('@/lib/db', () => ({
  db: {
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
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/constants/ai-config', () => ({
  AI_CONFIG: {
    STORAGE_KEYS_SET: new Set(['ai_encrypted_key', 'ai_model', 'ai_base_url']),
  },
}));

vi.mock('crypto', () => ({
  default: {
    randomUUID: vi.fn(() => mockUUID),
  },
  randomUUID: vi.fn(() => mockUUID),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => mockFSSync.existsSync),
    readFileSync: vi.fn(() => mockFSSync.readFileSync),
    writeFileSync: vi.fn(() => undefined),
    mkdirSync: vi.fn(() => undefined),
  },
  existsSync: vi.fn(() => mockFSSync.existsSync),
  readFileSync: vi.fn(() => mockFSSync.readFileSync),
  writeFileSync: vi.fn(() => undefined),
  mkdirSync: vi.fn(() => undefined),
}));

vi.mock('@/lib/config/paths', () => ({
  RUNTIME_FILES: { companyConfig: '/fake/company-config.json' },
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

  it('omits AI config keys from backup output systemConfig (createBackup con implementación real, dependencias mockeadas)', async () => {
    const { createBackup } = await import('@/lib/backup');
    const result = await createBackup('test-company');

    const raw = Buffer.from(result.data, 'base64').toString('utf-8');
    const backupData = JSON.parse(raw);

    expect(backupData.data.systemConfig).toHaveLength(1);
    expect(backupData.data.systemConfig[0].key).toBe('normal_setting');
    expect(backupData.data.systemConfig[0].value).toBe('keep-me');
    expect(result.recordCounts.systemConfig).toBe(1);
  });
});
