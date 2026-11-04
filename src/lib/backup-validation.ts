import { Prisma } from '@prisma/client';
import type { BackupData } from './backup';
import { isCompanyFormat, parseSnapshot, RESTORE_MODELS, monetaryValid, validateSnapshotFidelity, jsonNullKind } from './backup-format';
export { RESTORE_MODELS } from './backup-format';
import { buildChainVerdict, computeAuditHash, type ChainRow } from './journal-hash';

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

export const schemaModels = Prisma.dmmf.datamodel.models;
export const delegate = (model: string) => model[0].toLowerCase() + model.slice(1);
export const schema = (model: string) => {
  const result = schemaModels.find(m => m.name === model);
  if (!result) throw new Error(`RESTORE_SCHEMA: missing installed model ${model}`);
  return result;
};
export const identity = (row: Row) => String(row.id ?? row.companyId);
export const foreignKeys = (model: string) => schema(model).fields.filter(f => f.kind === 'object' && f.relationFromFields?.length);
export const uniqueKeys = (model: string): string[][] => [
  ...schema(model).fields.filter(f => f.isId || f.isUnique).map(f => [f.name]),
  ...schema(model).uniqueFields.map(fields => [...fields]),
];
function fail(code: string, detail: string): never { throw new Error(`${code}: ${detail}`); }
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Row, right = b as Row;
  const keys = Object.keys(left).sort();
  return keys.length === Object.keys(right).length && keys.every(k => equal(left[k], right[k]));
}
export function sameConfig(a: unknown, b: unknown): boolean { return equal(a, b); }

const nestedFields: Record<string, string> = { CompanyMember: 'user', JournalEntry: 'lines', BankStatement: 'transactions' };
function scalarValid(field: ReturnType<typeof schema>['fields'][number], value: unknown): boolean {
  if (value === null) return field.type === 'Json' || !field.isRequired;
  if (field.isList) return Array.isArray(value) && value.every(item => scalarValid({ ...field, isList: false }, item));
  if (field.kind === 'enum') return typeof value === 'string' &&
    Prisma.dmmf.datamodel.enums.find(e => e.name === field.type)?.values.some(v => v.name === value) === true;
  switch (field.type) {
    case 'String': return typeof value === 'string' && (!field.isId || value.length > 0);
    case 'Boolean': return typeof value === 'boolean';
    case 'Int': return Number.isInteger(value) && Number(value) >= -2147483648 && Number(value) <= 2147483647;
    case 'Float': return typeof value === 'number' && Number.isFinite(value);
    case 'Decimal': return monetaryValid(value, false);
    case 'DateTime': return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) &&
      Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
    case 'Json': return value !== undefined; // JSON.parse already restricts values to JSON.
    default: return false;
  }
}
function checkRow(model: string, row: Row): void {
  const fields = schema(model).fields.filter(f => f.kind !== 'object');
  for (const key of Object.keys(row)) {
    if (!fields.some(f => f.name === key) && key !== nestedFields[model]) fail('RESTORE_SCHEMA', `${model}.${key}`);
  }
  // V2 exports all scalar columns, including explicit nulls. Defaults must not
  // silently manufacture new state from a truncated/old-schema row.
  for (const field of fields) {
    if (!Object.hasOwn(row, field.name) || !scalarValid(field, row[field.name])) {
      fail('RESTORE_SCHEMA', `${model}.${field.name}`);
    }
  }
}
function checkUnique(model: string, rows: Row[]): void {
  for (const key of uniqueKeys(model)) {
    const seen = new Set<string>();
    for (const row of rows) {
      if (key.some(k => row[k] == null)) continue; // PostgreSQL nullable unique semantics.
      const value = JSON.stringify(key.map(k => row[k]));
      if (seen.has(value)) fail('RESTORE_UNIQUE', `${model}(${key.join(',')})`);
      seen.add(value);
    }
  }
}

/** Validate every actual FK, plus the operational transaction reference lacking a DB FK. */
export function checkReferences(tables: Tables): void {
  for (const [model, rows] of Object.entries(tables)) {
    for (const relation of foreignKeys(model)) {
      const from = relation.relationFromFields!;
      const to = relation.relationToFields!;
      for (const row of rows) {
        if (from.some(k => row[k] == null)) continue;
        if (!(tables[relation.type] ?? []).some(parent => from.every((k, i) => row[k] === parent[to[i]]))) {
          fail('RESTORE_REFERENCE', `${model}.${from.join(',')}`);
        }
      }
    }
  }
  for (const row of tables.RuleExecutionAudit ?? []) {
    if (!(tables.BankTransaction ?? []).some(tx => tx.id === row.transactionId)) fail('RESTORE_REFERENCE', 'RuleExecutionAudit.transactionId');
  }
  for (const row of tables.PendingApproval ?? []) {
    const payload = row.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('RESTORE_REFERENCE', 'PendingApproval.payload');
    const reference = payload as Row;
    if ((reference.companyId !== undefined && reference.companyId !== row.companyId) ||
        (reference.knowledgeId !== undefined && !(tables.CompanyKnowledge ?? []).some(k =>
          k.id === reference.knowledgeId && (row.knowledgeId == null || row.knowledgeId === k.id)))) {
      fail('RESTORE_REFERENCE', 'PendingApproval payload authority/reference');
    }
  }
  for (const row of tables.BankTransaction ?? []) {
    if (row.journalLineId != null && row.journalEntryId != null) {
      const line = tables.JournalLine?.find(l => l.id === row.journalLineId);
      if (line?.entryId !== row.journalEntryId) fail('RESTORE_REFERENCE', 'BankTransaction accounting pair');
    }
  }
}
function checkNested(tables: Tables): void {
  for (const [parent, field, child, fk] of [
    ['JournalEntry', 'lines', 'JournalLine', 'entryId'],
    ['BankStatement', 'transactions', 'BankTransaction', 'statementId'],
  ]) {
    for (const row of tables[parent]) {
      if (!Object.hasOwn(row, field)) continue;
      const expected = tables[child].filter(r => r[fk] === row.id);
      const value = row[field];
      if (!Array.isArray(value) || value.length !== expected.length ||
          !value.every(r => expected.some(e => equal(e, r)))) fail('RESTORE_NESTED', `${parent}.${field}`);
    }
  }
  for (const member of tables.CompanyMember) {
    if (!Object.hasOwn(member, 'user')) continue;
    const user = tables.User.find(u => u.id === member.userId);
    const nested = member.user;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested) || !user ||
        !Object.entries(nested).every(([key, value]) => equal(user[key], value))) fail('RESTORE_NESTED', 'CompanyMember.user');
  }
}
function checkCycles(tables: Tables): void {
  for (const [model, key] of [['GlAccount', 'parentId'], ['CompanyKnowledge', 'mergedIntoId']]) {
    const byId = new Map(tables[model].map(row => [row.id, row]));
    for (const row of tables[model]) {
      const seen = new Set<unknown>([row.id]);
      let next = row[key];
      while (next != null) {
        if (seen.has(next)) fail('RESTORE_REFERENCE', `${model} cycle`);
        seen.add(next); next = byId.get(next)?.[key];
      }
    }
  }
}
function checkChain(snapshot: BackupData, tables: Tables): void {
  const head = snapshot.data.journalChainHead;
  if (head === undefined || (head !== null && (head.companyId !== snapshot.manifest.companyId ||
      Object.keys(head).sort().join(',') !== 'companyId,lastEntryId,lastHash' ||
      ![head.lastEntryId, head.lastHash].every(v => v === null || typeof v === 'string')))) fail('RESTORE_CHAIN', 'invalid/missing head');
  const entries = tables.JournalEntry.map(row => ({ ...row, date: new Date(row.date as string),
    lines: tables.JournalLine.filter(line => line.entryId === row.id) })) as unknown as ChainRow[];
  const verdict = buildChainVerdict(snapshot.manifest.companyId, entries, head);
  if (verdict.valid !== true) fail('RESTORE_CHAIN', `${verdict.reasonCode}; destination key must certify source hashes; no re-signing`);
  for (const row of tables.AuditLog) {
    // AuditLog's chain is installation-wide, so a company archive cannot prove
    // full topology. It can and must certify each stored HMAC with its stored
    // predecessor, without inventing predecessors belonging to other tenants.
    if (row.hash != null && computeAuditHash(row as unknown as Parameters<typeof computeAuditHash>[0]) !== row.hash) {
      fail('RESTORE_CHAIN', 'audit HMAC/key mismatch');
    }
  }
}

export function validateRestoreSource(companyId: string, text: string): { snapshot: BackupData; tables: Tables } {
  if (!/^[a-zA-Z0-9_-]+$/.test(companyId)) fail('RESTORE_IDENTITY', 'invalid target identifier');
  const snapshot = parseSnapshot(text);
  if (!isCompanyFormat(snapshot.manifest.version)) fail('RESTORE_SCHEMA', 'only v2; legacy/bootstrap uses its existing path');
  const { data, manifest } = snapshot;
  const company = data.company[0];
  if (manifest.companyId !== companyId || company.id !== companyId ||
      company.legalName !== manifest.companyInfo.legalName || company.taxId !== manifest.companyInfo.taxId) fail('RESTORE_IDENTITY', 'selected company/manifest metadata mismatch');
  const allowed = new Set([...Object.keys(RESTORE_MODELS), 'companyConfig', 'journalChainHead']);
  if (Object.keys(data).some(k => !allowed.has(k))) fail('RESTORE_SCHEMA', 'unknown data section');
  if (data.companyConfig !== null && (!data.companyConfig || typeof data.companyConfig !== 'object' || Array.isArray(data.companyConfig))) fail('RESTORE_SCHEMA', 'companyConfig');
  validateSnapshotFidelity(snapshot);
  const tables: Tables = {};
  for (const [section, model] of Object.entries(RESTORE_MODELS)) {
    const rows = data[section as keyof typeof RESTORE_MODELS]!;
    if (!Array.isArray(rows)) fail('RESTORE_SCHEMA', section);
    tables[model] = rows;
    if (model === 'User') {
      const publicFields = new Set(schema('User').fields.filter(f => f.kind !== 'object' && !['passwordHash', 'platformRole', 'emailVerifiedAt', 'legacyUser'].includes(f.name)).map(f => f.name));
      publicFields.add('role');
      for (const row of rows) {
        if (typeof row.id !== 'string' || !row.id || typeof row.email !== 'string' || !row.email ||
            Object.keys(row).some(k => !publicFields.has(k))) fail('RESTORE_SCHEMA', 'User reference (credentials/authority are not restorable)');
      }
    } else for (const row of rows) checkRow(model, row);
    checkUnique(model, rows);
  }
  checkNested(tables);
  checkReferences(tables);
  checkCycles(tables);
  checkChain(snapshot, tables);
  return { snapshot, tables };
}

/** Resolve ownership from real roots, never from a payload-supplied child label. */
export function ownedRows(companyId: string, all: Tables): Tables {
  const owned: Tables = Object.fromEntries(Object.keys(all).map(model => [model, []]));
  for (const [model, rows] of Object.entries(all)) {
    if (model === 'Company') owned[model] = rows.filter(r => r.id === companyId);
    else if (!['User', 'SystemConfig'].includes(model)) owned[model] = rows.filter(r => r.companyId === companyId);
  }
  for (const [child, parent, fk] of [
    ['BankTransaction', 'BankStatement', 'statementId'], ['JournalLine', 'JournalEntry', 'entryId'],
    ['KnowledgeAudit', 'CompanyKnowledge', 'knowledgeId'], ['MemoryVersion', 'MemoryItem', 'itemId'],
    ['TraceabilityLog', 'MemoryItem', 'itemId'], ['ConfidenceLog', 'MemoryItem', 'itemId'],
  ]) owned[child] = all[child].filter(row => owned[parent].some(p => p.id === row[fk]));
  for (const [model, left, right] of [
    ['Relationship', 'sourceId', 'targetId'], ['Contradiction', 'itemAId', 'itemBId'],
    ['EvolutionLink', 'supersededId', 'supersededById'],
  ]) {
    owned[model] = all[model].filter(row => owned.MemoryItem.some(i => i.id === row[left] || i.id === row[right]));
  }
  return owned;
}

export function validateRestoreDestination(source: Tables, all: Tables, companyId: string): Tables {
  const owned = ownedRows(companyId, all);
  if (owned.Company.length !== 1) fail('RESTORE_IDENTITY', 'destination company must already exist; not bootstrap');
  for (const user of source.User) {
    if (!all.User.some(u => u.id === user.id && u.email === user.email)) fail('RESTORE_MISSING_IDENTITY', String(user.id));
  }
  for (const [model, rows] of Object.entries(source)) {
    if (['User', 'SystemConfig'].includes(model)) continue;
    const foreign = all[model].filter(row => !owned[model].includes(row));
    for (const row of rows) {
      if (foreign.some(r => identity(r) === identity(row))) fail('RESTORE_ID_CONFLICT', model);
      for (const key of uniqueKeys(model)) {
        if (key.some(k => row[k] == null)) continue;
        if (foreign.some(r => key.every(k => equal(r[k], row[k])))) fail('RESTORE_UNIQUE', `${model} conflicts outside target`);
      }
    }
  }
  // Reject inbound references before deleting anything: even ON DELETE SET NULL
  // would mutate another tenant. Also reject cross-tenant edges in current state.
  for (const [model, rows] of Object.entries(all)) {
    for (const relation of foreignKeys(model)) {
      if (['User', 'Company'].includes(relation.type)) continue;
      const from = relation.relationFromFields!, to = relation.relationToFields!;
      for (const row of rows) {
        if (owned[model].includes(row) || from.some(k => row[k] == null)) continue;
        if ((owned[relation.type] ?? []).some(parent => from.every((k, i) => row[k] === parent[to[i]]))) fail('RESTORE_INBOUND', `${model}.${from.join(',')}`);
      }
    }
  }
  for (const head of all.JournalChainHead ?? []) {
    if (head.companyId !== companyId && owned.JournalEntry.some(e => e.id === head.lastEntryId)) fail('RESTORE_INBOUND', 'JournalChainHead.lastEntryId');
    if (head.companyId === companyId && head.lastEntryId != null && !owned.JournalEntry.some(e => e.id === head.lastEntryId)) fail('RESTORE_REFERENCE', 'destination JournalChainHead.lastEntryId');
  }
  checkReferences({ ...owned, User: all.User });
  // AuditLog is an installation-wide chain, unlike the per-company journal.
  // Certifying isolated HMACs alone would allow deletion of a predecessor still
  // needed by another tenant. Certify the proposed merged timeline as well.
  const mergedAudit = [...all.AuditLog.filter(row => !owned.AuditLog.includes(row)), ...source.AuditLog]
    .filter(row => row.hash != null)
    .sort((a, b) => new Date(a.createdAt as string).getTime() - new Date(b.createdAt as string).getTime());
  let previousHash: string | null = null;
  let previousTime: number | undefined;
  for (const row of mergedAudit) {
    const time = new Date(row.createdAt as string).getTime();
    if (!Number.isFinite(time) || time === previousTime || row.previousHash !== previousHash ||
        computeAuditHash({ ...row, previousHash } as unknown as Parameters<typeof computeAuditHash>[0]) !== row.hash) {
      fail('RESTORE_CHAIN', 'replacement cannot certify installation-wide audit order; preserve other tenants and do not re-sign');
    }
    previousHash = row.hash as string; previousTime = time;
  }
  return owned;
}

export function scalarData(model: string, row: Row, snapshot: BackupData): Row {
  return Object.fromEntries(schema(model).fields.filter(f => f.kind !== 'object').map(field => {
    const value = row[field.name];
    if (field.type !== 'Json' || value !== null) return [field.name, value];
    return [field.name, field.isRequired || jsonNullKind(snapshot, model, row, field.name) === 'json-null'
      ? Prisma.JsonNull : Prisma.DbNull];
  }));
}
