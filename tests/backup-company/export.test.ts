import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryRows, queryNullMetadata } from './helpers';

const state = vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const parent = path.join(process.cwd(), 'tests/backup-company/.scratch');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'export-'));
  return { root, rows: {} as Record<string, any[]>, reads: [] as string[],
    sqlNulls: {} as Record<string, boolean>, metadataReads: [] as string[],
    inTransaction: false, transaction: vi.fn() };
});
vi.mock('@/lib/config/paths', () => ({
  BACKUP_DIR: path.join(state.root, 'backups'),
  RUNTIME_FILES: { companyConfig: path.join(state.root, 'company-config.json') },
}));
const database = vi.hoisted(() => new Proxy({}, {
  get: (_, model: string) => model === '$transaction' ? state.transaction : model === '$queryRaw' ? async (query: any) => {
    if (!state.inTransaction) throw new Error('Metadata read outside snapshot');
    state.metadataReads.push(query.strings.join('?'));
    return queryNullMetadata(state.rows, query, state.sqlNulls);
  } : {
    findMany: vi.fn(async (query: any) => {
      if (!state.inTransaction) throw new Error('Database read outside snapshot');
      state.reads.push(model);
      return queryRows(state.rows, model, query);
    }),
    findUnique: vi.fn(async (query: any) => {
      if (!state.inTransaction) throw new Error('Database read outside snapshot');
      state.reads.push(model);
      return queryRows(state.rows, model, query)[0] ?? null;
    }),
  },
}));
vi.mock('@/lib/db', () => ({ db: database, withCompanyBackupTransaction: (callback: any, options: any) => state.transaction(callback, options) }));
vi.mock('@/lib/auth', () => ({ hashPassword: vi.fn(() => { throw new Error('auth must not run'); }) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
import { createBackup, listBackups, getBackupFile, deleteBackup, validateBackup } from '@/lib/backup';

const dir = path.join(state.root, 'backups');
const config = path.join(state.root, 'company-config.json');
function files() { return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []; }
function payload(result: Awaited<ReturnType<typeof createBackup>>) {
  return JSON.parse(Buffer.from(result.data, 'base64').toString('utf8'));
}
function snapshot() {
  return files().map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
}
beforeEach(() => {
  vi.restoreAllMocks();
  for (const name of fs.readdirSync(state.root)) fs.rmSync(path.join(state.root, name), { recursive: true, force: true });
  state.reads = []; state.sqlNulls = {}; state.metadataReads = [];
  state.rows = {
    company: [{ id: 'tenant', legalName: 'Ñandú 日本 🦜', taxId: null }],
    entityContext: [{ id: 'ctx', companyId: 'tenant', pattern: 'Árbol' }],
    detectionConfig: [{ companyId: 'tenant', threshold: 0.75 }],
    companyModuleEntitlement: [{ id: 'entitlement', companyId: 'tenant', moduleKey: 'accounting', enabled: true }],
    csvLayoutProfile: [{ id: 'csv', companyId: 'tenant', fingerprint: 'utf8' }],
    ruleApplyRecord: [{ id: 'apply', companyId: 'tenant', userId: 'actor' }],
    auditLog: [{ id: 'audit', companyId: 'tenant', userId: 'actor' }],
    pendingApproval: [{ id: 'pending', companyId: 'tenant', payload: { label: 'é' } }],
    user: [{ id: 'actor', email: 'actor@example.invalid', platformRole: 'user', passwordHash: 'fixture-only-do-not-export' }],
    systemConfig: [{ id: 'global', key: 'global-setting', value: 'must-not-export' }],
    bankStatement: [{ id: 'statement', companyId: 'tenant' }],
    bankTransaction: [{ id: 'transaction', statementId: 'statement', journalEntryId: 'entry', journalLineId: 'line', ruleApplyRecordId: 'apply' }],
    journalEntry: [{ id: 'entry', companyId: 'tenant', ruleApplyRecordId: 'apply' }],
    journalLine: [{ id: 'line', entryId: 'entry', glAccountId: 'gl', debit: '10.01' }],
    glAccount: [{ id: 'gl', companyId: 'tenant', balance: '10.01' }],
  };
  state.inTransaction = false;
  state.transaction.mockReset().mockImplementation(async (callback: any) => {
    state.inTransaction = true;
    try { return await callback(database); }
    finally { state.inTransaction = false; }
  });
  fs.writeFileSync(config, JSON.stringify({ companies: { tenant: { currency: 'ARS', periodType: 'monthly' }, other: { currency: 'USD' } } }));
});
afterAll(() => fs.rmSync(state.root, { recursive: true, force: true }));

describe('company snapshot and publication', () => {
  it('exports explicit tenant inventory with stable IDs/counts and exact UTF8 in one repeatable-read transaction', async () => {
    const result = await createBackup('tenant');
    const body = payload(result);
    expect(state.transaction).toHaveBeenCalledTimes(1);
    expect(state.transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: 'RepeatableRead' });
    for (const [section, id] of Object.entries({ entityContexts: 'ctx', companyModuleEntitlements: 'entitlement', csvLayoutProfiles: 'csv', ruleApplyRecords: 'apply', auditLogs: 'audit', pendingApprovals: 'pending' })) {
      expect(body.data[section][0].id).toBe(id);
      expect(body.manifest.recordCounts[section]).toBe(1);
    }
    expect(body.data.detectionConfigs).toEqual(state.rows.detectionConfig);
    expect(body.data.bankTransactions).toEqual(state.rows.bankTransaction);
    expect(body.data.journalLines).toEqual(state.rows.journalLine);
    expect(body.data.users[0].id).toBe('actor');
    expect(body.data.users[0]).not.toHaveProperty('passwordHash');
    expect(body.manifest.recordCounts.systemConfig).toBe(0);
    expect(body.data.companyConfig).toEqual({ currency: 'ARS', periodType: 'monthly' });
    expect(body.data.systemConfig).toEqual([]);
    expect(state.reads).not.toContain('systemConfig');
    const raw = fs.readFileSync(path.join(dir, result.filename));
    expect(raw.equals(Buffer.from(result.data, 'base64'))).toBe(true);
    expect(raw.toString('utf8')).toContain('Ñandú 日本 🦜');
    expect(result.size).toBe(raw.length);
    expect(body.manifest.version).toBe('2.1.0');
    expect(body.manifest.fidelity).toEqual({ monetary: 'decimal-18,2', jsonNulls: [] });
    expect(body.manifest.integrity.authenticated).toBe(false);
    expect(body.manifest.integrity.digest).toBe(crypto.createHash('sha256').update(JSON.stringify({ manifest: { ...body.manifest, integrity: undefined }, data: body.data }), 'utf8').digest('hex'));
    expect(listBackups('tenant')[0]).toMatchObject({ id: result.id, filename: result.filename, size: raw.length });
    expect(files()).toEqual([result.filename, 'manifest.json'].sort());
  });

  it('exports full-range monetary values as canonical strings without a Number intermediate', async () => {
    const amounts = ['9999999999999999.99', '0.01', '-9999999999999999.99', '-0.01', '0'];
    state.rows.glAccount = amounts.map((balance, i) => ({ ...state.rows.glAccount[0], id: i === 0 ? 'gl' : `gl-${i}`, balance }));
    state.rows.bankTransaction[0].amount = '9999999999999999.99';
    const before = structuredClone(state.rows);
    const saved = await createBackup('tenant');
    const body = payload(saved);
    expect(body.data.glAccounts.map((row: any) => row.balance)).toEqual([
      '9999999999999999.99', '0.01', '-9999999999999999.99', '-0.01', '0.00',
    ]);
    expect(body.data.bankTransactions[0].amount).toBe('9999999999999999.99');
    expect(body.manifest.recordCounts.glAccounts).toBe(5);
    expect(getBackupFile(saved.filename)?.data).toBe(Buffer.from(saved.data, 'base64').toString('utf8'));
    expect(state.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
    expect(state.rows).toEqual(before);
  });

  it('exports explicit SQL NULL and JSON null provenance for all nullable JSON columns in the same snapshot', async () => {
    state.rows.bankRule = [
      { id: 'rule-sql', companyId: 'tenant', conditions: null },
      { id: 'rule-json', companyId: 'tenant', conditions: null },
      { id: 'rule-nested', companyId: 'tenant', conditions: { nested: null, list: [null] } },
    ];
    state.rows.companyKnowledge = [{ id: 'knowledge', companyId: 'tenant', metadata: { nested: null } }];
    state.rows.knowledgeAudit = [
      { id: 'audit-sql', knowledgeId: 'knowledge', beforeValue: null, afterValue: null },
      { id: 'audit-json', knowledgeId: 'knowledge', beforeValue: null, afterValue: null },
    ];
    state.sqlNulls = {
      'BankRule:rule-sql:conditions': true, 'BankRule:rule-json:conditions': false,
      'KnowledgeAudit:audit-sql:beforeValue': true, 'KnowledgeAudit:audit-sql:afterValue': false,
      'KnowledgeAudit:audit-json:beforeValue': false, 'KnowledgeAudit:audit-json:afterValue': true,
    };
    const before = structuredClone(state.rows);
    const body = payload(await createBackup('tenant'));
    expect(body.manifest.fidelity).toEqual({ monetary: 'decimal-18,2', jsonNulls: [
      { model: 'BankRule', key: { id: 'rule-sql' }, field: 'conditions', kind: 'db-null' },
      { model: 'BankRule', key: { id: 'rule-json' }, field: 'conditions', kind: 'json-null' },
      { model: 'KnowledgeAudit', key: { id: 'audit-sql' }, field: 'beforeValue', kind: 'db-null' },
      { model: 'KnowledgeAudit', key: { id: 'audit-sql' }, field: 'afterValue', kind: 'json-null' },
      { model: 'KnowledgeAudit', key: { id: 'audit-json' }, field: 'beforeValue', kind: 'json-null' },
      { model: 'KnowledgeAudit', key: { id: 'audit-json' }, field: 'afterValue', kind: 'db-null' },
    ] });
    expect(body.data.bankRules[2].conditions).toEqual({ nested: null, list: [null] });
    expect(body.data.companyKnowledge[0].metadata).toEqual({ nested: null });
    expect(state.metadataReads).toHaveLength(2);
    expect(state.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
    expect(state.rows).toEqual(before);
  });

  it('preserves Company not found and publishes nothing for an absent company', async () => {
    state.rows.company = [];
    await expect(createBackup('tenant')).rejects.toThrow('Company not found');
    expect(files()).toEqual([]);
  });

  it('propagates database snapshot failure without publishing any history', async () => {
    state.transaction.mockRejectedValueOnce(new Error('snapshot unavailable'));
    await expect(createBackup('tenant')).rejects.toThrow('snapshot unavailable');
    expect(files()).toEqual([]);
  });

  it('does not make mandatory v2 data silently restorable by the old restore', async () => {
    const body = payload(await createBackup('tenant'));
    expect(validateBackup(body)).toEqual({ valid: false, errors: ['Backup format 2.1.0 requires the company recovery implementation; legacy restore is not supported'] });
  });

  it('creates unique names under an identical clock and preserves the first bytes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const first = await createBackup('tenant');
      const before = fs.readFileSync(path.join(dir, first.filename), 'utf8');
      const second = await createBackup('tenant');
      expect(second.filename).not.toBe(first.filename);
      expect(fs.readFileSync(path.join(dir, first.filename), 'utf8')).toBe(before);
      expect(listBackups('tenant')).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('rejects invalid tenant filenames before database or filesystem effects', async () => {
    const before = snapshot();
    await expect(createBackup('../escape')).rejects.toThrow('Invalid company identifier');
    expect(state.transaction).not.toHaveBeenCalled();
    expect(state.reads).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('fails rather than omit corrupt company configuration', async () => {
    fs.writeFileSync(config, '{broken');
    await expect(createBackup('tenant')).rejects.toThrow();
    expect(files()).toEqual([]);
  });

  it('rejects config changing during the database snapshot without publication', async () => {
    state.transaction.mockImplementationOnce(async (callback: any) => {
      state.inTransaction = true;
      try {
        const result = await callback(database);
        fs.writeFileSync(config, JSON.stringify({ companies: { tenant: { currency: 'EUR' } } }));
        return result;
      } finally { state.inTransaction = false; }
    });
    await expect(createBackup('tenant')).rejects.toThrow('Company configuration changed during snapshot');
    expect(files()).toEqual([]);
  });

  it.each([
    ['relationship', { id: 'edge', sourceId: 'outside', targetId: 'inside' }],
    ['contradiction', { id: 'edge', itemAId: 'outside', itemBId: 'inside' }],
    ['evolutionLink', { id: 'edge', supersededId: 'outside', supersededById: 'inside' }],
  ])('rejects inbound cross-tenant %s edges without changing history or database rows', async (model, edge) => {
    state.rows.memoryItem = [{ id: 'inside', companyId: 'tenant' }, { id: 'outside', companyId: 'other' }];
    state.rows[model as string] = [edge];
    const before = snapshot();
    const rowsBefore = structuredClone(state.rows);
    await expect(createBackup('tenant')).rejects.toThrow('cross-tenant');
    expect(snapshot()).toEqual(before);
    expect(state.rows).toEqual(rowsBefore);
  });

  it('exports only selected-company rows and both endpoints of its closed memory graph', async () => {
    state.rows.entityContext.push({ id: 'other-context', companyId: 'other', pattern: 'private' });
    state.rows.memoryItem = [
      { id: 'left', companyId: 'tenant' }, { id: 'right', companyId: 'tenant' },
      { id: 'outside', companyId: 'other' },
    ];
    state.rows.relationship = [
      { id: 'owned', sourceId: 'left', targetId: 'right' },
      { id: 'foreign', sourceId: 'outside', targetId: 'outside' },
    ];
    const rowsBefore = structuredClone(state.rows);
    const body = payload(await createBackup('tenant'));
    expect(body.data.entityContexts.map((row: any) => row.id)).toEqual(['ctx']);
    expect(body.data.memoryItems.map((row: any) => row.id)).toEqual(['left', 'right']);
    expect(body.data.relationships.map((row: any) => row.id)).toEqual(['owned']);
    expect(body.manifest.recordCounts.relationships).toBe(1);
    expect(state.rows).toEqual(rowsBefore);
  });

  it.each(['write', 'flush'])('preserves history when file %s fails before publication', async failure => {
    const saved = await createBackup('tenant');
    const before = snapshot();
    if (failure === 'write') {
      vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('disk full'); });
    } else {
      vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('flush failed'); });
    }
    await expect(createBackup('tenant')).rejects.toThrow(failure === 'write' ? 'disk full' : 'flush failed');
    expect(snapshot()).toEqual(before);
    expect(getBackupFile(saved.filename)).not.toBeNull();
  });

  it('does not publish a partial file when publication is interrupted', async () => {
    const before = snapshot();
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => { throw new Error('publication interrupted'); });
    await expect(createBackup('tenant')).rejects.toThrow('publication interrupted');
    expect(snapshot()).toEqual(before);
  });

  it('never overwrites an existing final file on collision', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
    const first = await createBackup('tenant');
    const before = snapshot();
    await expect(createBackup('tenant')).rejects.toThrow();
    expect(snapshot()).toEqual(before);
    expect(getBackupFile(first.filename)).not.toBeNull();
  });
});

describe('recoverable catalog and existing read/delete contracts', () => {
  it.each(['missing', 'corrupt'])('recovers stable owned records from files when index is %s', async mode => {
    const saved = await createBackup('tenant');
    if (mode === 'missing') fs.unlinkSync(path.join(dir, 'manifest.json'));
    else fs.writeFileSync(path.join(dir, 'manifest.json'), '{broken');
    const before = snapshot();
    expect(listBackups('tenant')[0]).toMatchObject({ id: saved.id, filename: saved.filename, recordCounts: saved.recordCounts });
    expect(listBackups('other')).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('retains a complete discoverable file and reports an index failure truthfully', async () => {
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('index unavailable'); });
    await expect(createBackup('tenant')).rejects.toThrow('index unavailable');
    expect(listBackups('tenant')).toHaveLength(1);
    expect(files().filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('reports storage failure instead of empty history', () => {
    fs.mkdirSync(dir);
    vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => { throw new Error('storage unavailable'); });
    expect(() => listBackups('tenant')).toThrow('storage unavailable');
  });

  it('rejects corruption and count tampering without rewriting files or index', async () => {
    const saved = await createBackup('tenant');
    const body = payload(saved);
    body.data.company[0].legalName = 'tampered';
    fs.writeFileSync(path.join(dir, saved.filename), JSON.stringify(body));
    const before = snapshot();
    expect(() => listBackups('tenant')).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('preserves get exact string/size and null for missing or escaped paths', async () => {
    const saved = await createBackup('tenant');
    const text = Buffer.from(saved.data, 'base64').toString('utf8');
    expect(getBackupFile(saved.filename)).toEqual({ data: text, size: Buffer.byteLength(text) });
    expect(getBackupFile('missing.json')).toBeNull();
    expect(getBackupFile('../company-config.json')).toBeNull();
    expect(getBackupFile('..\\company-config.json')).toBeNull();
  });

  it('rejects symlink files for read/delete without following or mutating them', async () => {
    const saved = await createBackup('tenant');
    const before = snapshot();
    const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: any, ...args: any[]) => {
      const stat = (original as any)(target, ...args);
      return String(target).endsWith(saved.filename) ? { ...stat, isSymbolicLink: () => true } : stat;
    }) as any);
    expect(() => getBackupFile(saved.filename)).toThrow();
    expect(() => deleteBackup(saved.filename, 'tenant')).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('preserves delete status and tenant ownership, then removes exactly its file/index entry', async () => {
    const saved = await createBackup('tenant');
    const before = snapshot();
    expect(deleteBackup('../bad.json', 'tenant')).toEqual({ status: 'invalid' });
    expect(deleteBackup(saved.filename, 'other')).toEqual({ status: 'not_found' });
    expect(snapshot()).toEqual(before);
    expect(deleteBackup(saved.filename, 'tenant')).toEqual({ status: 'deleted' });
    expect(getBackupFile(saved.filename)).toBeNull();
    expect(listBackups('tenant')).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).backups).toEqual([]);
    expect(deleteBackup(saved.filename, 'tenant')).toEqual({ status: 'not_found' });
  });

  it.each(['count', 'section', 'version', 'tenant', 'truncation'])('rejects %s damage without catalog mutation', async damage => {
    const saved = await createBackup('tenant');
    const body = payload(saved);
    if (damage === 'count') body.manifest.recordCounts.entityContexts = 99;
    if (damage === 'section') delete body.data.csvLayoutProfiles;
    if (damage === 'version') body.manifest.version = '999.0.0';
    if (damage === 'tenant') body.manifest.companyId = 'other';
    fs.writeFileSync(path.join(dir, saved.filename), damage === 'truncation' ? '{' : JSON.stringify(body));
    const before = snapshot();
    expect(() => listBackups('tenant')).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it('preserves legacy JSON catalog/read/delete and structural validation', async () => {
    const body = payload(await createBackup('tenant'));
    body.manifest.version = '1.1.0';
    delete body.manifest.integrity;
    fs.writeFileSync(path.join(dir, 'legacy.json'), JSON.stringify(body));
    const previous = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    previous.backups.push({ id: 'legacy-id', filename: 'legacy.json', companyId: 'tenant', createdAt: body.manifest.createdAt, companyLegalName: 'Legacy', size: 1, recordCounts: body.manifest.recordCounts });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(previous));
    expect(validateBackup(body)).toEqual({ valid: true, errors: [] });
    expect(listBackups('tenant').find(row => row.filename === 'legacy.json')?.id).toBe('legacy-id');
    expect(getBackupFile('legacy.json')?.data).toBe(JSON.stringify(body));
    expect(deleteBackup('legacy.json', 'tenant')).toEqual({ status: 'deleted' });
  });
});
