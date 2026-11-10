import { Prisma } from '@prisma/client';
import type { BackupData } from './backup';
import { isCompanyFormat, parseSnapshot, RESTORE_MODELS, monetaryValid, validateSnapshotFidelity, jsonNullKind } from './backup-format';
export { RESTORE_MODELS } from './backup-format';
import { buildChainVerdict, computeAuditHash, auditHistoryDigestOf, archiveDigestOf, archiveAttributionOf, archiveSealLessOf, auditOverlapDiagnostic, auditSealReference, planAuditOverlapWithAttribution, retainedAttributionHolds, auditOverlapExpectations, partitionAuditLineages, retainedOutsidePayload, type AuditAttributionProjection, type AuditSealReference, type ChainRow, type RecoveryArchive } from './journal-hash';

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
/** Canonical email identity: trimmed, lower-cased (the app's own rule). */
function canonicalEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Roles a restore may persist on a `User`. */
export type RestoredUserRole = 'user' | 'super_admin';

/**
 * Normalize a user role coming from a backup payload to the current global
 * authority contract: 'user' | 'super_admin'.
 *
 * legacy/tenant/unknown values always collapse to 'user' (fail-closed).
 * 'super_admin' is preserved ONLY when there is a trusted authority context:
 * either an authorized bootstrap restore (empty-DB recovery) or a normal
 * restore performed by an actor that is already a global super_admin. The
 * backup payload alone never grants global authority.
 *
 * This lives here (with the rest of the restore-authority contract, and free of
 * any database import) so the portable recovery recreates an account under
 * exactly the same rule as every other restore path. `backup.ts` re-exports it.
 */
export function normalizeRestoredUserRole(
  backupRole: unknown,
  context: { bootstrap?: boolean; restoringActorIsSuperAdmin?: boolean },
): RestoredUserRole {
  if (
    backupRole === 'super_admin' &&
    (Boolean(context.bootstrap) || Boolean(context.restoringActorIsSuperAdmin))
  ) {
    return 'super_admin';
  }
  return 'user';
}
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

/**
 * Validate every actual FK, plus the operational transaction reference lacking a
 * DB FK.
 *
 * `skipModels` excludes models whose references are HISTORICAL EVIDENCE rather
 * than live foreign keys. `AuditLog` is the only such model: its user and company
 * referential actions were dropped by migrations 20261105000000 and
 * 20261109010000 precisely so that retained evidence outlives the actor/company it
 * names. A portable recovery therefore certifies those rows by signature/archive
 * (see `planAuditOverlapWithAttribution`) instead of requiring a live parent, which
 * the installed schema does not have. The non-portable contract never passes it.
 */
export function checkReferences(tables: Tables, skipModels: readonly string[] = []): void {
  // Operation-local indexes preserve scalar identity (no string coercion). Keep
  // composite-key relations on their existing exact comparison path.
  const references = new Map<string, Set<unknown>>();
  for (const [model, rows] of Object.entries(tables)) {
    if (skipModels.includes(model)) continue;
    for (const relation of foreignKeys(model)) {
      const from = relation.relationFromFields!;
      const to = relation.relationToFields!;
      let index: Set<unknown> | undefined;
      if (from.length === 1 && to.length === 1) {
        const key = `${relation.type}.${to[0]}`;
        index = references.get(key);
        if (!index) {
          index = new Set((tables[relation.type] ?? []).map(parent => parent[to[0]]));
          references.set(key, index);
        }
      }
      for (const row of rows) {
        if (from.some(k => row[k] == null)) continue;
        const found = index
          ? !Number.isNaN(row[from[0]]) && index.has(row[from[0]])
          : (tables[relation.type] ?? []).some(parent => from.every((k, i) => row[k] === parent[to[i]]));
        if (!found) {
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
// Preserve input order and complete row objects; grouping changes lookup cost,
// not equality, field validation or chain certification.
function groupRows(rows: Row[], field: string): Map<unknown, Row[]> {
  const grouped = new Map<unknown, Row[]>();
  for (const row of rows) {
    const key = row[field];
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

function checkNested(tables: Tables): void {
  for (const [parent, field, child, fk] of [
    ['JournalEntry', 'lines', 'JournalLine', 'entryId'],
    ['BankStatement', 'transactions', 'BankTransaction', 'statementId'],
  ]) {
    const children = groupRows(tables[child], fk);
    for (const row of tables[parent]) {
      if (!Object.hasOwn(row, field)) continue;
      const expected = children.get(row.id) ?? [];
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
function checkChain(
  snapshot: BackupData,
  tables: Tables,
  portable: boolean,
  /**
   * Proven attribution of retained rows whose references the legacy FKs erased.
   */
  attribution?: ReadonlyMap<string, AuditAttributionProjection>,
): void {
  const head = snapshot.data.journalChainHead;
  if (head === undefined || (head !== null && (head.companyId !== snapshot.manifest.companyId ||
      Object.keys(head).sort().join(',') !== 'companyId,lastEntryId,lastHash' ||
      ![head.lastEntryId, head.lastHash].every(v => v === null || typeof v === 'string')))) fail('RESTORE_CHAIN', 'invalid/missing head');
  const linesByEntry = groupRows(tables.JournalLine, 'entryId');
  const entries = tables.JournalEntry.map(row => ({ ...row, date: new Date(row.date as string),
    lines: linesByEntry.get(row.id) ?? [] })) as unknown as ChainRow[];
  if (!portable) {
    const verdict = buildChainVerdict(snapshot.manifest.companyId, entries, head);
    if (verdict.valid !== true) fail('RESTORE_CHAIN', `${verdict.reasonCode}; destination key must certify source hashes; no re-signing`);
    for (const row of tables.AuditLog) {
      if (row.hash == null) continue;
      // AuditLog's chain is installation-wide, so a company archive cannot prove
      // full topology. It can and must certify each stored HMAC with its stored
      // predecessor, without inventing predecessors belonging to other tenants.
      //
      // ONE documented drift is accepted here, and only with its proof: a row
      // whose user reference was erased by the dropped `ON DELETE SET NULL`
      // foreign key is certified by re-computing the ORIGINAL seal with the
      // authenticated source attribution (`attribution`), never by treating the
      // null as signed. Callers pass that map only for rows this operation already
      // proved against the authenticated source event.
      const projected = attribution?.get(String(row.id));
      if (projected !== undefined && retainedAttributionHolds(row as unknown as Parameters<typeof retainedAttributionHolds>[0], projected)) continue;
      if (computeAuditHash(row as unknown as Parameters<typeof computeAuditHash>[0]) !== row.hash) {
        fail('RESTORE_CHAIN', 'audit HMAC/key mismatch');
      }
    }
    return;
  }
  // Portable recovery (different installation key): the source HMACs cannot be
  // recomputed here and are NEVER re-signed. Topology is still certified from
  // the stored links; the only tolerated verdict is the hash-recompute step,
  // which is reached only after every structural check has passed.
  const verdict = buildChainVerdict(snapshot.manifest.companyId, entries, undefined);
  const tolerated = verdict.valid !== true &&
    (verdict.reasonCode === 'HASH_MISMATCH' || verdict.reasonCode === 'LEGACY_HASH_RECOMPUTE_MISMATCH');
  if (verdict.valid !== true && !tolerated) fail('RESTORE_CHAIN', `${verdict.reasonCode}; portable topology`);
  const members = entries.filter(entry => entry.hash != null);
  if (members.length > 0) {
    const predecessors = new Set(members.map(entry => entry.previousHash));
    const tail = members.find(entry => !predecessors.has(entry.hash));
    if (!tail) fail('RESTORE_CHAIN', 'portable chain tail is not unique');
    if (head && (head.lastHash !== tail.hash || head.lastEntryId !== tail.id)) {
      fail('RESTORE_CHAIN', 'portable chain head does not match the certified tail');
    }
  }
  for (const row of tables.AuditLog) {
    // Structural retention only: values are archived, not locally verified.
    const digestShape = (value: unknown) => value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
    if (!digestShape(row.hash) || !digestShape(row.previousHash)) fail('RESTORE_CHAIN', 'portable audit provenance');
  }
}

export interface RestoreSourceOptions {
  /** 'portable' requires the authenticated digest of the enclosing container. */
  recovery?: 'local' | 'portable';
  authenticatedDigest?: string;
  /**
   * Retained audit id -> the source references its stored seal was computed with
   * (company and/or user), for rows whose references the legacy FKs erased.
   * Supplied only by a caller that already proved the relationship against the
   * authenticated source event in the same operation (the recovery transaction's
   * own safety snapshot). Empty/absent keeps the strict local-key contract.
   */
  auditAttribution?: ReadonlyMap<string, AuditAttributionProjection>;
  /**
   * Treat `AuditLog` user/company references as HISTORICAL EVIDENCE (no live
   * parent required), because the installed schema dropped both referential
   * actions. A `recovery: 'portable'` reader derives this automatically (a portable
   * snapshot carries the source installation's seals as evidence, and its owner may
   * legitimately have been deleted since it was exported). The flag is set
   * explicitly by a portable recovery for its own SAFETY snapshot — the evidence
   * that snapshot captures may name an actor or a company that no longer exists,
   * and it must still be a valid restore point. A local replacement never enables
   * it, so its contract stays exactly as strict as before.
   */
  historicalAuditReferences?: boolean;
}

export function validateRestoreSource(
  companyId: string,
  text: string,
  options?: RestoreSourceOptions,
): { snapshot: BackupData; tables: Tables } {
  if (!/^[a-zA-Z0-9_-]+$/.test(companyId)) fail('RESTORE_IDENTITY', 'invalid target identifier');
  const snapshot = parseSnapshot(text, {
    recovery: options?.recovery ?? 'local',
    authenticatedDigest: options?.authenticatedDigest,
  });
  if (!isCompanyFormat(snapshot.manifest.version)) fail('RESTORE_SCHEMA', 'only v2; legacy/bootstrap uses its existing path');
  const { data, manifest } = snapshot;
  const company = data.company[0];
  if (manifest.companyId !== companyId || company.id !== companyId ||
      company.legalName !== manifest.companyInfo.legalName || company.taxId !== manifest.companyInfo.taxId) fail('RESTORE_IDENTITY', 'selected company/manifest metadata mismatch');
  const allowed = new Set([...Object.keys(RESTORE_MODELS), 'companyConfig', 'journalChainHead']);
  if (Object.keys(data).some(k => !allowed.has(k))) fail('RESTORE_SCHEMA', 'unknown data section');
  if (data.companyConfig !== null && (!data.companyConfig || typeof data.companyConfig !== 'object' || Array.isArray(data.companyConfig))) fail('RESTORE_SCHEMA', 'companyConfig');
  validateSnapshotFidelity(snapshot);
  const historicalAuditReferences = options?.recovery === 'portable' ||
    options?.historicalAuditReferences === true;
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
  // A PORTABLE source is the same evidentiary contract as the destination side: its
  // audit rows travel sealed by the SOURCE installation, and the migrations dropped
  // the user/company referential actions, so an actor or company that no longer
  // exists is historical evidence — not a broken reference. Without this, a file
  // that this installation legitimately exported AFTER a recovery (where the
  // retained evidence keeps its original actor) could not be read back, not even
  // here. Every other model keeps the identical live-reference check, and the local
  // (non-portable) reader keeps it for `AuditLog` too.
  checkReferences(tables, historicalAuditReferences ? ['AuditLog'] : []);
  checkCycles(tables);
  checkChain(snapshot, tables, options?.recovery === 'portable', options?.auditAttribution);
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
  ]) {
    const parentIds = new Set(owned[parent].map(row => row.id));
    owned[child] = all[child].filter(row => parentIds.has(row[fk]));
  }
  const memoryIds = new Set(owned.MemoryItem.map(row => row.id));
  for (const [model, left, right] of [
    ['Relationship', 'sourceId', 'targetId'], ['Contradiction', 'itemAId', 'itemBId'],
    ['EvolutionLink', 'supersededId', 'supersededById'],
  ]) {
    owned[model] = all[model].filter(row => memoryIds.has(row[left]) || memoryIds.has(row[right]));
  }
  return owned;
}

/**
 * Admission decision for one restore, under the destination's locks.
 *
 * `owned` is the destination row set the replacement may delete. `auditReuse`
 * lists the incoming audit ids whose event this installation already retains
 * verbatim (same-installation recovery): those rows are preserved, never
 * re-inserted and never rewritten.
 */
export interface RestoreDestinationDecision {
  owned: Tables;
  auditReuse: ReadonlyMap<string, string>;
  /**
   * Retained audit id -> the source attribution its stored seal was computed with.
   * Only rows whose user reference the legacy foreign key erased are listed, and
   * only after the stored seal verified under the local key with that reference.
   *
   * T34 adds the SEAL-LESS case: when neither copy of the event carries a seal, the
   * canonical comparison of the two hash-less rows is the whole proof, so the erased
   * reference is recorded without an HMAC behind it. Such a row's certification is
   * the digest of its STORED bytes (`assertDestinationAuditPreserved` and the archive
   * digest), which fail closed on any drift; nothing is rewritten or re-signed.
   */
  auditProjections: ReadonlyMap<string, AuditAttributionProjection>;
  /**
   * Retained audit id -> the sealed reference set that was actually PROVEN for it
   * (S21/T28-T30), for rows reused byte-identically although their stored reference
   * columns are certified historical local values. Nothing was projected or rewritten
   * for these rows; the map exists so preservation can RE-PROVE the seal with the SAME
   * references (actor and company) instead of trusting a stored opinion.
   */
  auditActorCertifications: ReadonlyMap<string, AuditSealReference>;
  /**
   * Retained audit id -> digest of its STORED bytes, for rows the authenticated
   * payload does not carry at all (T36): another tenant's rows and the unowned rows
   * a legacy company deletion left behind. A company-scoped export never includes
   * them, so the restore cannot overlap-certify them and must not recompute them
   * either — their stored seals may cover references that no longer exist anywhere.
   * They are RETAINED IN PLACE (the audit table is never pruned and a reused id is
   * skipped), so the recovery archive freezes these bytes at post-commit and any
   * later drift fails there. Derived from the SAME expectation set the planner uses,
   * so admission and the post-commit proof classify identically.
   */
  auditRetainedInPlace: ReadonlyMap<string, string>;
}

export function validateRestoreDestination(
  source: Tables,
  all: Tables,
  companyId: string,
  portable = false,
  identityMap: Readonly<Record<string, string>> = {},
  /** Authenticated archive evidence of earlier portable recoveries on this
   * installation (id -> digest). Required to certify retained rows whose source
   * key this machine never had. */
  options: { auditArchive?: RecoveryArchive } = {},
): RestoreDestinationDecision {
  const owned = ownedRows(companyId, all);
  const ownedSets = Object.fromEntries(Object.entries(owned).map(([model, rows]) => [model, new Set(rows)]));
  const auditReuse = new Map<string, string>();
  const auditProjections = new Map<string, AuditAttributionProjection>();
  const auditActorCertifications = new Map<string, AuditSealReference>();
  const auditRetainedInPlace = new Map<string, string>();
  if (owned.Company.length !== 1) fail('RESTORE_IDENTITY', 'destination company must already exist; not bootstrap');
  for (const user of source.User) {
    // S4: the same person may already own a DIFFERENT local account with the
    // same email. The mapping is authorized by the caller (source password +
    // owner email token + local password proof) and only ever remaps this
    // proven owner; the destination row keeps its own id and credentials.
    //
    // F1: a PORTABLE recovery additionally recreates every other source account
    // (absent members) in its prepare transaction with the same id+email, so this
    // strict shape is satisfied there too. The check itself stays strict for
    // every path, non-portable included — the only relaxation is that a PORTABLE
    // reader compares the email in its canonical form (trimmed, lower-cased),
    // which is the application's own email identity rule. The non-portable
    // contract keeps its byte-exact comparison, unchanged.
    const destinationId = identityMap[String(user.id)] ?? user.id;
    const destination = all.User.find(u => u.id === destinationId);
    const emailMatches = destination !== undefined && (portable
      ? canonicalEmail(destination.email) === canonicalEmail(user.email)
      : destination.email === user.email);
    if (!emailMatches) fail('RESTORE_MISSING_IDENTITY', String(user.id));
  }
  for (const [model, rows] of Object.entries(source)) {
    if (['User', 'SystemConfig'].includes(model)) continue;
    // Portable recovery: AuditLog is installation-wide EVIDENCE that is never
    // deleted or rewritten, so its admission belongs to the attributed planner
    // below (exact digest, or signature-proven projection of an erased reference,
    // or a refusal). Leaving it in this generic gate refused a retained row whose
    // companyId a legacy `ON DELETE SET NULL` foreign key had erased BEFORE its
    // HMAC could ever be proved — the reported RESTORE_ID_CONFLICT after the
    // migration, where the row is UNOWNED and only the planner can certify it.
    if (portable && model === 'AuditLog') continue;
    const foreign = all[model].filter(row => !ownedSets[model].has(row));
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
        if (ownedSets[model].has(row) || from.some(k => row[k] == null)) continue;
        if ((owned[relation.type] ?? []).some(parent => from.every((k, i) => row[k] === parent[to[i]]))) fail('RESTORE_INBOUND', `${model}.${from.join(',')}`);
      }
    }
  }
  for (const head of all.JournalChainHead ?? []) {
    if (head.companyId !== companyId && owned.JournalEntry.some(e => e.id === head.lastEntryId)) fail('RESTORE_INBOUND', 'JournalChainHead.lastEntryId');
    if (head.companyId === companyId && head.lastEntryId != null && !owned.JournalEntry.some(e => e.id === head.lastEntryId)) fail('RESTORE_REFERENCE', 'destination JournalChainHead.lastEntryId');
  }
  checkReferences({ ...owned, User: all.User }, portable ? ['AuditLog'] : []);
  if (portable) {
    /*
     * Portable recovery: the destination's OWN audit history is never deleted and
     * never re-signed — not even the rows that carry the restored company id
     * (a company can be deleted while its audit rows outlive it, which is exactly
     * the reported zero-company-with-retained-audit state). Consequently:
     *  - a same-installation recovery can meet its OWN history: an incoming row
     *    whose id is already retained is REUSED when — and only when — the
     *    retained row equals the authenticated source row in every canonical
     *    field (content, stored hash, stored link, timestamp), computed with the
     *    explicit identity mapping. Then it is not re-inserted (no duplicated
     *    history) and not rewritten. Any other same-id row is a collision. The ONE
     *    further accepted shape (S21/T28-T30) is a row whose only canonical
     *    difference is a certified historical reference: `userId` differs while the
     *    stored seal still verifies under this key over the ORIGINAL authenticated
     *    event with one of the BOUNDED candidate reference sets — the source actor,
     *    the retained local actor, the source event's company, or the authenticated
     *    payload's company (`auditSealReference`) — so the event's content is proven
     *    identical and its certified stored references stay untouched (never
     *    projected, never re-signed);
     *  - every preserved row must still be CERTIFIED, either by this
     *    installation's key (rows it signed itself) or by the authenticated
     *    recovery archive of an earlier portable recovery. Nothing is exempted;
     *  - the combined set must stay a set of coherent lineages (no duplicate
     *    stored hash, no fork, no dangling link). The recovered source lineage is
     *    separate on purpose: its source HMACs cannot be recomputed here.
     */
    const archive = options.auditArchive;
    const preserved = all.AuditLog ?? [];
    // The ORIGINAL authenticated event of each source row, by id: the seal proof of
    // a certified actor is taken over it, never over retained mutable references.
    const originalAuditById = new Map(source.AuditLog.map((row) => [identity(row), row]));
    // ONE expectation set for the planner AND the payload-absent classification, so
    // admission can never disagree with the post-commit proof about which ids the
    // backup carries.
    const expectations = auditOverlapExpectations(source.AuditLog, identityMap);
    for (const row of retainedOutsidePayload(expectations, preserved)) {
      auditRetainedInPlace.set(String(row.id), auditHistoryDigestOf(row));
    }
    const overlap = planAuditOverlapWithAttribution(
      expectations,
      preserved,
      // S19/S21/T30: the authenticated payload company is the only remaining
      // description of a company reference a legacy foreign key erased BEFORE the
      // backup was exported, so the bounded seal proof must try it. The post-commit
      // re-proof in the recovery provenance passes the SAME reference.
      { payloadCompanyId: companyId },
    );
    if (overlap.conflicts.length > 0) {
      // Fixed field names + fixed reasons only: never ids, references, content,
      // hashes, tokens or backup bytes (this reaches an anonymous caller).
      fail('RESTORE_ID_CONFLICT', `AuditLog${auditOverlapDiagnostic(overlap)}`);
    }
    for (const [id, digest] of overlap.reuse) auditReuse.set(id, digest);
    for (const [id, projection] of overlap.projections) auditProjections.set(id, projection);
    for (const [id, sealReference] of overlap.certifiedActors) auditActorCertifications.set(id, sealReference);
    for (const row of preserved) {
      const archivedRetained = archive?.get(String(row.id));
      if (row.hash == null) {
        // T34: a seal-less retained row has no HMAC to re-prove, and an unsealed legacy
        // row without an archive entry stays tolerated exactly as before. When the
        // archive DOES hold this id, the absence must be the one it recorded (a seal that
        // disappeared is a defect, never an excuse) and the archived bytes must still
        // match — that digest plus `assertDestinationAuditPreserved` is the whole
        // certification such a row has.
        if (archivedRetained !== undefined) {
          if (!archiveSealLessOf(archivedRetained)) {
            fail('RESTORE_CHAIN', 'retained destination audit seal missing (archive)');
          }
          if (archiveDigestOf(archivedRetained) !== auditHistoryDigestOf(row)) {
            fail('RESTORE_CHAIN', 'retained destination audit evidence mismatch (archive)');
          }
        }
        continue; // legacy unsealed rows stay tolerated, as before
      }
      const archived = archivedRetained;
      if (archived !== undefined) {
        if (archiveDigestOf(archived) !== auditHistoryDigestOf(row)) {
          fail('RESTORE_CHAIN', 'retained destination audit evidence mismatch (archive)');
        }
        // An archived attribution is re-verified with the local key; the archived
        // label on its own certifies nothing.
        const projected = archiveAttributionOf(archived);
        if (projected !== undefined && !retainedAttributionHolds(row, projected)) {
          fail('RESTORE_CHAIN', 'retained destination audit attribution cannot be certified (archive)');
        }
        continue;
      }
      // A retained row whose reference the legacy FK erased, proven above against
      // the authenticated source event: reused as stored, never rewritten.
      if (overlap.projections.has(String(row.id))) continue;
      // S21/T28-T30: a retained row whose stored references are certified historical
      // local values while every other canonical field matches. Its stored seal is the
      // ORIGINAL one and it is RE-PROVEN here with the SAME reference set that was
      // verified above (never over the stored mutable columns, which the seal never
      // covered, and never with a reference this operation did not prove). A row that
      // fails this live proof is not preserved.
      const certified = overlap.certifiedActors.get(String(row.id));
      if (certified !== undefined) {
        const original = originalAuditById.get(String(row.id));
        const proof = original === undefined
          ? null
          : auditSealReference(row, original, companyId);
        if (proof === null || proof.userId !== certified.userId ||
            proof.companyId !== certified.companyId) {
          fail('RESTORE_CHAIN', 'retained destination audit actor certification does not hold');
        }
        continue;
      }
      // T36 — RETAINED IN PLACE. This id is not in the authenticated payload at all,
      // so the export never carried its event (its audit section is company-scoped)
      // and nothing here can certify it: its stored seal may cover a company or an
      // actor that was destroyed after the backup was made. That is sound BECAUSE the
      // restore never touches it — `AuditLog` rows are never deleted (not even the
      // ones carrying the restored company id) and a reused id is skipped instead of
      // re-inserted — so the row is FROZEN, not certified by recomputation. The
      // recovery archive then records the digest of these exact bytes, which is what
      // detects any later drift (the post-commit proof, `assertPortableSourceIntegrity`
      // and every later chain verification). A row that IS in the payload keeps its
      // full proof: a content difference is still an overlap conflict above.
      if (auditRetainedInPlace.has(String(row.id))) continue;
      const expected = computeAuditHash({
        id: String(row.id),
        companyId: row.companyId == null ? null : String(row.companyId),
        userId: row.userId == null ? null : String(row.userId),
        action: String(row.action),
        entity: String(row.entity),
        entityId: row.entityId == null ? null : String(row.entityId),
        details: row.details == null ? null : String(row.details),
        previousHash: row.previousHash == null ? null : String(row.previousHash),
      });
      if (expected !== row.hash) {
        fail('RESTORE_CHAIN', 'retained destination audit history cannot be certified (local key or archive)');
      }
    }
    const partition = partitionAuditLineages(
      [...preserved, ...source.AuditLog.filter((row) => !overlap.reuse.has(String(row.id)))]
        .map((row) => ({
          id: String(row.id),
          hash: row.hash == null ? null : String(row.hash),
          previousHash: row.previousHash == null ? null : String(row.previousHash),
        })),
    );
    if (partition.reasonCode) {
      fail('RESTORE_CHAIN', `${partition.reasonCode}; retained destination audit topology`);
    }
    return { owned, auditReuse, auditProjections, auditActorCertifications, auditRetainedInPlace };
  }
  // AuditLog is an installation-wide chain, unlike the per-company journal.
  // Certifying isolated HMACs alone would allow deletion of a predecessor still
  // needed by another tenant. Certify the proposed merged timeline as well.
  const mergedAudit = [...all.AuditLog.filter(row => !ownedSets.AuditLog.has(row)), ...source.AuditLog]
    .filter(row => row.hash != null)
    .sort((a, b) => new Date(a.createdAt as string).getTime() - new Date(b.createdAt as string).getTime());
  let previousHash: string | null = null;
  let previousTime: number | undefined;
  for (const row of mergedAudit) {
    const time = new Date(row.createdAt as string).getTime();
    // Portable recovery archives stored source HMACs instead of re-signing them
    // under the destination key, so only the stored link/order contract is
    // certified here; the local (authenticated) path still recomputes.
    if (!Number.isFinite(time) || time === previousTime || row.previousHash !== previousHash ||
        (!portable && computeAuditHash({ ...row, previousHash } as unknown as Parameters<typeof computeAuditHash>[0]) !== row.hash)) {
      fail('RESTORE_CHAIN', 'replacement cannot certify installation-wide audit order; preserve other tenants and do not re-sign');
    }
    previousHash = row.hash as string; previousTime = time;
  }
  // Local replacement never reuses retained rows: the strict contract above
  // already refused any overlap the installation cannot certify itself.
  return { owned, auditReuse, auditProjections, auditActorCertifications, auditRetainedInPlace };
}

export function scalarData(model: string, row: Row, snapshot: BackupData): Row {
  return Object.fromEntries(schema(model).fields.filter(f => f.kind !== 'object').map(field => {
    const value = row[field.name];
    if (field.type !== 'Json' || value !== null) return [field.name, value];
    return [field.name, field.isRequired || jsonNullKind(snapshot, model, row, field.name) === 'json-null'
      ? Prisma.JsonNull : Prisma.DbNull];
  }));
}
