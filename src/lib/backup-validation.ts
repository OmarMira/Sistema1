import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { BackupData } from './backup';
import { isCompanyFormat, parseSnapshot, RESTORE_MODELS, monetaryValid, validateSnapshotFidelity, jsonNullKind } from './backup-format';
export { RESTORE_MODELS } from './backup-format';
import { buildChainVerdict, computeAuditHash, computeEntryHashV2, recomputeLegacyHash, type ChainRow, type JournalHashLinePayload } from './journal-hash';

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

/**
 * `importAsNewCompany` (S4/T5) admits an archive whose manifest belongs to
 * ANOTHER company: the destination is then a company created for the import,
 * never the archive's own identity. Everything else (seal, fidelity, schema,
 * references, journal chain, per-row audit HMACs) is certified exactly as
 * before, under the archive's OWN company id.
 */
export function validateRestoreSource(
  companyId: string,
  text: string,
  options: { importAsNewCompany?: boolean } = {},
): { snapshot: BackupData; tables: Tables } {
  if (!/^[a-zA-Z0-9_-]+$/.test(companyId)) fail('RESTORE_IDENTITY', 'invalid target identifier');
  const snapshot = parseSnapshot(text);
  if (!isCompanyFormat(snapshot.manifest.version)) fail('RESTORE_SCHEMA', 'only v2; legacy/bootstrap uses its existing path');
  const { data, manifest } = snapshot;
  const company = data.company[0];
  if (company.id !== manifest.companyId ||
      company.legalName !== manifest.companyInfo.legalName || company.taxId !== manifest.companyInfo.taxId ||
      (manifest.companyId !== companyId && !options.importAsNewCompany)) fail('RESTORE_IDENTITY', 'selected company/manifest metadata mismatch');
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

/* ─── S6 (T3): historical audit re-anchoring ──────────────────────────
 * The AuditLog chain is INSTALLATION-wide, so a company archive cannot carry a
 * certified root: on a fresh machine (or after the signing secret changed) a
 * historical segment starts at a predecessor that went away with the old
 * installation. The row topology is intact and every stored HMAC certifies
 * against the link it declares — only the ROOT is missing (L2: 302 intact
 * transactions, chain unrootable).
 *
 * Owner decision (S6): such a segment may be re-based ONLY on a provably empty
 * destination and ONLY after the ownership credential was verified (that gate
 * runs before any of this). The re-anchor writes a FIRST, itself-hashed
 * RESTORE_REBASE audit entry documenting { backupId, originalPredecessorHash,
 * rebasedAt }, and the segment is re-based under the current secret from that
 * root. On a non-empty destination nothing changes: the existing RESTORE_CHAIN
 * refusal stands, byte for byte.
 */
export interface AuditRebase {
  /** Backup identity documented by the sealed RESTORE_REBASE entry. */
  readonly backupId: string;
  /** The predecessor hash the segment pointed at, now recorded instead of lost. */
  readonly originalPredecessorHash: string;
  /** Real instant of the re-anchor (ISO); the row's createdAt is its position. */
  readonly rebasedAt: string;
  /** RESTORE_REBASE first, then the re-based segment; inserts INSTEAD of source AuditLog rows. */
  readonly rows: Row[];
}

/** Chain members (rows carrying a hash) in stored chronological order. */
function auditMembers(rows: Row[]): Row[] {
  return rows
    .filter(row => row.hash != null)
    .sort((a, b) => new Date(a.createdAt as string).getTime() - new Date(b.createdAt as string).getTime());
}

/**
 * TRUE only for a segment that is whole except for its root: every row has a
 * predecessor link, the links form one increasing linear chain, every stored
 * HMAC certifies, and the first row points at a hash no member carries.
 * Anything else (fork, cycle, two roots, broken HMAC) is NOT a lost root and
 * must keep failing the strict RESTORE_CHAIN check.
 */
export function isUnrootedAuditSegment(rows: Row[]): boolean {
  const members = auditMembers(rows);
  if (members.length === 0) return false;
  // A member without a predecessor IS a root: the segment is rooted (or has
  // more than one root, which the strict walk rejects on its own).
  if (members.some(row => row.previousHash == null)) return false;
  let previousHash: string | null = null;
  let previousTime: number | undefined;
  for (const row of members) {
    const time = new Date(row.createdAt as string).getTime();
    if (!Number.isFinite(time) || time === previousTime) return false;
    if (previousHash !== null && row.previousHash !== previousHash) return false;
    if (computeAuditHash(row as unknown as Parameters<typeof computeAuditHash>[0]) !== row.hash) return false;
    previousHash = row.hash as string;
    previousTime = time;
  }
  const first = members[0].previousHash;
  return typeof first === 'string' && first.length > 0 && !members.some(row => row.hash === first);
}

/**
 * Build the sealed re-anchor: a RESTORE_REBASE root plus the same segment rows
 * re-linked (and therefore re-hashed) under THIS installation's secret. Every
 * non-member row of the archive is preserved untouched; nothing is dropped and
 * no row changes its substance.
 */
export function planAuditRebase(
  segment: Row[],
  companyId: string,
  backupId: string,
  rebasedAt: Date = new Date(),
): AuditRebase {
  const members = auditMembers(segment);
  const originalPredecessorHash = String(members[0].previousHash);
  const rebasedAtIso = rebasedAt.toISOString();
  // The entry becomes the FIRST row of the restored timeline, so its createdAt
  // sits one millisecond before the segment it re-anchors: chain order and
  // chronological order must agree, or the merged-timeline certification (and
  // every later restore of this installation) would reject its own history.
  // The real instant is documented in details.rebasedAt.
  const createdAt = new Date(new Date(members[0].createdAt as string).getTime() - 1).toISOString();
  const rebase: Row = {
    id: crypto.randomUUID(),
    companyId,
    userId: null,
    action: 'RESTORE_REBASE',
    entity: 'Backup',
    entityId: backupId,
    details: JSON.stringify({ backupId, originalPredecessorHash, rebasedAt: rebasedAtIso }),
    hash: null,
    previousHash: null,
    createdAt,
  };
  rebase.hash = computeAuditHash(rebase as unknown as Parameters<typeof computeAuditHash>[0]);
  let previousHash = rebase.hash as string;
  const rebased = members.map(row => {
    const next: Row = { ...row, previousHash, hash: null };
    next.hash = computeAuditHash(next as unknown as Parameters<typeof computeAuditHash>[0]);
    previousHash = next.hash as string;
    return next;
  });
  const preserved = segment.filter(row => row.hash == null);
  return { backupId, originalPredecessorHash, rebasedAt: rebasedAtIso, rows: [rebase, ...rebased, ...preserved] };
}

/**
 * Company rows the product itself creates for a company: identity, membership,
 * module switches and per-company configuration. They carry no ledger and no
 * audit substance, so an installation holding only these holds no history a
 * re-anchored chain could falsify. EVERY other model is treated as history —
 * a model added to the schema later is history by default, never by omission.
 */
const COMPANY_SHELL_MODELS: ReadonlySet<string> = new Set([
  'Company', 'CompanyMember', 'CompanyModuleEntitlement', 'DetectionConfig', 'CsvLayoutProfile', 'EntityContext', 'SystemConfig',
]);

/** TRUE when the given company owns ledger/audit substance or a certified tail. */
function companyHasHistory(companyId: string, tables: Tables): boolean {
  const owned = ownedRows(companyId, tables);
  if (Object.entries(owned).some(([model, rows]) => !COMPANY_SHELL_MODELS.has(model) && rows.length > 0)) return true;
  if ((tables.AuditLog ?? []).some(row => row.companyId === companyId && row.hash != null)) return true;
  return (tables.JournalChainHead ?? []).some(head => head.companyId === companyId);
}

/**
 * S6 — "verifiably empty destination". Re-anchoring must never sit on top of
 * certified state it cannot certify, so it is admissible only when:
 *  1. NOT ONE AuditLog chain member exists anywhere. The chain is
 *     installation-wide, so a single hashed row anywhere means there is already
 *     a root this archive would falsify.
 *  2. No OTHER company of the installation carries history (ledger rows, chain
 *     members or a certified tail). Restoring into a live installation is a
 *     different operation (S4), never a silent re-anchor. Company shells that
 *     only carry the product's own configuration are not history, so a stale
 *     empty tenant cannot block a legitimate first restore.
 *  3. The destination users are exactly the ones this backup declares (the
 *     protocol shell); anybody else is real state, not a shell.
 *  4. The target has no journal chain head: no certified per-company tail is
 *     replaced by a re-based audit root.
 * Unhashed AuditLog rows are pre-chaining legacy history that no verification
 * walk consults, and the restore target's own rows are precisely what a restore
 * replaces under the existing ID/reference/inbound checks. Neither is "history".
 *
 * Returns null when the destination is verifiably empty, otherwise the reason.
 */
export function destinationEmptiness(source: Tables, destination: Tables, companyId: string): string | null {
  if ((destination.AuditLog ?? []).some(row => row.hash != null)) {
    return 'the destination audit chain already has members';
  }
  for (const company of destination.Company ?? []) {
    if (String(company.id) === companyId) continue;
    if (companyHasHistory(String(company.id), destination)) return 'the destination has another company with history';
  }
  const declared = new Set(source.User.map(row => row.id));
  if ((destination.User ?? []).some(row => !declared.has(row.id))) {
    return 'the destination has users outside the backup';
  }
  if ((destination.JournalChainHead ?? []).some(head => head.companyId === companyId)) {
    return 'the destination already has a journal chain head';
  }
  return null;
}

/* ─── S4 (T5): importing an archive as a NEW company ───────────────────
 * "¿qué pasa si tengo 5 empresas y quiero restaurar la 6 que está en un
 * backup?" — a super_admin creates an empty company and restores the archive
 * TARGETING it, without touching the companies that keep operating.
 *
 * Two facts shape the design:
 *  1. The company id is part of BOTH HMAC payloads (journal entries and audit
 *     rows: `companyId` is signed), so an archive cannot change tenant identity
 *     and keep its signatures. The journal chain is therefore RE-SEALED under
 *     the destination company id, with one sealed RESTORE_IMPORT_JOURNAL record
 *     documenting the source company, the source root/tail and the archive id.
 *     That is not a re-signing of evidence: the source chain was certified
 *     against its own identity before this ran (validateRestoreSource), and the
 *     accounting substance (ids, dates, amounts, lines, links, order) is
 *     untouched — only the tenant identity of the restored company differs.
 *  2. The audit chain is INSTALLATION-wide: a second segment inserted as chain
 *     members would fork the live chain of the running installation (S4 forbids
 *     that). The segment is imported as CLOSED HISTORICAL EVIDENCE: one
 *     RESTORE_IMPORT_HISTORICAL row per source row, `hash`/`previousHash` NULL
 *     so the live walk never consults it (the same tolerance the walk already
 *     gives pre-chaining rows), with the ORIGINAL row — including its certified
 *     HMAC, which validateRestoreSource already verified under this
 *     installation's secret — preserved verbatim inside `details.record`.
 *     Nothing is silently discarded and nothing fabricated is linked.
 * The T3 empty-installation re-anchor is a different operation and stays
 * exactly as it was: it is never reachable from this path.
 */
export const RESTORE_IMPORT_HISTORICAL = 'RESTORE_IMPORT_HISTORICAL';
export const RESTORE_IMPORT_JOURNAL = 'RESTORE_IMPORT_JOURNAL';

export interface CompanyImport {
  /** Company id the archive was signed with (documented evidence only). */
  readonly sourceCompanyId: string;
  /** Historical audit records to insert INSTEAD of the archive's audit rows. */
  readonly auditRows: Row[];
  /** Journal entries re-sealed under the destination company id. */
  readonly journalEntries: Row[];
  /** Destination chain head implied by the re-seal, or null without members. */
  readonly journalTail: { lastEntryId: string; lastHash: string } | null;
}

/**
 * S4 — "empty shell" predicate, scoped to ONE company (unlike
 * destinationEmptiness, which asks whether the whole installation is empty).
 * The shell notion is the T3 one: identity, membership, module switches and
 * per-company configuration are not history, nor is a chart of accounts with no
 * posting (the product seeds one when a company is created, and the import
 * replaces it wholesale). Anything else — ledger rows, a certified per-company
 * tail or an audit chain MEMBER — is history and makes the target inadmissible.
 */
const IMPORT_SHELL_MODELS: ReadonlySet<string> = new Set([...COMPANY_SHELL_MODELS, 'GlAccount']);

export function isCompanyShell(companyId: string, tables: Tables): boolean {
  const owned = ownedRows(companyId, tables);
  if (owned.Company.length !== 1) return false;
  for (const [model, rows] of Object.entries(owned)) {
    if (rows.length === 0 || model === 'AuditLog' || IMPORT_SHELL_MODELS.has(model)) continue;
    return false;
  }
  // Only chain MEMBERS (rows carrying a hash) are certified audit history;
  // unhashed rows are the product's own creation evidence and are replaced by
  // the import under the existing delete/insert contract.
  return !(tables.AuditLog ?? []).some(row => row.companyId === companyId && row.hash != null);
}

/** The archive's journal chain, re-sealed under the destination company id. */
function resealJournal(entries: Row[], lines: Row[], targetCompanyId: string): Pick<CompanyImport, 'journalEntries' | 'journalTail'> & {
  /** Chain head/tail the archive certified under its OWN company id. */
  sourceRootHash: string | null;
  sourceTailHash: string | null;
  sourceMembers: number;
} {
  const linesOf = (entryId: unknown): JournalHashLinePayload[] => lines
    .filter(line => line.entryId === entryId)
    .map(line => ({
      glAccountId: String(line.glAccountId),
      debit: line.debit as JournalHashLinePayload['debit'],
      credit: line.credit as JournalHashLinePayload['credit'],
      description: (line.description ?? null) as string | null,
    }));
  // Members in stored link order: validateRestoreSource already certified that
  // there is exactly one root and one successor per link (no fork, no orphan).
  const members = entries.filter(entry => entry.hash != null);
  const ordered: Row[] = [];
  let current = members.find(entry => entry.previousHash == null);
  while (current) {
    ordered.push(current);
    const link = current.hash;
    current = members.find(entry => entry.previousHash === link);
  }
  let previousHash: string | null = null;
  const resealed = ordered.map(row => {
    const next: Row = { ...row, companyId: targetCompanyId, previousHash };
    const payload = {
      id: String(row.id),
      companyId: targetCompanyId,
      description: String(row.description),
      reference: (row.reference ?? null) as string | null,
      previousHash,
      lines: linesOf(row.id),
    };
    next.hash = row.hashVersion === 'v2'
      ? computeEntryHashV2({ ...payload, date: new Date(row.date as string).toISOString() })
      : recomputeLegacyHash({ ...payload, date: new Date(row.date as string) });
    previousHash = next.hash as string;
    return next;
  });
  const tail = resealed[resealed.length - 1];
  return {
    journalEntries: [...resealed, ...entries.filter(entry => entry.hash == null).map(entry => ({ ...entry, companyId: targetCompanyId }))],
    journalTail: tail ? { lastEntryId: String(tail.id), lastHash: String(tail.hash) } : null,
    sourceRootHash: ordered.length ? (ordered[0].hash as string) : null,
    sourceTailHash: ordered.length ? (ordered[ordered.length - 1].hash as string) : null,
    sourceMembers: ordered.length,
  };
}

/** Historical audit rows: closed evidence, never members of the live chain. */
function historicalAuditRows(segment: Row[], targetCompanyId: string, sourceCompanyId: string,
  backupId: string, importedAt: string): Row[] {
  return segment.map(row => ({
    id: crypto.randomUUID(),
    companyId: targetCompanyId,
    userId: null,
    action: RESTORE_IMPORT_HISTORICAL,
    entity: 'Backup',
    entityId: backupId,
    details: JSON.stringify({ backupId, sourceCompanyId, targetCompanyId, importedAt, record: row }),
    hash: null,
    previousHash: null,
    createdAt: row.createdAt,
  }));
}

/** Everything the import writes instead of the archive's own rows. */
export function planCompanyImport(
  source: Tables,
  targetCompanyId: string,
  backupId: string,
  importedAt: Date = new Date(),
): CompanyImport {
  const sourceCompanyId = String(source.Company[0].id);
  const importedAtIso = importedAt.toISOString();
  const resealed = resealJournal(source.JournalEntry, source.JournalLine ?? [], targetCompanyId);
  // One sealed record documents WHY the destination journal chain had to be
  // re-sealed: the source identity and the source root/tail that certified first.
  const provenance: Row = {
    id: crypto.randomUUID(),
    companyId: targetCompanyId,
    userId: null,
    action: RESTORE_IMPORT_JOURNAL,
    entity: 'Backup',
    entityId: backupId,
    details: JSON.stringify({
      backupId,
      sourceCompanyId,
      targetCompanyId,
      importedAt: importedAtIso,
      sourceRootHash: resealed.sourceRootHash,
      sourceTailHash: resealed.sourceTailHash,
      sourceMembers: resealed.sourceMembers,
    }),
    hash: null,
    previousHash: null,
    createdAt: importedAtIso,
  };
  return {
    sourceCompanyId,
    auditRows: [provenance, ...historicalAuditRows(source.AuditLog, targetCompanyId, sourceCompanyId, backupId, importedAtIso)],
    journalEntries: resealed.journalEntries,
    journalTail: resealed.journalTail,
  };
}

export function validateRestoreDestination(source: Tables, all: Tables, companyId: string, backupId: string, options: {
  /**
   * S4 (T5): the archive belongs to ANOTHER company and this restore creates it
   * as a NEW company under `companyId`. Absent on every other path, so the
   * existing admission rules stay byte-for-byte identical.
   */
  importSourceCompanyId?: string | null;
} = {}): {
  owned: Tables;
  /** Set only when the historical audit segment had to be re-based (S6). */
  reanchor: AuditRebase | null;
  /** Set only when the archive is imported as a NEW company (S4/T5). */
  imported: CompanyImport | null;
} {
  const owned = ownedRows(companyId, all);
  if (owned.Company.length !== 1) fail('RESTORE_IDENTITY', 'destination company must already exist; not bootstrap');
  for (const user of source.User) {
    if (!all.User.some(u => u.id === user.id && u.email === user.email)) fail('RESTORE_MISSING_IDENTITY', String(user.id));
  }
  // Creating a company from an archive is only admissible on top of a company
  // that holds NOTHING: the product's own shell rows are replaced wholesale, and
  // no existing history may be silently dropped for a company identity that is
  // not the archive's (S4). Checked before anything else can mutate.
  if (options.importSourceCompanyId && !isCompanyShell(companyId, all)) {
    fail('RESTORE_SHELL',
      'la empresa destino debe estar vacía (sin movimientos, sin cadena de auditoría propia y sin historial contable) ' +
      'para restaurar un respaldo como empresa nueva');
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
  // S4 (T5): the archive is imported as a NEW company. Its audit segment is
  // stored as CLOSED HISTORICAL evidence (never a chain member, see
  // planCompanyImport), so there is no merged install-wide timeline to certify
  // here: not one live member is added or removed, which is exactly the
  // invariant the isolation tests pin. The archive's own journal chain and
  // per-row audit HMACs were already certified under its own company id by
  // validateRestoreSource.
  if (options.importSourceCompanyId) {
    return { owned, reanchor: null, imported: planCompanyImport(source, companyId, backupId) };
  }
  // AuditLog is an installation-wide chain, unlike the per-company journal.
  // Certifying isolated HMACs alone would allow deletion of a predecessor still
  // needed by another tenant. Certify the proposed merged timeline as well.
  const mergedAudit = [...all.AuditLog.filter(row => !owned.AuditLog.includes(row)), ...source.AuditLog]
    .filter(row => row.hash != null)
    .sort((a, b) => new Date(a.createdAt as string).getTime() - new Date(b.createdAt as string).getTime());
  let previousHash: string | null = null;
  let previousTime: number | undefined;
  let certified = true;
  for (const row of mergedAudit) {
    const time = new Date(row.createdAt as string).getTime();
    if (!Number.isFinite(time) || time === previousTime || row.previousHash !== previousHash ||
        computeAuditHash({ ...row, previousHash } as unknown as Parameters<typeof computeAuditHash>[0]) !== row.hash) {
      certified = false;
      break;
    }
    previousHash = row.hash as string; previousTime = time;
  }
  if (certified) return { owned, reanchor: null, imported: null };
  // S6 (T3): the archive's segment is whole except for the root it lost with the
  // old installation. Re-anchoring is admissible only when there is NOTHING to
  // certify against (empty destination) and the segment really is a single
  // linear chain whose own HMACs certify; the ownership credential was already
  // proved by the caller, before this validation ran. Everything else keeps the
  // unchanged refusal below.
  if (destinationEmptiness(source, all, companyId) === null && isUnrootedAuditSegment(source.AuditLog)) {
    return { owned, reanchor: planAuditRebase(source.AuditLog, companyId, backupId), imported: null };
  }
  fail('RESTORE_CHAIN', 'replacement cannot certify installation-wide audit order; preserve other tenants and do not re-sign');
}

export function scalarData(model: string, row: Row, snapshot: BackupData): Row {
  return Object.fromEntries(schema(model).fields.filter(f => f.kind !== 'object').map(field => {
    const value = row[field.name];
    if (field.type !== 'Json' || value !== null) return [field.name, value];
    return [field.name, field.isRequired || jsonNullKind(snapshot, model, row, field.name) === 'json-null'
      ? Prisma.JsonNull : Prisma.DbNull];
  }));
}
