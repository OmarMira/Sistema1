if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('Requires Node.js runtime (not Edge)');
}

import crypto from 'node:crypto';
import type { BackupData } from './backup';
import { Prisma } from '@prisma/client';
import { AppError } from './api-error';
import { validateCompanyLogo } from './backup-assets';
import { isBackupOwnershipVerifier } from './backup-ownership';

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

/* ─── Snapshot integrity seal: READ-legacy / WRITE-new ──────────────────
 * The seal used to be a plain SHA-256 digest of the canonical payload. That
 * detects accidental corruption but proves NOTHING about authorship: anyone
 * who can write a backup file can also recompute an unkeyed digest, so a
 * crafted snapshot restored as if it had been produced by the application.
 *
 * New seals are HMAC-SHA256 under a key derived from SESSION_SECRET, reusing
 * the domain-separated derivation introduced for the crypto v2 envelope in
 * src/lib/crypto.ts: PBKDF2-SHA256(SESSION_SECRET, 'crypto-key-salt', 100000)
 * produces the 256-bit base, HKDF-SHA256 with info
 * `accountexpress:crypto:v2:hmac` separates the signing purpose. The same
 * info string is never used for an AES key, so a backup seal key cannot be
 * turned into a decryption key or vice versa. It is re-expressed here with
 * node:crypto because sealing and verification are synchronous while the
 * shared module is async/Web-Crypto; the derived bits are identical.
 *
 * Compatibility contract:
 *  - READ-legacy: `algorithm: 'sha256'`, `authenticated: false` seals keep
 *    validating exactly as before. Existing files are never re-sealed.
 *  - WRITE-new: every seal written from now on is `algorithm: 'hmac-sha256'`,
 *    `authenticated: true`, keyed, and cannot be produced without the secret.
 *  - A payload that fails its own seal fails in BOTH modes: a tampered legacy
 *    file fails the legacy digest, a tampered new file fails the HMAC.
 */
export interface SnapshotIntegrity {
  /** 'sha256' is the legacy unkeyed seal (read-only); writers emit the HMAC. */
  algorithm: 'sha256' | 'hmac-sha256';
  encoding: 'utf8';
  scope: 'JSON.stringify({manifest-without-integrity,data})';
  /** Declares whether the digest is a keyed MAC (legacy: false, new: true). */
  authenticated: boolean;
  /** Present on new seals: how the signing key was derived. */
  keyDerivation?: string;
  digest: string;
}

const INTEGRITY_SCOPE = 'JSON.stringify({manifest-without-integrity,data})' as const;
const SEAL_SALT = 'crypto-key-salt';
const SEAL_ITERATIONS = 100_000;
const SEAL_INFO = 'accountexpress:crypto:v2:hmac';
/** Recorded in the seal so a reader never has to guess the derivation. */
export const SEAL_KEY_DERIVATION = `pbkdf2-sha256:${SEAL_ITERATIONS}+hkdf-sha256:${SEAL_INFO}`;

let sealKeyCache: { secret: string; key: Buffer } | null = null;

/** Memoized per secret: one PBKDF2 expansion per process, never per file. */
function sealKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_SECRET environment variable is required. ' +
      'Set it in .env.local (development) or your deployment environment (production).',
    );
  }
  if (sealKeyCache?.secret !== secret) {
    const base = crypto.pbkdf2Sync(secret, SEAL_SALT, SEAL_ITERATIONS, 32, 'sha256');
    sealKeyCache = {
      secret,
      key: Buffer.from(crypto.hkdfSync('sha256', base, SEAL_SALT, SEAL_INFO, 32)),
    };
  }
  return sealKeyCache.key;
}

/** Canonical bytes both seal modes cover, with `integrity` removed. */
function integrityPayload(snapshot: BackupData): string {
  const { integrity: _integrity, ...manifest } = snapshot.manifest;
  return JSON.stringify({ manifest, data: snapshot.data });
}

/** Legacy unkeyed digest: verification only, never written any more. */
function legacyDigest(snapshot: BackupData): string {
  return crypto.createHash('sha256').update(integrityPayload(snapshot), 'utf8').digest('hex');
}

/** Keyed digest written by sealSnapshot. */
function keyedDigest(snapshot: BackupData): string {
  return crypto.createHmac('sha256', sealKey()).update(integrityPayload(snapshot), 'utf8').digest('hex');
}

/** Constant-time comparison; a length/type mismatch is a plain failure. */
function digestMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
}

export function sealSnapshot(snapshot: BackupData): void {
  snapshot.manifest.integrity = {
    algorithm: 'hmac-sha256', encoding: 'utf8', scope: INTEGRITY_SCOPE,
    authenticated: true, keyDerivation: SEAL_KEY_DERIVATION, digest: keyedDigest(snapshot),
  };
}

/** Legacy seals keep validating; new seals must verify as HMAC. */
function integrityVerified(snapshot: BackupData, integrity: SnapshotIntegrity): boolean {
  if (integrity.algorithm === 'hmac-sha256') {
    // Fail closed: without SESSION_SECRET a keyed seal cannot be verified.
    return digestMatches(keyedDigest(snapshot), integrity.digest);
  }
  if (integrity.algorithm === 'sha256') return digestMatches(legacyDigest(snapshot), integrity.digest);
  return false;
}

/* ─── S5 (T4): only CURRENT, sealed backups are restorable ─────────────
 * Older installations wrote the whole snapshot as plain JSON on disk (no
 * ACCOUNTEXPRESS-ENCRYPTED-BACKUP/1 envelope) and sealed it with an UNKEYED
 * sha256 digest. That shape proves nothing about authorship and cannot be
 * carried into the current certified pipeline (typed fidelity, keyed seal,
 * ownership credential), so it is refused instead of silently accepted. The
 * refusal is a client error with its own machine code and a Spanish
 * explanation, thrown BEFORE any row, file or maintenance marker is written.
 *
 * The at-rest envelope never reaches this layer: restore receives the already
 * unsealed snapshot JSON (the download payload), so the readable equivalent of
 * "no ACCOUNTEXPRESS-ENCRYPTED-BACKUP/1 envelope" is "no keyed HMAC seal from
 * the current writer". Read-legacy seals still PARSE (the catalog and the
 * download keep working); only RESTORE refuses them.
 */
export const LEGACY_BACKUP_MESSAGE =
  'No se puede restaurar este respaldo: es un archivo de texto plano anterior a los respaldos sellados, ' +
  'sin el sobre ACCOUNTEXPRESS-ENCRYPTED-BACKUP/1 con el que la versión actual protege cada archivo. ' +
  'Hay que volver a generar un respaldo nuevo desde el sistema actual y restaurar ese archivo.';

export class LegacyBackupFormatError extends AppError {
  constructor() {
    super(400, LEGACY_BACKUP_MESSAGE, 'RESTORE_LEGACY_FORMAT');
    this.name = 'LegacyBackupFormatError';
  }
}

/** TRUE only for the current writer's keyed seal (`hmac-sha256`, authenticated). */
export function isSealedBackupFormat(integrity: SnapshotIntegrity | undefined): boolean {
  return integrity?.algorithm === 'hmac-sha256' && integrity.authenticated === true;
}

/** Fail closed on a legacy plain-text file; never downgrade to the legacy seal. */
export function assertSealedBackupFormat(snapshot: BackupData): void {
  if (!isSealedBackupFormat(snapshot.manifest.integrity)) throw new LegacyBackupFormatError();
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
      if (!row || typeof row !== 'object') {
        throw new Error(`Backup tenant mismatch: ${section}`);
      }
      // A null/unknown companyId is legacy provenance (columns added later,
      // e.g. BankTransaction.companyId) and is tenant-compatible; only an
      // explicit DIFFERENT tenant is rejected.
      if ('companyId' in row && row.companyId != null && row.companyId !== manifest.companyId) {
        throw new Error(`Backup tenant mismatch: ${section}`);
      }
    }
  }
  if (isCompanyFormat(manifest.version)) {
    const integrity = manifest.integrity as SnapshotIntegrity | undefined;
    // Read-legacy / write-new: both seal shapes are accepted, but the declared
    // shape must match the digest that actually verifies.
    const authenticatedShape = integrity?.algorithm === 'hmac-sha256'
      ? integrity.authenticated === true
      : integrity?.algorithm === 'sha256' && integrity.authenticated === false;
    if (typeof manifest.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(manifest.id) ||
        !integrity || !authenticatedShape || integrity.encoding !== 'utf8' ||
        integrity.scope !== INTEGRITY_SCOPE || !integrityVerified(snapshot, integrity)) {
      throw new Error('Backup checksum or metadata mismatch');
    }
    if (data.systemConfig.length !== 0 || manifest.recordCounts.companyConfig !== (data.companyConfig !== null)) {
      throw new Error('Invalid company snapshot configuration');
    }
  }
  // S1/S2: the ownership verifier travels inside the sealed manifest. A present
  // but malformed verifier is never trusted (it cannot protect anything), and
  // the HMAC seal above already rejects a transplanted/edited one.
  if (manifest.ownership !== undefined && !isBackupOwnershipVerifier(manifest.ownership)) {
    throw new Error('Invalid backup ownership verifier');
  }
  if (manifest.companyLogo !== undefined) validateCompanyLogo(data.company[0].logo, manifest.companyLogo);
  // Catalogs retain legacy ambiguous files; only the new format promises this
  // provenance. Restore separately checks whether a legacy source is lossless.
  if (manifest.version === COMPANY_BACKUP_VERSION) validateSnapshotFidelity(snapshot);
  return snapshot;
}
