import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryRows, queryNullMetadata, fixtureNullReferences } from './helpers';

const state = vi.hoisted(() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const parent = path.join(process.cwd(), 'tests/backup-company/.scratch');
  fs.mkdirSync(parent, { recursive: true });
  return { root: fs.mkdtempSync(path.join(parent, 'restore-')), rows: {} as Record<string, any[]>,
    writes: [] as string[], queries: [] as string[], failInsert: '', ambiguous: false,
    checkWrite: (_model: string, _operation: string, _rows: any[]) => {} };
});
vi.mock('@/lib/config/paths', () => ({ BACKUP_DIR: path.join(state.root, 'backups'),
  RUNTIME_FILES: { companyConfig: path.join(state.root, 'company-config.json') } }));
const database = vi.hoisted(() => new Proxy({}, {
  get: (_, model: string) => {
    if (model === '$transaction') return async (callback: any) => {
      const before = structuredClone(state.rows);
      try {
        const result = await callback(database);
        if (state.ambiguous) throw new Error('connection lost during COMMIT');
        return result;
      } catch (error) {
        if (!state.ambiguous) state.rows = before;
        throw error;
      }
    };
    if (model === '$queryRaw') return async (query: any) => {
      state.queries.push(query.strings.join('?'));
      if (query.strings.join('?').includes('IS NULL')) return queryNullMetadata(state.rows, query);
      return [{ id: 'tenant' }];
    };
    return {
      findMany: async (query: any = {}) => queryRows(state.rows, model, query),
      findUnique: async (query: any) => queryRows(state.rows, model, query)[0] ?? null,
      deleteMany: async ({ where }: any) => {
        state.writes.push(`delete:${model}`);
        const removed = queryRows(state.rows, model, { where });
        state.checkWrite(model, 'delete', removed);
        state.rows[model] = (state.rows[model] ?? []).filter(row => !removed.some(r => (r.id ?? r.companyId) === (row.id ?? row.companyId)));
        return { count: removed.length };
      },
      create: async ({ data }: any) => {
        state.writes.push(`create:${model}`);
        if (state.failInsert === model) throw new Error('insertion failed');
        state.checkWrite(model, 'create', [data]);
        const stored = Object.fromEntries(Object.entries(data).map(([key, value]) => [key,
          value && typeof value === 'object' && value.constructor?.name === 'DbNull' ? null : value]));
        (state.rows[model] ??= []).push(structuredClone(stored));
        return stored;
      },
      update: async ({ where, data }: any) => {
        state.writes.push(`update:${model}`);
        const row = state.rows[model]?.find(r => (r.id ?? r.companyId) === (where.id ?? where.companyId));
        Object.assign(row, data);
        return row;
      },
    };
  },
}));
vi.mock('@/lib/db', () => ({ db: database, withCompanyBackupTransaction: (callback: any, options: any) => (database as any).$transaction(callback, options) }));
vi.mock('@/lib/auth', () => ({ hashPassword: vi.fn(() => { throw new Error('auth must not run'); }) }));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
import { sealSnapshot, SNAPSHOT_SECTIONS } from '@/lib/backup-format';
import { previewCompanyRestore, restoreCompanyBackup, restoreCompanyBackupCoordinated, reconcileCompanyBackupRecovery } from '@/lib/backup-restore';
import { validateBackup } from '@/lib/backup';
import { computeEntryHashV2, computeAuditHash } from '@/lib/journal-hash';

const models: Record<string, string> = {
  company: 'Company', glAccounts: 'GlAccount', bankAccounts: 'BankAccount', bankStatements: 'BankStatement',
  bankTransactions: 'BankTransaction', bankRules: 'BankRule', journalEntries: 'JournalEntry', journalLines: 'JournalLine',
  fiscalPeriods: 'FiscalPeriod', companyMembers: 'CompanyMember', users: 'User', systemConfig: 'SystemConfig',
  reconciliationPeriods: 'ReconciliationPeriod', companyKnowledge: 'CompanyKnowledge', knowledgeAudit: 'KnowledgeAudit',
  systemMemories: 'SystemMemory', memoryItems: 'MemoryItem', memoryVersions: 'MemoryVersion', relationships: 'Relationship',
  contradictions: 'Contradiction', evolutionLinks: 'EvolutionLink', traceabilityLogs: 'TraceabilityLog', confidenceLogs: 'ConfidenceLog',
  entityContexts: 'EntityContext', detectionConfigs: 'DetectionConfig', companyModuleEntitlements: 'CompanyModuleEntitlement',
  csvLayoutProfiles: 'CsvLayoutProfile', ruleApplyRecords: 'RuleApplyRecord', ruleExecutionAudits: 'RuleExecutionAudit',
  auditLogs: 'AuditLog', pendingApprovals: 'PendingApproval',
};
const refs: Record<string, string> = {
  companyId: 'tenant', glAccountId: 'glAccounts', bankAccountId: 'bankAccounts', statementId: 'bankStatements',
  entryId: 'journalEntries', userId: 'users', knowledgeId: 'companyKnowledge', itemId: 'memoryItems',
  sourceId: 'memoryItems', targetId: 'memoryItems', itemAId: 'memoryItems', itemBId: 'memoryItems',
  supersededId: 'memoryItems', supersededById: 'memoryItems', transactionId: 'bankTransactions',
};
function row(section: string): any {
  const model = Prisma.dmmf.datamodel.models.find(m => m.name === models[section])!;
  return Object.fromEntries(model.fields.filter(f => f.kind !== 'object').map(f => {
    let value: any = null;
    if (f.name === 'companyId') value = 'tenant';
    else if (f.isList) value = [];
    else if (f.isRequired) {
      if (f.name === 'id') value = section === 'company' ? 'tenant' : section;
      else if (refs[f.name]) value = refs[f.name];
      else if (f.kind === 'enum') value = Prisma.dmmf.datamodel.enums.find(e => e.name === f.type)!.values[0].name;
      else value = ({ String: `${section}-${f.name}`, Int: 1, Float: 1, Boolean: false,
        Decimal: '1.00', DateTime: '2026-01-01T00:00:00.000Z', Json: {} } as any)[f.type];
    }
    return [f.name, value];
  }));
}
function fixture(): any {
  const data: any = Object.fromEntries(SNAPSHOT_SECTIONS.map(s => [s, s === 'systemConfig' ? [] : [row(s)]]));
  data.companyConfig = null;
  data.journalChainHead = null;
  data.users = [{ id: 'users', email: 'member@example.invalid', role: 'user' }];
  data.companyMembers[0].role = 'company_admin';
  data.journalEntries[0].status = 'draft';
  Object.assign(data.bankTransactions[0], { journalEntryId: 'journalEntries', journalLineId: 'journalLines', ruleApplyRecordId: 'ruleApplyRecords' });
  data.journalEntries[0].ruleApplyRecordId = 'ruleApplyRecords';
  data.ruleExecutionAudits[0].winnerRuleId = 'bankRules';
  data.knowledgeAudit[0].changedByUserId = 'system';
  data.pendingApprovals[0].requestedBy = 'system';
  data.pendingApprovals[0].payload = { companyId: 'tenant', knowledgeId: 'companyKnowledge' };
  const body = { manifest: { version: '2.1.0', fidelity: { monetary: 'decimal-18,2', jsonNulls: fixtureNullReferences(data, models) }, id: '11111111-1111-4111-8111-111111111111',
    createdAt: '2026-01-01T00:00:00.000Z', companyId: 'tenant',
    companyInfo: { id: 'tenant', legalName: data.company[0].legalName, taxId: data.company[0].taxId },
    recordCounts: { ...Object.fromEntries(SNAPSHOT_SECTIONS.map(s => [s, data[s].length])), companyConfig: false } }, data };
  sealSnapshot(body as any);
  return body;
}
function text(body: any) { sealSnapshot(body); return JSON.stringify(body); }
function files() {
  const walk = (dir: string): any[] => fs.readdirSync(dir).sort().flatMap(name => {
    const target = path.join(dir, name);
    return fs.statSync(target).isDirectory() ? walk(target) : [[path.relative(state.root, target), fs.readFileSync(target, 'utf8')]];
  });
  return walk(state.root);
}
let backup: any;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv('HMAC_SECRET', 'isolated-recovery-test-key');
  for (const name of fs.readdirSync(state.root)) fs.rmSync(path.join(state.root, name), { recursive: true, force: true });
  backup = fixture();
  state.rows = Object.fromEntries(Object.entries(models).map(([section, model]) => [model[0].toLowerCase() + model.slice(1), structuredClone(backup.data[section])]));
  state.rows.user = [{ id: 'users', email: 'member@example.invalid', passwordHash: 'destination-only', platformRole: 'super_admin' }];
  state.rows.company.push({ ...row('company'), id: 'other', legalName: 'Other company' });
  state.rows.glAccount.push({ ...row('glAccounts'), id: 'foreign-gl', companyId: 'other' });
  state.rows.systemConfig = [{ id: 'global', key: 'global', value: 'untouched' }];
  state.rows.bankProfile = [{ id: 'profile', bankId: 'global', config: 'untouched' }];
  state.rows.journalChainHead = [];
  state.rows.company[0].legalName = 'Before recovery';
  state.writes = []; state.queries = []; state.failInsert = ''; state.ambiguous = false;
  state.checkWrite = (model, operation, candidates) => {
    const target = Prisma.dmmf.datamodel.models.find(m => m.name[0].toLowerCase() + m.name.slice(1) === model)!;
    if (operation === 'create') {
      for (const relation of target.fields.filter(f => f.relationFromFields?.length)) {
        const parent = relation.type[0].toLowerCase() + relation.type.slice(1);
        for (const candidate of candidates) {
          if (relation.relationFromFields!.some(k => candidate[k] == null)) continue;
          if (!(state.rows[parent] ?? []).some(row => relation.relationFromFields!.every((k, i) => candidate[k] === row[relation.relationToFields![i]]))) {
            throw new Error(`adapter FK insertion order: ${model}.${relation.name}`);
          }
        }
      }
    } else {
      for (const child of Prisma.dmmf.datamodel.models) {
        const rows = state.rows[child.name[0].toLowerCase() + child.name.slice(1)] ?? [];
        for (const relation of child.fields.filter(f => f.type === target.name && f.relationFromFields?.length)) {
          if (rows.some(row => candidates.some(candidate => relation.relationFromFields!.every((k, i) => row[k] != null && row[k] === candidate[relation.relationToFields![i]])))) {
            throw new Error(`adapter FK deletion order: ${child.name}.${relation.name}`);
          }
        }
      }
    }
  };
  fs.writeFileSync(path.join(state.root, 'company-config.json'), JSON.stringify({ marker: 'global', companies: { other: { currency: 'USD' } } }));
});
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(state.root, { recursive: true, force: true }); });

async function rejected(body: any, error: string, raw?: string) {
  const before = structuredClone(state.rows), disk = files();
  const input = raw ?? text(body);
  if (!['RESTORE_FILES_REQUIRED', 'RESTORE_ASSETS_REQUIRED', 'safety unavailable'].includes(error)) {
    await expect(previewCompanyRestore('tenant', input)).rejects.toThrow(error);
    expect(state.rows).toEqual(before); expect(files()).toEqual(disk); expect(state.writes).toEqual([]);
  }
  await expect(restoreCompanyBackup('tenant', input)).rejects.toThrow(error);
  expect(state.rows).toEqual(before);
  expect(files()).toEqual(disk);
  expect(state.writes).toEqual([]);
}
describe('coordinated company configuration recovery', () => {
  it('journals original bytes, commits DB then config, and preserves other companies/global state', async () => {
    backup.data.companyConfig = { currency: 'ARS' };
    backup.manifest.recordCounts.companyConfig = true;
    const configPath = path.join(state.root, 'company-config.json');
    const before = fs.readFileSync(configPath);
    const result = await restoreCompanyBackupCoordinated('tenant', text(backup));
    expect(result.status).toBe('committed');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({ marker: 'global', companies: { other: { currency: 'USD' }, tenant: { currency: 'ARS' } } });
    const journal = JSON.parse(fs.readFileSync(path.join(state.root, 'backup-recovery', result.operationId + '.json'), 'utf8')).payload;
    expect(journal.files[0].before).toBe(before.toString('base64'));
    const safety = JSON.parse(fs.readFileSync(path.join(state.root, 'backups', result.safetyFilename), 'utf8'));
    expect(safety.data.companyConfig).toBe(null);
    expect(fs.existsSync(path.join(state.root, 'backup-maintenance', 'maintenance.json'))).toBe(false);
  });
  it('keeps maintenance closed and config unchanged after an ambiguous DB commit', async () => {
    backup.data.companyConfig = { currency: 'ARS' };
    backup.manifest.recordCounts.companyConfig = true;
    state.ambiguous = true;
    const configPath = path.join(state.root, 'company-config.json');
    const before = fs.readFileSync(configPath);
    const result = await restoreCompanyBackupCoordinated('tenant', text(backup));
    expect(result.status).toBe('reconciliation_required');
    expect(fs.readFileSync(configPath)).toEqual(before);
    expect(fs.existsSync(path.join(state.root, 'backup-maintenance', 'maintenance.json'))).toBe(true);
    expect(fs.existsSync(path.join(state.root, 'backup-recovery', result.operationId + '.json'))).toBe(true);
    state.ambiguous = false;
    const reconciled = await reconcileCompanyBackupRecovery('tenant', result.operationId);
    expect(reconciled.status).toBe('committed');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).companies.tenant).toEqual({ currency: 'ARS' });
    expect(fs.existsSync(path.join(state.root, 'backup-maintenance', 'maintenance.json'))).toBe(false);
  });
  it('reconciles a known rollback to original files without repeating the database replacement', async () => {
    backup.data.companyConfig = { currency: 'ARS' }; backup.manifest.recordCounts.companyConfig = true;
    state.failInsert = 'journalLine';
    const before = structuredClone(state.rows);
    const configPath = path.join(state.root, 'company-config.json');
    const original = fs.readFileSync(configPath);
    const result = await restoreCompanyBackupCoordinated('tenant', text(backup));
    expect(result.status).toBe('reconciliation_required');
    expect(state.rows).toEqual(before);
    state.failInsert = '';
    const writes = [...state.writes];
    const reconciled = await reconcileCompanyBackupRecovery('tenant', result.operationId);
    expect(reconciled.status).toBe('aborted');
    expect(state.writes).toEqual(writes);
    expect(state.rows).toEqual(before);
    expect(fs.readFileSync(configPath)).toEqual(original);
    expect(fs.existsSync(path.join(state.root, 'backup-maintenance', 'maintenance.json'))).toBe(false);
  });
});

describe('public company recovery core', () => {
  it('previews immutable exact IDs/counts and accounting links without any DB/file writes', async () => {
    const before = structuredClone(state.rows), disk = files(), original = JSON.stringify(backup);
    const preview = await previewCompanyRestore('tenant', JSON.stringify(backup));
    expect(preview.companyId).toBe('tenant');
    expect(preview.counts).toEqual(backup.manifest.recordCounts);
    expect(preview.ids.bankTransactions).toEqual(['bankTransactions']);
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.ids.bankTransactions)).toBe(true);
    expect(JSON.stringify(backup)).toBe(original);
    expect(state.rows).toEqual(before); expect(files()).toEqual(disk); expect(state.writes).toEqual([]);
  });

  it('restores every mandatory model, original accounting IDs and company metadata; shared/global/other-company state is unchanged', async () => {
    const shared = structuredClone({ user: state.rows.user, config: state.rows.systemConfig, bank: state.rows.bankProfile,
      company: state.rows.company[1], gl: state.rows.glAccount[1] });
    const config = fs.readFileSync(path.join(state.root, 'company-config.json'), 'utf8');
    const result = await restoreCompanyBackup('tenant', JSON.stringify(backup));
    expect(result.status).toBe('committed');
    expect(result.counts).toEqual(backup.manifest.recordCounts);
    for (const [section, model] of Object.entries(models)) {
      if (['users', 'systemConfig'].includes(section)) continue;
      const rows = state.rows[model[0].toLowerCase() + model.slice(1)];
      const normalize = (v: any) => JSON.parse(JSON.stringify(v));
      for (const source of backup.data[section]) expect(normalize(rows.find((r: any) => (r.id ?? r.companyId) === (source.id ?? source.companyId)))).toEqual(source);
    }
    expect({ user: state.rows.user, config: state.rows.systemConfig, bank: state.rows.bankProfile,
      company: state.rows.company.find(r => r.id === 'other'), gl: state.rows.glAccount.find(r => r.id === 'foreign-gl') }).toEqual(shared);
    expect(fs.readFileSync(path.join(state.root, 'company-config.json'), 'utf8')).toBe(config);
    const safety = JSON.parse(fs.readFileSync(path.join(state.root, 'backups', result.safetyFilename), 'utf8'));
    expect(safety.data.company[0].legalName).toBe('Before recovery');
    expect(safety.data.bankTransactions[0].journalLineId).toBe('journalLines');
    expect(state.queries.some(q => q.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(state.queries.some(q => q.includes('FOR UPDATE'))).toBe(true);
  });

  it.each(['version', 'truncated', 'checksum', 'count', 'section', 'tenant', 'identity', 'field', 'type', 'duplicate', 'unique', 'foreign', 'nested', 'missing-user', 'conflict', 'inbound', 'config', 'asset', 'hash'])('rejects %s before mutations and safety publication', async kind => {
    if (kind === 'version') backup.manifest.version = '9.0.0';
    if (kind === 'count') { backup.manifest.recordCounts.journalLines = 77; }
    if (kind === 'section') delete backup.data.csvLayoutProfiles;
    if (kind === 'tenant') backup.data.bankAccounts[0].companyId = 'other';
    if (kind === 'identity') backup.manifest.companyInfo.legalName = 'Forged';
    if (kind === 'field') backup.data.company[0].unknown = true;
    if (kind === 'type') backup.data.company[0].isActive = 'yes';
    if (kind === 'duplicate') { backup.data.journalLines.push(backup.data.journalLines[0]); backup.manifest.recordCounts.journalLines++; }
    if (kind === 'unique') { backup.data.glAccounts.push({ ...backup.data.glAccounts[0], id: 'duplicate-code' }); backup.manifest.recordCounts.glAccounts++; }
    if (kind === 'foreign') backup.data.journalLines[0].glAccountId = 'foreign-gl';
    if (kind === 'nested') backup.data.journalEntries[0].lines = [{ ...backup.data.journalLines[0], glAccountId: 'foreign-gl' }];
    if (kind === 'missing-user') state.rows.user = [];
    if (kind === 'conflict') state.rows.glAccount[1].id = 'glAccounts';
    if (kind === 'inbound') state.rows.journalLine.push({ ...row('journalLines'), id: 'outside-line', entryId: 'outside-entry' }), state.rows.journalEntry.push({ ...row('journalEntries'), id: 'outside-entry', companyId: 'other' });
    if (kind === 'config') { backup.data.companyConfig = { currency: 'ARS' }; backup.manifest.recordCounts.companyConfig = true; }
    if (kind === 'asset') backup.data.company[0].logo = '/uploads/logos/absent.png';
    if (kind === 'hash') { backup.data.journalEntries[0].status = 'posted'; backup.data.journalEntries[0].hash = '0'.repeat(64); backup.data.journalEntries[0].hashVersion = 'v2'; }
    const errors: Record<string, string> = { version: 'Unsupported', truncated: 'JSON', checksum: 'checksum', count: 'count',
      section: 'section', tenant: 'tenant', identity: 'RESTORE_IDENTITY', field: 'RESTORE_SCHEMA', type: 'RESTORE_SCHEMA',
      duplicate: 'RESTORE_UNIQUE', unique: 'RESTORE_UNIQUE', foreign: 'RESTORE_REFERENCE', nested: 'RESTORE_NESTED',
      'missing-user': 'RESTORE_MISSING_IDENTITY', conflict: 'RESTORE_ID_CONFLICT', inbound: 'RESTORE_INBOUND',
      config: 'RESTORE_FILES_REQUIRED', asset: 'RESTORE_ASSETS_REQUIRED', hash: 'RESTORE_CHAIN' };
    await rejected(backup, errors[kind], kind === 'truncated' ? '{' : kind === 'checksum' ? JSON.stringify({ ...backup, data: { ...backup.data, company: [{ ...backup.data.company[0], legalName: 'bad' }] } }) : undefined);
  });

  it('rejects unsafe numeric monetary values rather than accepting lossy Decimal-to-Number exports', async () => {
    backup.data.glAccounts[0].balance = 2 ** 45;
    await rejected(backup, 'RESTORE_SCHEMA');
  });

  it('rejects a different selected company and an ID/email identity collision without side effects', async () => {
    const before = structuredClone(state.rows), disk = files();
    await expect(previewCompanyRestore('other', text(backup))).rejects.toThrow('RESTORE_IDENTITY');
    await expect(restoreCompanyBackup('other', text(backup))).rejects.toThrow('RESTORE_IDENTITY');
    expect(state.rows).toEqual(before); expect(files()).toEqual(disk); expect(state.writes).toEqual([]);
    state.rows.user[0].email = 'different@example.invalid';
    await rejected(backup, 'RESTORE_MISSING_IDENTITY');
  });

  it('refuses replacement when the destination logo cannot be captured in the safety archive', async () => {
    state.rows.company[0].logo = '/uploads/logos/current-only.png';
    await rejected(backup, 'RESTORE_ASSETS_REQUIRED');
  });

  it('fails before writes if safety publication fails', async () => {
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => { throw new Error('safety unavailable'); });
    await rejected(backup, 'safety unavailable');
  });

  it('rolls back DB insertion failure while retaining the consistent safety backup and unchanged runtime configuration', async () => {
    const before = structuredClone(state.rows), config = fs.readFileSync(path.join(state.root, 'company-config.json'), 'utf8');
    state.failInsert = 'journalLine';
    const result = await restoreCompanyBackup('tenant', JSON.stringify(backup));
    expect(result.status).toBe('not_confirmed');
    expect(result.error).toContain('insertion failed');
    expect(state.rows).toEqual(before);
    expect(fs.readFileSync(path.join(state.root, 'company-config.json'), 'utf8')).toBe(config);
    expect(fs.existsSync(path.join(state.root, 'backups', result.safetyFilename!))).toBe(true);
  });

  it('reports commit ambiguity honestly and never replays configuration after a later operation', async () => {
    state.ambiguous = true;
    const result = await restoreCompanyBackup('tenant', JSON.stringify(backup));
    expect(result.status).toBe('not_confirmed');
    expect(result.error).toContain('COMMIT');
    expect(state.rows.company[0].legalName).toBe(backup.data.company[0].legalName);
    state.ambiguous = false;
    const changed = JSON.stringify({ companies: { tenant: { currency: 'EUR' }, other: { currency: 'USD' } } });
    fs.writeFileSync(path.join(state.root, 'company-config.json'), changed);
    await previewCompanyRestore('tenant', JSON.stringify(backup));
    expect(fs.readFileSync(path.join(state.root, 'company-config.json'), 'utf8')).toBe(changed);
  });

  it.each(Object.entries(models).flatMap(([section, model]) =>
    Prisma.dmmf.datamodel.models.find(m => m.name === model)!.fields
      .filter(f => f.kind === 'object' && f.relationFromFields?.length && f.type !== 'Company')
      .flatMap(f => f.relationFromFields!.map(field => [section, field]))
  ))('rejects forged FK %s.%s even if the checksum is recomputed', async (section, field) => {
    backup.data[section][0][field] = 'forged-foreign-id';
    await rejected(backup, 'RESTORE_REFERENCE');
  });

  it.each(['payload-company', 'payload-knowledge', 'line-pair', 'credentials', 'cycle', 'global-unique'])('rejects operational %s conflicts without side effects', async kind => {
    if (kind === 'payload-company') backup.data.pendingApprovals[0].payload.companyId = 'other';
    if (kind === 'payload-knowledge') backup.data.pendingApprovals[0].payload.knowledgeId = 'foreign-knowledge';
    if (kind === 'line-pair') {
      backup.data.journalEntries.push({ ...backup.data.journalEntries[0], id: 'another-entry' });
      backup.manifest.recordCounts.journalEntries++;
      backup.data.bankTransactions[0].journalEntryId = 'another-entry';
    }
    if (kind === 'credentials') backup.data.users[0].passwordHash = 'must-never-be-restored';
    if (kind === 'cycle') backup.data.glAccounts[0].parentId = backup.data.glAccounts[0].id;
    if (kind === 'global-unique') state.rows.ruleApplyRecord.push({ ...state.rows.ruleApplyRecord[0], id: 'other-application', companyId: 'other' });
    await rejected(backup, kind === 'credentials' ? 'RESTORE_SCHEMA' : kind === 'global-unique' ? 'RESTORE_UNIQUE' : 'RESTORE_REFERENCE');
  });

  it('certifies and preserves original v2 journal HMAC/head and stored audit HMAC without re-signing', async () => {
    const entry = backup.data.journalEntries[0];
    entry.status = 'posted'; entry.hashVersion = 'v2';
    entry.hash = computeEntryHashV2({ ...entry, lines: backup.data.journalLines });
    backup.data.journalChainHead = { companyId: 'tenant', lastHash: entry.hash, lastEntryId: entry.id };
    const audit = backup.data.auditLogs[0];
    audit.hash = computeAuditHash(audit);
    const result = await restoreCompanyBackup('tenant', text(backup));
    expect(result.status).toBe('committed');
    expect(state.rows.journalEntry[0].hash).toBe(entry.hash);
    expect(state.rows.journalChainHead[0]).toEqual(backup.data.journalChainHead);
    expect(state.rows.auditLog.find(r => r.id === audit.id)?.hash).toBe(audit.hash);
    expect(state.rows.auditLog.find(r => r.id === result.operationId)).toMatchObject({ action: 'COMPANY_RESTORE_COMMITTED' });
  });

  it('rejects a replacement that would break another company’s installation-wide audit chain', async () => {
    const current = state.rows.auditLog[0];
    current.hash = computeAuditHash(current);
    const outside = { ...current, id: 'foreign-audit', companyId: 'other', createdAt: '2026-01-02T00:00:00.000Z', previousHash: current.hash };
    outside.hash = computeAuditHash(outside);
    state.rows.auditLog.push(outside);
    await rejected(backup, 'RESTORE_CHAIN');
  });

  it('refuses a source signing-key mismatch instead of auto-resigning', async () => {
    const entry = backup.data.journalEntries[0];
    entry.status = 'posted'; entry.hashVersion = 'v2';
    entry.hash = computeEntryHashV2({ ...entry, lines: backup.data.journalLines });
    backup.data.journalChainHead = { companyId: 'tenant', lastHash: entry.hash, lastEntryId: entry.id };
    vi.stubEnv('HMAC_SECRET', 'different-isolated-destination-key');
    await rejected(backup, 'RESTORE_CHAIN');
  });

  it('restores nullable self-links in two passes regardless of input ordering', async () => {
    backup.data.glAccounts.push({ ...backup.data.glAccounts[0], id: 'parent-gl', code: 'parent-code' });
    backup.data.glAccounts[0].parentId = 'parent-gl'; backup.manifest.recordCounts.glAccounts++;
    backup.data.companyKnowledge.push({ ...backup.data.companyKnowledge[0], id: 'merged-target' });
    backup.data.companyKnowledge[0].mergedIntoId = 'merged-target'; backup.manifest.recordCounts.companyKnowledge++;
    const result = await restoreCompanyBackup('tenant', text(backup));
    expect(result.status).toBe('committed');
    expect(state.rows.glAccount.find(r => r.id === 'glAccounts')?.parentId).toBe('parent-gl');
    expect(state.rows.companyKnowledge.find(r => r.id === 'companyKnowledge')?.mergedIntoId).toBe('merged-target');
  });

  it.each(['flush', 'index'])('does not start DB writes when safety %s fails', async kind => {
    const before = structuredClone(state.rows);
    if (kind === 'flush') vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('safety flush failed'); });
    else vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('safety index failed'); });
    await expect(restoreCompanyBackup('tenant', text(backup))).rejects.toThrow(`safety ${kind}`);
    expect(state.rows).toEqual(before); expect(state.writes).toEqual([]);
    const names = fs.readdirSync(path.join(state.root, 'backups'));
    expect(names.filter(n => n.endsWith('.tmp'))).toEqual([]);
    expect(names.filter(n => n.endsWith('.json'))).toHaveLength(kind === 'index' ? 1 : 0);
  });

  it('preserves matching company configuration without rewriting any slice', async () => {
    const config = { companies: { tenant: { currency: 'ARS' }, other: { currency: 'USD' } }, marker: 'global' };
    fs.writeFileSync(path.join(state.root, 'company-config.json'), JSON.stringify(config));
    backup.data.companyConfig = config.companies.tenant; backup.manifest.recordCounts.companyConfig = true;
    const result = await restoreCompanyBackup('tenant', text(backup));
    expect(result.status).toBe('committed');
    expect(JSON.parse(fs.readFileSync(path.join(state.root, 'company-config.json'), 'utf8'))).toEqual(config);
  });

  it('previews differing configuration as a blocker and never tries to update that shared file', async () => {
    backup.data.companyConfig = { currency: 'ARS' }; backup.manifest.recordCounts.companyConfig = true;
    const before = files();
    const preview = await previewCompanyRestore('tenant', text(backup));
    expect(preview.blockers[0]).toContain('RESTORE_FILES_REQUIRED');
    expect(files()).toEqual(before); expect(state.writes).toEqual([]);
  });

  it('preserves legacy validator acceptance and keeps v2 out of legacy/bootstrap restore', () => {
    const old = structuredClone(backup); old.manifest.version = '1.1.0';
    expect(validateBackup(old)).toEqual({ valid: true, errors: [] });
    expect(validateBackup(backup).valid).toBe(false);
  });
});
