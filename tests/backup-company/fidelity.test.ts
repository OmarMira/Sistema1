import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { queryRows } from './helpers';
import { createMaintenanceGate, type MaintenanceGate } from '../../src/lib/backup-maintenance.mjs';

const state = vi.hoisted(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic/accountexpress_test');
  const fs = require('node:fs'), path = require('node:path');
  const parent = path.resolve('tests/backup-company/.scratch');
  fs.mkdirSync(parent, { recursive: true });
  return { root: fs.mkdtempSync(path.join(parent, 'fidelity-')), rows: {} as Record<string, any[]>,
    nulls: {} as Record<string, boolean>, gate: null as unknown as MaintenanceGate,
    queries: [] as any[], options: [] as any[], writes: [] as any[], metadataFailure: false, metadataMode: '' };
});
vi.mock('@/lib/config/paths', () => ({ BACKUP_DIR: path.join(state.root, 'backups'),
  RUNTIME_FILES: { companyConfig: path.join(state.root, 'company-config.json') } }));
vi.mock('@/lib/auth', () => ({ hashPassword: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { slowQuery: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/metrics', () => ({ trackQueryDuration: vi.fn() }));
vi.mock('@/lib/backup-runtime-maintenance', () => ({ withRuntimeOperation: (fn: () => unknown) => state.gate.withRuntimeOperation(fn) }));
vi.mock('@prisma/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@prisma/client')>();
  class PrismaClient {
    $on() {}
    $extends(extension: any) { return client(extension.result); }
    $transaction(callback: any, options: any) {
      state.options.push(options);
      return callback(client());
    }
  }
  function client(overrides?: any): any {
    return new Proxy(new PrismaClient(), { get(target, model: string) {
      if (model in target) return (target as any)[model].bind(target);
      if (model === '$queryRaw' && state.metadataMode === 'missing-operation') return undefined;
      if (model === '$queryRaw') return async (query: any) => {
        state.queries.push(query);
        const sql = query.strings.join('?');
        if (sql.includes('pg_advisory')) return [];
        if (sql.includes('FOR UPDATE')) return [{ id: 'tenant' }];
        if (state.metadataFailure) throw new Error('null metadata unavailable');
        if (state.metadataMode === 'incomplete') return [];
        if (state.metadataMode === 'invalid') return [{ id: 'rule', conditions: null }];
        if (state.metadataMode === 'duplicate') return [{ id: 'rule', conditions: true }, { id: 'rule', conditions: true }];
        const name = /FROM "(\w+)"/.exec(sql)![1];
        const installed = actual.Prisma.dmmf.datamodel.models.find(m => m.name === name)!;
        const key = installed.fields.find(f => f.isId)!.name;
        return (state.rows[name[0].toLowerCase() + name.slice(1)] ?? []).filter(r => query.values.includes(r[key])).map(r => ({
          [key]: r[key], ...Object.fromEntries(installed.fields.filter(f => f.type === 'Json' && !f.isRequired).map(f =>
            [f.name, state.nulls[`${name}:${r[key]}:${f.name}`] ?? false])),
        }));
      };
      const installed = actual.Prisma.dmmf.datamodel.models.find(m => m.name[0].toLowerCase() + m.name.slice(1) === model);
      if (!installed) return undefined;
      const read = (query: any = {}) => queryRows(state.rows, model, query).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
        if (installed.fields.some(f => f.name === key && f.type === 'Decimal')) {
          const decimal = new actual.Prisma.Decimal(value as string);
          return [key, overrides?.[model]?.[key] ? overrides[model][key].compute({ [key]: decimal }) : decimal];
        }
        return [key, value];
      })));
      const store = (data: any) => Object.fromEntries(Object.entries(data).map(([key, value]) => {
        if (value === actual.Prisma.DbNull || value === actual.Prisma.JsonNull) {
          state.nulls[`${installed.name}:${data.id ?? data.companyId}:${key}`] = value === actual.Prisma.DbNull;
          return [key, null];
        }
        return [key, value];
      }));
      return {
        findMany: (query: any) => Promise.resolve(read(query)),
        findUnique: (query: any) => Promise.resolve(read(query)[0] ?? null),
        create: async ({ data }: any) => { state.writes.push([model, data]); (state.rows[model] ??= []).push(store(data)); return data; },
        update: async ({ where, data }: any) => { state.writes.push([model, data]); Object.assign(state.rows[model].find(r => r.id === where.id), store(data)); },
        deleteMany: async ({ where }: any) => { state.writes.push([model, where]); const ids = queryRows(state.rows, model, { where }).map(r => r.id ?? r.companyId); state.rows[model] = state.rows[model].filter(r => !ids.includes(r.id ?? r.companyId)); },
      };
    } });
  }
  return { ...actual, PrismaClient };
});
import { createBackup, getBackupFile, listBackups, deleteBackup, validateBackup } from '@/lib/backup';
import { previewCompanyRestore, restoreCompanyBackup } from '@/lib/backup-restore';
import { RESTORE_MODELS } from '@/lib/backup-validation';
import { db } from '@/lib/db';
import * as dbModule from '@/lib/db';
import { sealSnapshot } from '@/lib/backup-format';

function fixtureRow(model: string, id: string) {
  const fields = Prisma.dmmf.datamodel.models.find(m => m.name === model)!.fields.filter(f => f.kind !== 'object');
  return Object.fromEntries(fields.map(f => [f.name, f.name === 'id' ? id : f.name === 'companyId' ? 'tenant' : f.isList ? [] : !f.isRequired ? null :
    f.kind === 'enum' ? Prisma.dmmf.datamodel.enums.find(e => e.name === f.type)!.values[0].name :
    ({ String: `${id}-${f.name}`, Int: 1, Float: 1, Boolean: false, DateTime: '2026-01-01T00:00:00.000Z', Decimal: '0.00', Json: {} } as any)[f.type]]));
}
function disk() {
  const dir = path.join(state.root, 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map(n => [n, fs.readFileSync(path.join(dir, n), 'utf8')]) : [];
}
function body(saved: Awaited<ReturnType<typeof createBackup>>) { return JSON.parse(Buffer.from(saved.data, 'base64').toString('utf8')); }
function text(value: any) { sealSnapshot(value); return JSON.stringify(value); }
beforeEach(() => {
  state.gate = createMaintenanceGate(path.join(state.root, `gate-${crypto.randomUUID()}`));
  state.rows = {}; state.nulls = {}; state.queries = []; state.options = []; state.writes = []; state.metadataFailure = false; state.metadataMode = '';
  // Complete installed scalar inventory, but only roots needed by these public probes.
  for (const model of Object.values(RESTORE_MODELS)) state.rows[model[0].toLowerCase() + model.slice(1)] = [];
  const row = fixtureRow;
  state.rows.company = [row('Company', 'tenant')];
  state.rows.glAccount = [row('GlAccount', 'gl')];
  state.rows.bankRule = [row('BankRule', 'rule')];
  state.rows.companyKnowledge = [row('CompanyKnowledge', 'knowledge')];
  state.rows.knowledgeAudit = [row('KnowledgeAudit', 'audit')];
  state.rows.knowledgeAudit[0].knowledgeId = 'knowledge';
  state.rows.knowledgeAudit[0].afterValue = { nested: null, list: [null] };
  state.nulls['BankRule:rule:conditions'] = true;
  state.nulls['KnowledgeAudit:audit:beforeValue'] = false;
  state.rows.journalChainHead = [];
  fs.mkdirSync(path.join(state.root, 'backups'), { recursive: true });
  for (const [name] of disk()) fs.unlinkSync(path.join(state.root, 'backups', name));
});
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(state.root, { recursive: true, force: true }); });

it.each(['9999999999999999.99', '0.01', '-9999999999999999.99', '-0.01', '0.00'])('public export -> JSON -> preview/restore preserves exact %s and ordinary Number results', async amount => {
  state.rows.glAccount[0].balance = amount;
  expect(typeof (await db.glAccount.findMany())[0].balance).toBe('number');
  const saved = await createBackup('tenant'), source = body(saved);
  expect(source.manifest.version).toBe('2.1.0');
  expect(source.data.glAccounts[0].balance).toBe(amount);
  expect(state.options).toEqual([{ isolationLevel: 'RepeatableRead' }]);
  expect(getBackupFile(saved.filename)?.data).toBe(Buffer.from(saved.data, 'base64').toString('utf8'));
  await previewCompanyRestore('tenant', JSON.stringify(source));
  const result = await restoreCompanyBackup('tenant', JSON.stringify(source));
  expect(result.status).toBe('committed');
  expect(state.writes.find(([model, data]) => model === 'glAccount' && 'balance' in data)[1].balance).toBe(amount);
  const safety = JSON.parse(getBackupFile(result.safetyFilename)!.data);
  expect(safety.data.glAccounts[0].balance).toBe(amount);
  expect(safety.manifest.fidelity).toEqual(source.manifest.fidelity);
  expect(validateBackup(source).valid).toBe(false);
});

it('covers every installed Decimal(18,2) column and accounting link through public export and replacement', async () => {
  const models = ['BankAccount', 'BankStatement', 'BankTransaction', 'ReconciliationPeriod', 'JournalEntry', 'JournalLine', 'User'];
  for (const model of models) state.rows[model[0].toLowerCase() + model.slice(1)] = [fixtureRow(model, model)];
  Object.assign(state.rows.bankAccount[0], { glAccountId: 'gl' });
  Object.assign(state.rows.bankStatement[0], { bankAccountId: 'BankAccount' });
  Object.assign(state.rows.bankTransaction[0], { statementId: 'BankStatement', journalEntryId: 'JournalEntry', journalLineId: 'JournalLine' });
  Object.assign(state.rows.reconciliationPeriod[0], { bankAccountId: 'BankAccount', userId: 'User' });
  Object.assign(state.rows.journalEntry[0], { status: 'draft' });
  Object.assign(state.rows.journalLine[0], { entryId: 'JournalEntry', glAccountId: 'gl' });
  state.rows.user[0].email = 'synthetic@example.invalid';
  const amounts = ['9999999999999999.99', '0.01', '-9999999999999999.99', '-0.01', '0.00'];
  const expected: Array<[string, string, string]> = [];
  for (const model of Prisma.dmmf.datamodel.models) {
    for (const field of model.fields.filter(f => f.type === 'Decimal')) {
      expect((field as any).nativeType).toEqual(['Decimal', ['18', '2']]);
      const delegate = model.name[0].toLowerCase() + model.name.slice(1);
      const amount = amounts[expected.length % amounts.length];
      state.rows[delegate][0][field.name] = amount;
      expected.push([delegate, field.name, amount]);
    }
  }
  expect(expected).toHaveLength(13);
  const source = body(await createBackup('tenant'));
  expect(source.data.users[0]).not.toHaveProperty('passwordHash');
  expect(source.data.systemConfig).toEqual([]);
  expect(source.data.bankTransactions[0]).toMatchObject({ journalEntryId: 'JournalEntry', journalLineId: 'JournalLine' });
  await previewCompanyRestore('tenant', JSON.stringify(source));
  const result = await restoreCompanyBackup('tenant', JSON.stringify(source));
  expect(result.status).toBe('committed');
  for (const [model, field, amount] of expected) expect(state.writes.find(([m, data]) => m === model && field in data)[1][field]).toBe(amount);
});

it('captures typed SQL NULL/JSON null provenance, recreates both deliberately, and leaves nested null untouched', async () => {
  const source = body(await createBackup('tenant'));
  expect(source.manifest.fidelity).toEqual({ monetary: 'decimal-18,2', jsonNulls: [
    { model: 'BankRule', key: { id: 'rule' }, field: 'conditions', kind: 'db-null' },
    { model: 'KnowledgeAudit', key: { id: 'audit' }, field: 'beforeValue', kind: 'json-null' },
  ] });
  const before = JSON.stringify(source);
  await previewCompanyRestore('tenant', before);
  expect(JSON.stringify(source)).toBe(before);
  expect(state.writes).toEqual([]);
  const result = await restoreCompanyBackup('tenant', before);
  expect(result.status).toBe('committed');
  expect(state.writes.find(([model, data]) => model === 'bankRule' && 'conditions' in data)[1].conditions).toBe(Prisma.DbNull);
  expect(state.writes.find(([model, data]) => model === 'knowledgeAudit' && 'beforeValue' in data)[1].beforeValue).toBe(Prisma.JsonNull);
  expect(state.writes.find(([model, data]) => model === 'knowledgeAudit' && 'afterValue' in data)[1].afterValue).toEqual({ nested: null, list: [null] });
});

it.each(['missing', 'missing-reference', 'missing-jsonNulls', 'monetary-tag', 'duplicate', 'unknown-model', 'foreign-key', 'wrong-field', 'wrong-kind', 'extra-key', 'non-null-field', 'legacy-null', 'legacy-loss', 'range', 'scale', 'nonfinite', 'new-number'])('rejects %s fidelity ambiguity/tampering without DB/files/counter mutation', async damage => {
  const source = body(await createBackup('tenant'));
  const ref = source.manifest.fidelity?.jsonNulls[0];
  if (damage === 'missing') delete source.manifest.fidelity;
  if (damage === 'missing-reference') source.manifest.fidelity.jsonNulls = [];
  if (damage === 'missing-jsonNulls') delete source.manifest.fidelity.jsonNulls;
  if (damage === 'monetary-tag') source.manifest.fidelity.monetary = 'number';
  if (damage === 'duplicate' && ref) source.manifest.fidelity.jsonNulls.push(ref);
  if (damage === 'unknown-model' && ref) ref.model = 'User';
  if (damage === 'foreign-key' && ref) ref.key.id = 'foreign';
  if (damage === 'wrong-field' && ref) ref.field = 'name';
  if (damage === 'wrong-kind' && ref) ref.kind = 'null';
  if (damage === 'extra-key' && ref) ref.key.companyId = 'other';
  if (damage === 'non-null-field' && ref) source.data.bankRules[0].conditions = {};
  if (damage.startsWith('legacy')) { source.manifest.version = '2.0.0'; delete source.manifest.fidelity; }
  if (damage === 'legacy-loss') { source.data.bankRules[0].conditions = {}; source.data.knowledgeAudit[0].beforeValue = {}; source.data.glAccounts[0].balance = 2 ** 45; }
  if (damage === 'range') source.data.glAccounts[0].balance = '10000000000000000.00';
  if (damage === 'scale') source.data.glAccounts[0].balance = '0.001';
  if (damage === 'nonfinite') source.data.glAccounts[0].balance = 'Infinity';
  if (damage === 'new-number') source.data.glAccounts[0].balance = 0.01;
  const rows = structuredClone(state.rows), files = disk(), options = state.options.length, queries = state.queries.length;
  const expected = damage === 'legacy-null'
    ? 'RESTORE_FIDELITY: unsupported 2.0.0 nullable JSON fidelity: BankRule.conditions; SQL NULL versus JSON null provenance is missing'
    : damage === 'legacy-loss' ? 'RESTORE_FIDELITY: unsupported 2.0.0 monetary fidelity: GlAccount.balance' : /RESTORE_(FIDELITY|SCHEMA)/;
  await expect(previewCompanyRestore('tenant', text(source))).rejects.toThrow(expected);
  await expect(restoreCompanyBackup('tenant', text(source))).rejects.toThrow(expected);
  expect(state.rows).toEqual(rows); expect(disk()).toEqual(files); expect(state.writes).toEqual([]);
  expect(state.options).toHaveLength(options); expect(state.queries).toHaveLength(queries);
});

it('keeps required JSON field null as JSON null without nullable-field provenance', async () => {
  state.rows.companyKnowledge[0].metadata = null;
  const source = body(await createBackup('tenant'));
  expect(source.manifest.fidelity.jsonNulls).not.toContainEqual(expect.objectContaining({ field: 'metadata' }));
  const result = await restoreCompanyBackup('tenant', JSON.stringify(source));
  expect(result.status).toBe('committed');
  expect(state.writes.find(([m, data]) => m === 'companyKnowledge' && 'metadata' in data)[1].metadata).toBe(Prisma.JsonNull);
});

it('fails capture closed when metadata SQL fails instead of assuming SQL NULL', async () => {
  state.metadataFailure = true;
  await expect(createBackup('tenant')).rejects.toThrow('null metadata unavailable');
  expect(disk()).toEqual([]); expect(state.writes).toEqual([]);
});

it('refuses restore before writes/publication when raw safety null metadata cannot be certified', async () => {
  const source = body(await createBackup('tenant'));
  const rows = structuredClone(state.rows), files = disk();
  state.metadataFailure = true;
  await expect(restoreCompanyBackup('tenant', JSON.stringify(source))).rejects.toThrow('null metadata unavailable');
  expect(state.rows).toEqual(rows); expect(state.writes).toEqual([]); expect(disk()).toEqual(files);
});

it.each(['missing-operation', 'incomplete', 'invalid', 'duplicate'])('rejects %s metadata instead of manufacturing null provenance', async mode => {
  state.metadataMode = mode;
  const rows = structuredClone(state.rows);
  await expect(createBackup('tenant')).rejects.toThrow();
  expect(state.rows).toEqual(rows); expect(state.writes).toEqual([]); expect(disk()).toEqual([]);
});

it.each(['10000000000000000.00', '0.001', 'Infinity'])('rejects invalid raw snapshot money %s before publication', async value => {
  state.rows.glAccount[0].balance = value;
  const rows = structuredClone(state.rows);
  await expect(createBackup('tenant')).rejects.toThrow('RESTORE_FIDELITY');
  expect(state.rows).toEqual(rows); expect(state.writes).toEqual([]); expect(disk()).toEqual([]);
});

it('preserves unambiguous v2 literal safe amounts and catalog/read/delete support for every old version', async () => {
  state.rows.bankRule[0].conditions = {};
  state.nulls['BankRule:rule:conditions'] = false;
  state.rows.knowledgeAudit[0].beforeValue = {};
  const source = body(await createBackup('tenant'));
  for (const version of ['1.0.0', '1.1.0', '2.0.0']) {
    source.manifest.version = version; delete source.manifest.fidelity;
    source.data.glAccounts[0].balance = 10.01;
    const raw = text(source), filename = `legacy-${version}.json`;
    fs.writeFileSync(path.join(state.root, 'backups', filename), raw);
    expect(listBackups('tenant').some(r => r.filename === filename)).toBe(true);
    expect(getBackupFile(filename)?.data).toBe(raw);
    if (version === '2.0.0') {
      await previewCompanyRestore('tenant', raw);
      const result = await restoreCompanyBackup('tenant', raw);
      expect(result.status).toBe('committed');
      expect(state.writes.find(([model, data]) => model === 'glAccount' && 'balance' in data)[1].balance).toBe(10.01);
    }
    expect(deleteBackup(filename, 'tenant')).toEqual({ status: 'deleted' });
  }
});

it('raw internal transaction preserves options, lease lifetime, denial and owned recovery authority', async () => {
  const run = (dbModule as any).withCompanyBackupTransaction;
  expect(run).toBeTypeOf('function');
  await run(async (tx: any) => {
    expect(state.gate.status().leases).toBe(1);
    expect((await tx.glAccount.findMany())[0].balance).toBeInstanceOf(Prisma.Decimal);
  }, { isolationLevel: 'Serializable', maxWait: 123, timeout: 456 });
  expect(state.options.at(-1)).toEqual({ isolationLevel: 'Serializable', maxWait: 123, timeout: 456 });
  const owner = state.gate.beginMaintenance(); await owner.drain({ timeoutMs: 0 });
  const calls = state.options.length;
  await expect(run(async () => {})).rejects.toMatchObject({ code: 'BACKUP_MAINTENANCE' });
  expect(state.options).toHaveLength(calls);
  await owner.runRecovery(() => run(async (tx: any) => { await tx.company.update({ where: { id: 'tenant' }, data: { legalName: 'owned recovery' } }); }));
  expect(state.rows.company[0].legalName).toBe('owned recovery');
  expect(state.gate.status()).toEqual({ marked: true, leases: 0 });
  owner.release();
});
