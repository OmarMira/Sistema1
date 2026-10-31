import crypto from 'node:crypto';
import type { BackupData } from './backup';
import { Prisma } from '@prisma/client';
import { validateCompanyLogo } from './backup-assets';

export const COMPANY_BACKUP_VERSION = '2.1.0';
export const isCompanyFormat = (version: string) => ['2.0.0', COMPANY_BACKUP_VERSION].includes(version);

/** Schema-owned inventory, never taken from archive metadata. FK insertion order. */
export const RESTORE_MODELS = {
  company: 'Company', users: 'User', glAccounts: 'GlAccount', bankAccounts: 'BankAccount',
  entityContexts: 'EntityContext', bankRules: 'BankRule', ruleApplyRecords: 'RuleApplyRecord',
  reconciliationPeriods: 'ReconciliationPeriod', bankStatements: 'BankStatement',
  fiscalPeriods: 'FiscalPeriod', journalEntries: 'JournalEntry', journalLines: 'JournalLine',
  bankTransactions: 'BankTransaction', companyMembers: 'CompanyMember',
  companyModuleEntitlements: 'CompanyModuleEntitlement', detectionConfigs: 'DetectionConfig',
  csvLayoutProfiles: 'CsvLayoutProfile', companyKnowledge: 'CompanyKnowledge',
  knowledgeAudit: 'KnowledgeAudit', pendingApprovals: 'PendingApproval',
  systemMemories: 'SystemMemory', memoryItems: 'MemoryItem', memoryVersions: 'MemoryVersion',
  relationships: 'Relationship', contradictions: 'Contradiction', evolutionLinks: 'EvolutionLink',
  traceabilityLogs: 'TraceabilityLog', confidenceLogs: 'ConfidenceLog',
  ruleExecutionAudits: 'RuleExecutionAudit', auditLogs: 'AuditLog', systemConfig: 'SystemConfig',
} as const;

export interface JsonNullReference {
  model: typeof RESTORE_MODELS[keyof typeof RESTORE_MODELS];
  key: Record<string, string>;
  field: string;
  kind: 'db-null' | 'json-null';
}
export interface SnapshotFidelity {
  monetary: 'decimal-18,2';
  jsonNulls: JsonNullReference[];
}
const installed = (name: string) => {
  const model = Prisma.dmmf.datamodel.models.find(m => m.name === name);
  if (!model) throw new Error(`RESTORE_SCHEMA: missing installed model ${name}`);
  for (const field of model.fields.filter(f => f.type === 'Decimal')) {
    const native = (field as unknown as { nativeType?: [string, string[]] }).nativeType;
    if (JSON.stringify(native) !== '["Decimal",["18","2"]]') {
      throw new Error(`RESTORE_SCHEMA: unsupported installed precision ${name}.${field.name}`);
    }
  }
  return model;
};
export function rowKey(model: string, row: Record<string, unknown>): Record<string, string> {
  const schema = installed(model);
  const keys = schema.primaryKey?.fields ?? schema.fields.filter(f => f.isId).map(f => f.name);
  if (!keys.length || keys.some(k => typeof row[k] !== 'string' || !row[k])) {
    throw new Error(`RESTORE_FIDELITY: invalid ${model} primary key`);
  }
  return Object.fromEntries(keys.map(k => [k, row[k] as string]));
}
const sameKey = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);
const fidelityError = (detail: string): never => { throw new Error(`RESTORE_FIDELITY: ${detail}`); };

/** Installed monetary columns are all Decimal(18,2); no Number conversion. */
export function monetaryValid(value: unknown, canonical: boolean): boolean {
  if (canonical) return typeof value === 'string' && /^-?(0|[1-9]\d{0,15})\.\d{2}$/.test(value) && value !== '-0.00';
  // Below 2^45 each cent maps injectively to binary64 (spacing < .01).
  // Require the literal shortest spelling to remain a schema cent; never round.
  return (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 2 ** 45)) &&
    /^-?\d{1,16}(\.\d{1,2})?$/.test(String(value));
}
function canonicalMoney(value: unknown): string {
  if (typeof value !== 'string' || !monetaryValid(value, false)) fidelityError('capture requires unextended Decimal strings');
  const amount = new Prisma.Decimal(value as string);
  return amount.isZero() ? '0.00' : amount.toFixed(2);
}

/** Normalize only schema money, including duplicate accounting copies, not opaque JSON. */
export function canonicalizeSnapshotMoney(snapshot: BackupData): void {
  function normalize(model: string, row: Record<string, unknown>) {
    for (const field of installed(model).fields.filter(f => f.type === 'Decimal')) {
      if (Object.hasOwn(row, field.name)) row[field.name] = canonicalMoney(row[field.name]);
    }
    if (model === 'JournalEntry' && Array.isArray(row.lines)) row.lines.forEach(r => normalize('JournalLine', r));
    if (model === 'BankStatement' && Array.isArray(row.transactions)) row.transactions.forEach(r => normalize('BankTransaction', r));
  }
  for (const [section, model] of Object.entries(RESTORE_MODELS)) {
    for (const row of snapshot.data[section as keyof typeof RESTORE_MODELS] ?? []) normalize(model, row);
  }
}

/** SQL identifiers derive ONLY from installed inventory. Values are bound parameters.
 * One metadata query per populated nullable-JSON model, in the caller's snapshot.
 */
export async function captureSnapshotFidelity(tx: Prisma.TransactionClient, snapshot: BackupData): Promise<SnapshotFidelity> {
  const jsonNulls: JsonNullReference[] = [];
  const quote = (identifier: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) fidelityError('unsupported installed SQL identifier');
    return Prisma.raw(`"${identifier}"`);
  };
  for (const [section, name] of Object.entries(RESTORE_MODELS)) {
    const model = installed(name);
    const fields = model.fields.filter(f => f.type === 'Json' && !f.isRequired);
    const rows = snapshot.data[section as keyof typeof RESTORE_MODELS] ?? [];
    if (!fields.length || !rows.length) continue;
    const keys = rows.map(row => rowKey(name, row));
    const column = (key: string) => model.fields.find(f => f.name === key)!.dbName ?? key;
    const keyFields = Object.keys(keys[0]);
    const select = [
      ...keyFields.map(k => Prisma.sql`${quote(column(k))} AS ${quote(k)}`),
      ...fields.map(f => Prisma.sql`(${quote(f.dbName ?? f.name)} IS NULL) AS ${quote(f.name)}`),
    ];
    const conditions = keys.map(key => Prisma.sql`(${Prisma.join(keyFields.map(k => Prisma.sql`${quote(column(k))} = ${key[k]}`), ' AND ')})`);
    const metadata = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`SELECT ${Prisma.join(select)} FROM ${quote(model.dbName ?? model.name)} WHERE ${Prisma.join(conditions, ' OR ')}`);
    if (!Array.isArray(metadata) || metadata.length !== rows.length) fidelityError(`incomplete SQL null metadata for ${name}`);
    for (const [i, row] of rows.entries()) {
      const matches = metadata.filter(m => keyFields.every(k => m[k] === keys[i][k]));
      if (matches.length !== 1) fidelityError(`SQL null metadata identity mismatch for ${name}`);
      for (const field of fields) {
        const sqlNull = matches[0][field.name];
        if (typeof sqlNull !== 'boolean' || (sqlNull && row[field.name] !== null)) fidelityError(`SQL null metadata mismatch for ${name}.${field.name}`);
        if (row[field.name] === null) jsonNulls.push({ model: name, key: keys[i], field: field.name, kind: sqlNull ? 'db-null' : 'json-null' });
      }
    }
  }
  return { monetary: 'decimal-18,2', jsonNulls };
}

/** Mandatory new-format provenance; legacy ambiguity is never guessed. Pure validation. */
export function validateSnapshotFidelity(snapshot: BackupData): void {
  const modern = snapshot.manifest.version === COMPANY_BACKUP_VERSION;
  const fidelity = snapshot.manifest.fidelity;
  if (modern && (!fidelity || Object.keys(fidelity).sort().join(',') !== 'jsonNulls,monetary' ||
      fidelity.monetary !== 'decimal-18,2' || !Array.isArray(fidelity.jsonNulls))) fidelityError('2.1.0 requires typed monetary and JSON null metadata');
  if (!modern && fidelity !== undefined) fidelityError('2.0.0 cannot claim 2.1.0 provenance');
  const refs = modern ? fidelity!.jsonNulls : [];
  const consumed = new Set<JsonNullReference>();
  for (const [section, name] of Object.entries(RESTORE_MODELS)) {
    const rows = snapshot.data[section as keyof typeof RESTORE_MODELS] ?? [];
    for (const row of rows) {
      for (const field of installed(name).fields) {
        if (field.type === 'Decimal' && Object.hasOwn(row, field.name) && !monetaryValid(row[field.name], modern)) {
          if (!modern) fidelityError(`unsupported 2.0.0 monetary fidelity: ${name}.${field.name}`);
          throw new Error(`RESTORE_SCHEMA: ${name}.${field.name}`);
        }
        if (field.type !== 'Json' || field.isRequired || row[field.name] !== null) continue;
        if (!modern) fidelityError(`unsupported 2.0.0 nullable JSON fidelity: ${name}.${field.name}; SQL NULL versus JSON null provenance is missing`);
        const key = rowKey(name, row);
        const matches = refs.filter(ref => ref && ref.model === name && ref.field === field.name &&
          ref.key && typeof ref.key === 'object' && !Array.isArray(ref.key) && sameKey(ref.key, key));
        if (matches.length !== 1 || Object.keys(matches[0]).sort().join(',') !== 'field,key,kind,model' ||
            !['db-null', 'json-null'].includes(matches[0].kind)) fidelityError(`invalid/missing JSON null reference ${name}.${field.name}`);
        consumed.add(matches[0]);
      }
    }
  }
  if (consumed.size !== refs.length) fidelityError('extra, duplicate or unowned JSON null reference');
}

export function jsonNullKind(snapshot: BackupData, model: string, row: Record<string, unknown>, field: string): 'db-null' | 'json-null' {
  const ref = snapshot.manifest.fidelity?.jsonNulls.find(r => r.model === model && r.field === field && sameKey(r.key, rowKey(model, row)));
  if (!ref) return fidelityError(`missing JSON null reference ${model}.${field}`);
  return ref.kind;
}

/** Mandatory arrays in v2. Additions require an explicit format decision. */
export const SNAPSHOT_SECTIONS = [
  'company', 'glAccounts', 'bankAccounts', 'bankStatements', 'bankTransactions',
  'bankRules', 'journalEntries', 'journalLines', 'fiscalPeriods', 'companyMembers',
  'users', 'systemConfig', 'reconciliationPeriods', 'companyKnowledge', 'knowledgeAudit',
  'systemMemories', 'memoryItems', 'memoryVersions', 'relationships', 'contradictions',
  'evolutionLinks', 'traceabilityLogs', 'confidenceLogs', 'entityContexts',
  'detectionConfigs', 'companyModuleEntitlements', 'csvLayoutProfiles',
  'ruleApplyRecords', 'ruleExecutionAudits', 'auditLogs', 'pendingApprovals',
] as const;

export interface SnapshotIntegrity {
  algorithm: 'sha256';
  encoding: 'utf8';
  scope: 'JSON.stringify({manifest-without-integrity,data})';
  authenticated: false;
  digest: string;
}

function digest(snapshot: BackupData): string {
  const { integrity: _integrity, ...manifest } = snapshot.manifest;
  return crypto.createHash('sha256')
    .update(JSON.stringify({ manifest, data: snapshot.data }), 'utf8').digest('hex');
}

export function sealSnapshot(snapshot: BackupData): void {
  snapshot.manifest.integrity = {
    algorithm: 'sha256', encoding: 'utf8',
    scope: 'JSON.stringify({manifest-without-integrity,data})',
    authenticated: false, digest: digest(snapshot),
  };
}

/** Catalog validation is NOT restore authorization or authenticity verification. */
export function parseSnapshot(text: string): BackupData {
  const snapshot = JSON.parse(text) as BackupData;
  const { manifest, data } = snapshot ?? {};
  if (!manifest || !data || !['1.0.0', '1.1.0', '2.0.0', COMPANY_BACKUP_VERSION].includes(manifest.version)) {
    throw new Error('Unsupported or invalid backup format');
  }
  if (typeof manifest.companyId !== 'string' || !manifest.companyId ||
      manifest.companyInfo?.id !== manifest.companyId ||
      typeof manifest.companyInfo.legalName !== 'string' ||
      !Number.isFinite(Date.parse(manifest.createdAt)) ||
      !Array.isArray(data.company) || data.company.length !== 1 ||
      data.company[0]?.id !== manifest.companyId || !manifest.recordCounts) {
    throw new Error('Invalid backup company identity or metadata');
  }
  const required = isCompanyFormat(manifest.version) ? SNAPSHOT_SECTIONS : SNAPSHOT_SECTIONS.slice(0, 11);
  for (const section of required) {
    const rows = data[section];
    if (!Array.isArray(rows)) throw new Error(`Missing backup section: ${section}`);
    if (isCompanyFormat(manifest.version) && manifest.recordCounts[section] !== rows.length) {
      throw new Error(`Backup count mismatch: ${section}`);
    }
    for (const row of rows) {
      if (!row || typeof row !== 'object' ||
          ('companyId' in row && row.companyId !== manifest.companyId)) {
        throw new Error(`Backup tenant mismatch: ${section}`);
      }
    }
  }
  if (isCompanyFormat(manifest.version)) {
    const integrity = manifest.integrity;
    if (typeof manifest.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(manifest.id) ||
        integrity?.algorithm !== 'sha256' || integrity.encoding !== 'utf8' ||
        integrity.scope !== 'JSON.stringify({manifest-without-integrity,data})' ||
        integrity.authenticated !== false || integrity.digest !== digest(snapshot)) {
      throw new Error('Backup checksum or metadata mismatch');
    }
    if (data.systemConfig.length !== 0 || manifest.recordCounts.companyConfig !== (data.companyConfig !== null)) {
      throw new Error('Invalid company snapshot configuration');
    }
  }
  if (manifest.companyLogo !== undefined) validateCompanyLogo(data.company[0].logo, manifest.companyLogo);
  // Catalogs retain legacy ambiguous files; only the new format promises this
  // provenance. Restore separately checks whether a legacy source is lossless.
  if (manifest.version === COMPANY_BACKUP_VERSION) validateSnapshotFidelity(snapshot);
  return snapshot;
}
