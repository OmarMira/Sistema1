if (typeof process === 'undefined' || !process.versions?.node) {
  throw new Error('Requires Node.js runtime (not Edge)');
}

import crypto from 'node:crypto';
import type { BackupData } from './backup';
/**
 * `normalizeRestoredUserRole` is the ONE role normalizer the existing restore
 * paths already use: a backup payload can never grant `super_admin` on its own.
 * Imported from the restore-authority contract (not re-implemented) so an account
 * recreated by a portable recovery follows exactly the same rule.
 */
import { normalizeRestoredUserRole } from './backup-validation';
import {
  PORTABLE_LIMITS, PortableRecoveryError, portableCompanyEntityType,
  type PortableSourceSeal,
} from './backup-portable';
import { auditHistoryDigestOf, journalHistoryDigest, planAuditOverlapWithAttribution, auditOverlapExpectations, retainedOutsidePayload, type AuditAttributionProjection, type JournalHashLinePayload, type RecoveryArchive } from './journal-hash';

/**
 * Historical provenance for a portable bootstrap recovery.
 *
 * The source installation signs its journal and audit chains with ITS key
 * (`HMAC_SECRET`) and seals the snapshot with its `SESSION_SECRET`. A new
 * machine holds neither, so those values can never be recomputed locally — and
 * re-signing them would be indistinguishable from forging history.
 *
 * The supported answer is an explicit, verifiable archive boundary:
 *  - every historical row's exact canonical content (including its stored hash,
 *    previousHash and timestamp) is digested from the AEAD-authenticated payload;
 *  - `journal-hash` verification accepts those digests instead of recomputing
 *    the source HMAC, and fails when a stored row no longer matches its digest;
 *  - rows written locally AFTER the recovery verify with the local key as usual;
 *  - the archive digest itself is stored in provenance, and the whole thing is
 *    an archive boundary, not a claim that an HMAC proves authorship against an
 *    attacker who holds both the file and the password.
 */
export const RECOVERY_TRUST_BOUNDARY =
  'Source history is certified by the authenticated portable recovery container; the source installation key is ' +
  'unavailable on this machine, so stored source chain values are retained verbatim and never re-signed locally.';

export const RECOVERY_PROVENANCE_SCHEMA = 2 as const;

export class RecoveryProvenanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RecoveryProvenanceError';
  }
}

export interface RecoveryRowEvidence {
  id: string;
  /**
   * Digest of the row EXACTLY as this installation stores it. For a retained row
   * whose user reference the legacy FK erased, this is the nulled row's digest:
   * the archive never pretends the null content was signed. For a row with NO seal
   * on either side (T34) this digest IS the certification, so `assertDestinationAuditPreserved`
   * and every stored-evidence re-read fail closed when the bytes drift.
   */
  digest: string;
  /**
   * The source references the stored seal was VERIFIED with (see
   * `retainedAttributionHolds`). Optional and additive: records written before
   * this evidence existed keep their digest unchanged, and a record that only
   * needed one of them never gains the other.
   */
  projectedCompanyId?: string;
  projectedUserId?: string;
  /**
   * T34: the row was archived WITHOUT a seal (an unsealed legacy audit row). Recorded
   * explicitly so the absence is evidence in itself: verification then certifies the
   * STORED bytes of that row and still refuses drift, while a row archived WITH a seal
   * whose hash later disappears is reported as a defect instead of excused.
   */
  sealLess?: true;
  /**
   * T36: the row belongs to this installation but to NO event of the authenticated
   * payload (its audit section is company-scoped, so another tenant's rows and the
   * unowned rows a legacy company deletion left behind never travel). It is
   * RETAINED IN PLACE: the restore never deletes or rewrites it, so nothing is
   * re-proved against a source event that does not exist — `digest` above freezes
   * the bytes it stores and every later verification re-reads them.
   */
  outsidePayload?: true;
}

export interface RecoveryProvenance {
  schema: typeof RECOVERY_PROVENANCE_SCHEMA;
  kind: 'portable-bootstrap-recovery';
  companyId: string;
  ownerUserId: string;
  ownerEmail: string;
  /** SHA-256 of the exact uploaded container bytes. */
  fileDigest: string;
  /** SHA-256 of the decrypted, AEAD-authenticated payload. */
  payloadDigest: string;
  sourceSeal: PortableSourceSeal | null;
  trustBoundary: string;
  restoredAt: string;
  counts: Record<string, number | boolean>;
  /** Explicit, proven identity mapping (source owner id -> local account id). */
  identityMap: Record<string, string>;
  auditEvidence: RecoveryRowEvidence[];
  journalEvidence: RecoveryRowEvidence[];
  /** Digest over both evidence sets: self-consistency of the archive record. */
  historyDigest: string;
}

export interface ProvenanceRecorder {
  record(record: RecoveryProvenance): Promise<void>;
}

export interface AuditRow {
  id?: unknown;
  companyId?: unknown;
  userId?: unknown;
  action?: unknown;
  entity?: unknown;
  entityId?: unknown;
  details?: unknown;
  hash?: unknown;
  previousHash?: unknown;
  createdAt?: unknown;
}

export interface JournalRow {
  id?: unknown;
  companyId?: unknown;
  date?: unknown;
  description?: unknown;
  reference?: unknown;
  status?: unknown;
  hash?: unknown;
  previousHash?: unknown;
  hashVersion?: unknown;
  lines?: unknown;
}

function requireString(value: unknown, label: string, maxLength = 320): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new RecoveryProvenanceError('RECOVERY_PROVENANCE_INVALID', label);
  }
  return value;
}

/** Optional evidence field: absent, or a non-empty string. Never materialized. */
function optionalIdentifier(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

function evidenceDigest(evidence: readonly RecoveryRowEvidence[]): string {
  return crypto.createHash('sha256')
    .update(evidence.map((entry) => `${entry.id}:${entry.digest}`).sort().join('|'))
    .digest('hex');
}

/**
 * Self-consistency digest of one archive record.
 *
 * Canonical and order-independent on purpose: entries are re-serialized with a
 * fixed field order and absent optional fields are NEVER materialized, so (a) a
 * JSONB round-trip — PostgreSQL does not preserve object key order — can never
 * make a genuine record look rewritten, and (b) records written before
 * `projectedCompanyId` existed keep exactly their original digest.
 */
function historyDigestOf(
  audit: readonly RecoveryRowEvidence[],
  journal: readonly RecoveryRowEvidence[],
): string {
  const canonical = (entry: RecoveryRowEvidence) => {
    const out: {
      id: string; digest: string; projectedUserId?: string; projectedCompanyId?: string;
      sealLess?: true; outsidePayload?: true;
    } = {
      id: entry.id,
      digest: entry.digest,
    };
    if (entry.projectedUserId !== undefined) out.projectedUserId = entry.projectedUserId;
    if (entry.projectedCompanyId !== undefined) out.projectedCompanyId = entry.projectedCompanyId;
    if (entry.sealLess === true) out.sealLess = true;
    if (entry.outsidePayload === true) out.outsidePayload = true;
    return out;
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify({ audit: audit.map(canonical), journal: journal.map(canonical) }))
    .digest('hex');
}

export function auditEvidenceOf(rows: readonly AuditRow[]): RecoveryRowEvidence[] {
  return rows
    // Canonical audit normalization is shared with the restore validator and the
    // chain verifier (journal-hash), so a stored row, its authenticated snapshot
    // copy and its archive entry always digest identically.
    .map((row) => ({ id: String(row.id), digest: auditHistoryDigestOf(row) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function journalEvidenceOf(rows: readonly JournalRow[]): RecoveryRowEvidence[] {
  return rows
    .map((row) => {
      const lines = Array.isArray(row.lines) ? row.lines as JournalHashLinePayload[] : [];
      return {
        id: String(row.id),
        digest: journalHistoryDigest({
          id: String(row.id),
          companyId: String(row.companyId ?? ''),
          date: row.date instanceof Date ? row.date : new Date(String(row.date)),
          description: String(row.description ?? ''),
          reference: row.reference == null ? null : String(row.reference),
          status: String(row.status ?? ''),
          hash: row.hash == null ? null : String(row.hash),
          previousHash: row.previousHash == null ? null : String(row.previousHash),
          hashVersion: row.hashVersion == null ? null : String(row.hashVersion),
          lines,
        }),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function buildRecoveryProvenance(input: {
  snapshot: BackupData;
  ownerUserId: string;
  ownerEmail: string;
  fileDigest: string;
  payloadDigest: string;
  identityMap: Record<string, string>;
  restoredAt: string;
  /**
   * Rows exactly as they will be STORED (the proven identity map is already
   * applied). Evidence is computed over stored content so verification can
   * detect any later rewrite, including a wrong userId.
   */
  auditRows?: readonly AuditRow[];
  journalRows?: readonly JournalRow[];
  /**
   * Same-installation recovery: audit ids whose event this installation already
   * retains verbatim (certified by the restore validator in the same
   * transaction). Their evidence is the digest of the STORED retained row, which
   * is the authenticated event's canonical content; nothing is re-signed.
   */
  reusedAuditEvidence?: ReadonlyMap<string, string>;
  /**
   * Retained audit ids whose company and/or user reference the legacy
   * `ON DELETE SET NULL` foreign keys erased, with the source references their
   * stored seal was verified with. Recorded so every later chain verification
   * re-proves the ORIGINAL signature instead of trusting a label.
   *
   * T34: also supplied for a row with NO seal on either side, where the canonical
   * comparison is the whole proof; there the recorded digest of the STORED bytes is
   * the evidence and no signature is implied.
   */
  auditProjections?: ReadonlyMap<string, AuditAttributionProjection>;
  /**
   * Preserved destination rows the authenticated payload does NOT carry (T36).
   * Derived by the caller from the SAME expectation set the overlap planner uses
   * (`retainedOutsidePayload`), so the archive covers every preserved row with the
   * classification admission already made. Their evidence is the digest of their
   * STORED bytes plus the explicit `outsidePayload` marker, and — for a row that
   * carries no seal at all — the `sealLess` marker as before.
   */
  retainedAuditRows?: readonly AuditRow[];
}): RecoveryProvenance {
  const integrity = input.snapshot.manifest.integrity;
  const reused = input.reusedAuditEvidence;
  const projections = input.auditProjections;
  const storedRows = input.auditRows ?? (input.snapshot.data.auditLogs ?? []) as AuditRow[];
  // T34: which evidence entries describe a row stored WITHOUT a seal. The marker is
  // written explicitly because such a row has no HMAC to re-prove: its certification
  // is the digest below, and every consumer can then tell an archived absence from a
  // seal that disappeared.
  const sealLessIds = new Set(storedRows
    .filter((row) => row.hash == null)
    .map((row) => String(row.id)));
  const auditEvidence = auditEvidenceOf(storedRows)
    .map((entry) => {
      const stored = reused?.get(entry.id);
      const projection = projections?.get(entry.id);
      const documented: RecoveryRowEvidence = stored === undefined
        ? { id: entry.id, digest: entry.digest }
        : { id: entry.id, digest: stored };
      // Only the references that were actually erased are recorded; nothing else
      // is materialized, so older evidence keeps its exact digest.
      if (projection?.companyId !== undefined) documented.projectedCompanyId = projection.companyId;
      if (projection?.userId !== undefined) documented.projectedUserId = projection.userId;
      if (sealLessIds.has(entry.id)) documented.sealLess = true;
      return documented;
    });
  // T36: EVERY preserved row is covered. A row the payload does not carry keeps its
  // stored bytes as evidence and is marked explicitly, so no later verification can
  // mistake it for an overlap-attested source event (there is none) or for a
  // locally recomputable one (its seal may cover destroyed references).
  const retainedRows = input.retainedAuditRows ?? [];
  for (const entry of auditEvidenceOf(retainedRows)) {
    if (auditEvidence.some((existing) => existing.id === entry.id)) continue;
    const documented: RecoveryRowEvidence = {
      id: entry.id, digest: entry.digest, outsidePayload: true,
    };
    if (retainedRows.some((row) => String(row.id) === entry.id && row.hash == null)) {
      documented.sealLess = true;
    }
    auditEvidence.push(documented);
  }
  const journalEvidence = journalEvidenceOf(input.journalRows ?? (input.snapshot.data.journalEntries ?? []) as JournalRow[]);
  return {
    schema: RECOVERY_PROVENANCE_SCHEMA,
    kind: 'portable-bootstrap-recovery',
    companyId: requireString(input.snapshot.manifest.companyId, 'companyId', 191),
    ownerUserId: requireString(input.ownerUserId, 'ownerUserId', 191),
    ownerEmail: requireString(input.ownerEmail, 'ownerEmail', 254),
    fileDigest: requireString(input.fileDigest, 'fileDigest', 64),
    payloadDigest: requireString(input.payloadDigest, 'payloadDigest', 64),
    sourceSeal: integrity
      ? {
          algorithm: requireString(integrity.algorithm, 'sourceSeal.algorithm', 32),
          authenticated: integrity.authenticated === true,
          digest: requireString(integrity.digest, 'sourceSeal.digest', 128),
        }
      : null,
    trustBoundary: RECOVERY_TRUST_BOUNDARY,
    restoredAt: requireString(input.restoredAt, 'restoredAt', 40),
    counts: { ...(input.snapshot.manifest.recordCounts as unknown as Record<string, number | boolean>) },
    identityMap: { ...input.identityMap },
    auditEvidence,
    journalEvidence,
    historyDigest: historyDigestOf(auditEvidence, journalEvidence),
  };
}

/** Parsed archive of one provenance record; refuses records that altered themselves. */
function archiveOf(value: unknown): { audit: RecoveryRowEvidence[]; journal: RecoveryRowEvidence[] } {
  if (!value || typeof value !== 'object') throw new RecoveryProvenanceError('RECOVERY_PROVENANCE_INVALID', 'record');
  const record = value as Partial<RecoveryProvenance>;
  const audit = Array.isArray(record.auditEvidence) ? record.auditEvidence : null;
  const journal = Array.isArray(record.journalEvidence) ? record.journalEvidence : null;
  if (!audit || !journal) throw new RecoveryProvenanceError('RECOVERY_PROVENANCE_INVALID', 'evidence');
  if (record.historyDigest !== historyDigestOf(audit, journal)) {
    throw new RecoveryProvenanceError('RECOVERY_PROVENANCE_INVALID', 'historyDigest');
  }
  for (const entry of [...audit, ...journal]) {
    if (!entry || typeof entry.id !== 'string' || !entry.id ||
        typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest) ||
        !optionalIdentifier(entry.projectedUserId) ||
        !optionalIdentifier(entry.projectedCompanyId) ||
        (entry.sealLess !== undefined && entry.sealLess !== true) ||
        (entry.outsidePayload !== undefined && entry.outsidePayload !== true)) {
      throw new RecoveryProvenanceError('RECOVERY_PROVENANCE_INVALID', 'evidence entry');
    }
  }
  return { audit, journal };
}

/**
 * PostgreSQL "undefined_table" (SQLSTATE 42P01), wrapped by Prisma as
 * P2010/meta.code. It means the archive table was never created here, which is
 * a normal state for an installation that was never recovered — NOT an
 * unreadable archive.
 */
function isMissingProvenanceRelation(error: unknown): boolean {
  const meta = (error as { meta?: { code?: unknown; message?: unknown } } | null | undefined)?.meta;
  const codes = [(error as { code?: unknown } | null | undefined)?.code, meta?.code]
    .filter((value): value is string => typeof value === 'string');
  if (codes.includes('42P01')) return true;
  const text = [
    (error as { message?: unknown } | null | undefined)?.message,
    meta?.message,
  ].filter((value): value is string => typeof value === 'string').join(' ');
  return /42P01/.test(text) || /relation\s+"?BootstrapRecoveryProvenance"?\s+does not exist/i.test(text);
}

/**
 * Archive map used by journal-hash verification. The two "nothing to read"
 * states stay distinct so the caller never mistakes one for the other:
 *  - no archive table on this installation -> RECOVERY_PROVENANCE_ABSENT, which
 *    the verifier treats as "no portable recovery ever happened here" and keeps
 *    the strict local HMAC contract;
 *  - a table that exists but cannot be read (query failure, or a record that
 *    fails its own digest) -> an error, so verification fails closed with
 *    ARCHIVE_UNAVAILABLE instead of a misleading tamper verdict.
 * Neither path ever exempts a row.
 */
export async function loadRecoveryEvidence(
  kind: 'audit' | 'journal',
  companyId: string | null,
): Promise<Map<string, RecoveryRowEvidence>> {
  const { db } = await import('@/lib/db');
  const client = db as unknown as {
    $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  };
  let rows: Array<{ provenance: unknown }>;
  try {
    rows = companyId
      ? await client.$queryRawUnsafe<Array<{ provenance: unknown }>>(
          `SELECT provenance FROM "BootstrapRecoveryProvenance" WHERE "companyId" = $1`, companyId)
      : await client.$queryRawUnsafe<Array<{ provenance: unknown }>>(
          `SELECT provenance FROM "BootstrapRecoveryProvenance"`);
  } catch (error) {
    if (isMissingProvenanceRelation(error)) {
      throw new RecoveryProvenanceError('RECOVERY_PROVENANCE_ABSENT',
        'this installation has no portable recovery archive table');
    }
    throw error;
  }
  const map = new Map<string, RecoveryRowEvidence>();
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    let archive: { audit: RecoveryRowEvidence[]; journal: RecoveryRowEvidence[] };
    try {
      archive = archiveOf(row?.provenance);
    } catch {
      // A record that does not match its own digest cannot certify anything.
      // Skipping it silently would hide integrity evidence and downgrade the
      // verdict to a tamper code, so the archive is reported as unreadable.
      throw new RecoveryProvenanceError('RECOVERY_PROVENANCE_UNREADABLE',
        'a recovery archive record does not match its own history digest');
    }
    for (const entry of kind === 'audit' ? archive.audit : archive.journal) map.set(entry.id, entry);
  }
  return map;
}

/** Constant SQL identifiers, bound values, JSONB payload. */
export interface ProvenanceRawClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export function createPostgresProvenanceRecorder(client: ProvenanceRawClient): ProvenanceRecorder {
  return {
    async record(record) {
      await client.$executeRawUnsafe(
        `INSERT INTO "BootstrapRecoveryProvenance"
           (id,"companyId","ownerUserId","sourceDigest","credentialDigest","sourceSealAlgorithm",provenance,"createdAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        crypto.randomUUID(), record.companyId, record.ownerUserId, record.payloadDigest,
        record.fileDigest, record.sourceSeal?.algorithm ?? 'none', JSON.stringify(record),
        new Date(record.restoredAt),
      );
    },
  };
}

/* ─── Destination restore ───────────────────────────────────────────── */

export interface PortableRestoreRequest {
  snapshot: BackupData;
  fileText: string;
  fileDigest: string;
  payloadDigest: string;
  ownerUserId: string;
  ownerEmail: string;
  ownerPassword: string;
}

/**
 * WHERE the authenticated portable payload lands (S23 / S24).
 *
 *  - `initialize` (default): the anonymous first-installation import. The
 *    destination must not contain companies and the backup's own company is
 *    created. This is the original contract, byte-identical.
 *  - `company`: a session-scoped door that targets ONE company. With
 *    `companyId` omitted the target is the company sealed in the opened payload
 *    (S23: Administración de Empresas adds the backup's company); with
 *    `companyId` supplied the target is that existing company (S24: Respaldos
 *    del Sistema replaces the ACTIVE company).
 *
 * `createIfAbsent` decides what an existing/absent target means:
 *  - true: the company is created when absent and REFUSED when present (adding
 *    a company this installation already has would overwrite it; that case is
 *    the settings door's, which replaces in place);
 *  - false/omitted: the company must already exist (replace), and an absent one
 *    is refused.
 * Everything else — identity reconciliation, retained-audit capture, admission
 * archive and the post-commit provenance proof — is the SAME code for every
 * mode, so the two new doors cannot certify less than the bootstrap flow.
 */
export type PortableDestinationTarget =
  | { mode: 'initialize' }
  | { mode: 'company'; companyId?: string; createIfAbsent?: boolean };

export type PortableRestoreResult =
  | {
      status: 'committed';
      operationId: string;
      sessionUserId: string;
      counts: Record<string, number | boolean>;
    }
  | { status: 'refused'; httpStatus: number; code: string; message: string }
  | { status: 'reconciliation_required'; operationId: string; code: string; message: string };

export interface PortableCoordinatedRestoreResult {
  status: 'committed' | 'reconciliation_required' | 'aborted';
  operationId: string;
  counts?: Record<string, number | boolean>;
  error?: string;
}

/** Minimal structural Prisma surface; the caller supplies the guarded client. */
export interface PortableDestinationClient {
  $transaction<T>(work: (tx: PortableDestinationClient) => Promise<T>): Promise<T>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  user: {
    findUnique(query: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
    /** Destination identities of this installation (id + email only). */
    findMany(query?: { select?: { id: true; email: true } }): Promise<Array<Record<string, unknown>>>;
    create(query: { data: Record<string, unknown> }): Promise<unknown>;
    deleteMany(query: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  company: {
    count(): Promise<number>;
    findUnique(query: { where: { id: string } }): Promise<Record<string, unknown> | null>;
    create(query: { data: Record<string, unknown> }): Promise<unknown>;
    deleteMany(query: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  companyMember: {
    findUnique(query: { where: { userId_companyId: { userId: string; companyId: string } } }): Promise<Record<string, unknown> | null>;
    create(query: { data: Record<string, unknown> }): Promise<unknown>;
    deleteMany(query: { where: Record<string, unknown> }): Promise<{ count: number }>;
  };
  journalEntry: {
    count(query: { where: Record<string, unknown> }): Promise<number>;
    findMany(query: { where: Record<string, unknown>; include?: { lines: true } }): Promise<JournalRow[]>;
  };
  bankStatement: {
    count(query: { where: Record<string, unknown> }): Promise<number>;
  };
  auditLog: {
    count(): Promise<number>;
    findMany(query?: { where?: { companyId?: string } }): Promise<AuditRow[]>;
  };
}

export interface PortableDestinationRestoreOptions {
  client: PortableDestinationClient;
  provenance: ProvenanceRecorder;
  now?: () => Date;
  /**
   * Destination mode (S23/S24). Omitted means `{ mode: 'initialize' }`, i.e. the
   * unchanged zero-installation import.
   */
  target?: PortableDestinationTarget;
  hashPassword: (password: string) => Promise<string>;
  /** Canonical bcrypt verification, used only to prove a local account (S4). */
  verifyPassword: (password: string, hash: string) => Promise<boolean>;
  coordinatedRestore: (
    companyId: string,
    text: string,
    options: {
      recovery: 'portable';
      authenticatedDigest: string;
      /** Authenticated archive of earlier recoveries (audit id -> digest/attribution). */
      auditArchive?: RecoveryArchive;
    },
    identityMap: Record<string, string>,
  ) => Promise<PortableCoordinatedRestoreResult>;
  /**
   * Evidence recorded by earlier portable recoveries on this installation.
   * Undefined means "no archive here" (a normal local installation). A thrown
   * error is reported as an unreadable archive and refuses the restore: retained
   * history could otherwise be preserved without being certifiable.
   */
  readAuditArchive?: () => Promise<RecoveryArchive | undefined>;
  /**
   * Re-closes the maintenance gate when a post-commit proof cannot be produced:
   * the database already changed, so the installation must stay fenced until an
   * operator reconciles it.
   */
  closeMaintenance?: () => Promise<void>;
}

interface CreatedRows {
  company: boolean;
  member: boolean;
  /**
   * Every ACCOUNT this attempt created: the owner shell plus the source users
   * recreated by `prepareSourceIdentities`. Only these may ever be deleted again.
   */
  users: string[];
}

class DestinationNotEmpty extends Error {}

/** S23: the door adds a company; it never overwrites one that already exists. */
class DestinationCompanyExists extends Error {}

/** S24/company target: the destination company must exist to be replaced. */
class DestinationCompanyMissing extends Error {}

/**
 * A source account cannot be resolved here: the source id already belongs to a
 * DIFFERENT person and no local account holds the source email. Refusing is the
 * only honest answer (no overwrite, no takeover, no invented identity).
 */
class SourceIdentityConflict extends Error {
  constructor(readonly sourceUserId: string) {
    super('Source identity conflict');
    this.name = 'SourceIdentityConflict';
  }
}

/** Email identity is case-insensitive in this application. */
function identityEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function refused(httpStatus: number, code: string, message: string): PortableRestoreResult {
  return { status: 'refused', httpStatus, code, message };
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && /^(RESTORE|RECOVERY)_[A-Z_]+/.test(error.message)) return error.message;
  return 'The backup could not be restored into this installation';
}

export function createPortableDestinationRestore(options: PortableDestinationRestoreOptions) {
  const now = options.now ?? (() => new Date());
  const client = options.client;
  const target: PortableDestinationTarget = options.target ?? { mode: 'initialize' };

  /**
   * Remove ONLY rows proven created by this attempt: the flags come from a
   * COMMITTED transaction, the lease serializes other recovery attempts, and a
   * company that already received business data is never deleted.
   */
  async function discard(
    created: CreatedRows,
    target: { companyId: string; sessionUserId: string },
  ): Promise<void> {
    if (created.users.length === 0 && !created.company && !created.member) return;
    try {
      const journals = await client.journalEntry.count({ where: { companyId: target.companyId } });
      const statements = await client.bankStatement.count({ where: { companyId: target.companyId } });
      if (journals > 0 || statements > 0) return;
      await client.$transaction(async (tx) => {
        if (created.member) {
          // Only the membership this attempt created for the owner session
          // account; restored member rows are inserted by the replacement itself.
          await tx.companyMember.deleteMany({
            where: { userId: target.sessionUserId, companyId: target.companyId },
          });
        }
        if (created.company) await tx.company.deleteMany({ where: { id: target.companyId } });
        // Only the ACCOUNTS this attempt created (owner shell + recreated source
        // users) are removable; a pre-existing local identity is never touched.
        for (const userId of created.users) await tx.user.deleteMany({ where: { id: userId } });
      });
    } catch {
      // Cleanup failure is never reported as a successful restore.
    }
  }

  return async function restore(request: PortableRestoreRequest): Promise<PortableRestoreResult> {
    const snapshot = request.snapshot;
    const sealedCompanyId = snapshot.manifest.companyId;
    // The destination mode decides WHICH company receives the data. `initialize`
    // keeps the authenticated payload's own company; `company` targets one
    // explicit company (the backup's own when no id is supplied).
    const companyId = target.mode === 'company'
      ? (target.companyId ?? sealedCompanyId)
      : sealedCompanyId;
    if (target.mode === 'company' && companyId !== sealedCompanyId) {
      // Defence in depth: the engine already refused this before any token
      // existed. A destination that is not the company sealed inside the opened
      // payload can never be certified, so refuse instead of writing elsewhere.
      return refused(400, 'RECOVERY_ACTIVE_COMPANY_MISMATCH',
        'The opened backup belongs to a different company than the destination of this restore.');
    }
    const ownerEmail = request.ownerEmail.trim().toLowerCase();

    // 1. Identity conflicts resolve before anything is created or deleted.
    const existingById = await client.user.findUnique({ where: { id: request.ownerUserId } });
    if (existingById && String(existingById.email ?? '').trim().toLowerCase() !== ownerEmail) {
      return refused(409, 'RECOVERY_IDENTITY_CONFLICT',
        'This installation already has a different account with the source owner identifier.');
    }
    const existingByEmail = await client.user.findUnique({ where: { email: ownerEmail } });
    let identityMap: Record<string, string> = {};
    let sessionUserId = request.ownerUserId;
    if (existingByEmail) {
      // S4: the same person may already be registered locally with the same
      // email but a DIFFERENT id. Reuse is allowed only after proving that local
      // account with the supplied password; its credentials and role are never
      // rewritten and it is never deleted.
      const localId = String(existingByEmail.id ?? '');
      if (!localId) {
        return refused(409, 'RECOVERY_IDENTITY_CONFLICT', 'A conflicting local account could not be identified.');
      }
      if (existingById && String(existingById.id) !== localId) {
        return refused(409, 'RECOVERY_IDENTITY_CONFLICT',
          'This installation has two different accounts claiming the source owner identity.');
      }
      if (localId !== request.ownerUserId) {
        const localHash = typeof existingByEmail.passwordHash === 'string' ? existingByEmail.passwordHash : '';
        const proven = localHash.length > 0 &&
          await options.verifyPassword(request.ownerPassword, localHash);
        if (!proven) {
          // F7 (S4): this refusal happens AFTER the owner password opened the
          // file and the owner-email token was consumed, so the only missing
          // condition is that the SAME password must also open the local
          // account. The previous copy told the operator to "sign in with that
          // account", which is false — recovery never reads a local session —
          // and following it produced the identical refusal again. The text now
          // names the real cause (a different local password), the real remedy
          // (make both passwords the same) and identifies no sealed input, so
          // no oracle is added.
          return refused(409, 'RECOVERY_LOCAL_ACCOUNT_LOGIN_REQUIRED',
            'This installation already has a local account with the same email, and its password differs ' +
            'from the one that opens this backup. Recovery needs BOTH to be the same password: sign in to ' +
            'the local account, change it to the password that opens the backup and start the recovery ' +
            'again. Nothing was changed.');
        }
        identityMap = { [request.ownerUserId]: localId };
        sessionUserId = localId;
      }
    }

    // 2. Final emptiness check + shell creation in ONE transaction under an
    //    advisory lock, so two concurrent attempts (even with different files)
    //    can never both prepare a destination.
    //
    //    Only COMPANIES make an installation non-empty. Retained audit history
    //    (rows of a company that was deleted later, which the schema keeps on
    //    purpose) is evidence: it is captured here byte-for-byte and proven
    //    unchanged after the replacement, never deleted and never re-signed.
    let archive: RecoveryArchive | undefined;
    try {
      archive = await options.readAuditArchive?.();
    } catch (error) {
      return refused(409, 'RECOVERY_PROVENANCE_UNREADABLE',
        'The recovery archive of this installation could not be read, so its retained history cannot be certified. ' +
        failureMessage(error));
    }
    let created: CreatedRows;
    /**
     * TWO reads of the SAME prepare transaction, with TWO different roles (T42):
     *  - `retainedRows` is EVERY row the installation keeps — the exact read-set the
     *    admission validator certified over (`backup-validation.ts` reads the whole
     *    `AuditLog` table) — and it feeds the overlap planner and the payload-absent
     *    classification, so the post-commit proof can never see less than admission
     *    did (T36 invariant);
     *  - `preservedRows` excludes a company-scoped door's OWN target-company rows,
     *    which are that replacement's scope, and is what
     *    `assertDestinationAuditPreserved` re-checks byte-identically.
     */
    let retainedRows: AuditRow[];
    let preservedRows: AuditRow[];
    try {
      const prepared = await client.$transaction(async (tx) => {
        // `pg_advisory_xact_lock` returns void, which Prisma cannot deserialize
        // (it failed with "Failed to deserialize column of type 'void'"). The
        // same text lock is proven through a concrete column, exactly like the
        // coordinated restore does it.
        await tx.$queryRawUnsafe(
          `SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))`, 'portable-bootstrap-recovery');
        // The emptiness gate is the CONTRACT OF THE `initialize` MODE only: a
        // session door targets one explicit company and decides here whether that
        // company is created (S23, absent) or replaced (S24, present).
        let createCompany = true;
        if (target.mode === 'initialize') {
          const companies = await tx.company.count();
          if (companies > 0) throw new DestinationNotEmpty();
        } else {
          const existingCompany = await tx.company.findUnique({ where: { id: companyId } });
          if (existingCompany) {
            if (target.createIfAbsent === true) throw new DestinationCompanyExists();
            createCompany = false;
          } else if (target.createIfAbsent !== true) {
            throw new DestinationCompanyMissing();
          }
        }
        const flags: CreatedRows = { company: false, member: false, users: [] };
        if (!existingById && !existingByEmail) {
          await tx.user.create({
            data: {
              id: request.ownerUserId,
              email: ownerEmail,
              passwordHash: await options.hashPassword(request.ownerPassword),
              firstName: '',
              lastName: '',
              platformRole: 'super_admin',
              emailVerifiedAt: now(),
              legacyUser: true,
            },
          });
          flags.users.push(request.ownerUserId);
        }
        // F1 (S2/S4/S15): the snapshot may carry MORE than the owner. A brand-new
        // machine has none of them, and `validateRestoreDestination` — correctly,
        // including for every non-portable restore — refuses a source user that is
        // absent here with its own id+email. Reconciling them is therefore the
        // PREPARE step's job, inside the same locked transaction, so the
        // destination read-set a moment later already matches:
        //  - same id and same email: that account already IS this person; it is
        //    left byte-identical (never rewritten, never promoted);
        //  - same email, other id: the documented S4 case. The local account is
        //    reused through the explicit identity map — never re-hashed, never
        //    promoted — so memberships and audit attribution follow the mapping;
        //  - otherwise the account is recreated from the AUTHENTICATED snapshot,
        //    with no usable credential (the backup never contains one) and WITHOUT
        //    the source platform role: a backup alone never grants global
        //    authority. Its tenant role comes from the restored membership row.
        //  - a source id already held by a DIFFERENT person while nobody holds the
        //    source email is unresolvable: refuse and roll everything back.
        const identity: Record<string, string> = { ...identityMap };
        const sourceUsers = Array.isArray(snapshot.data.users)
          ? snapshot.data.users as unknown as Array<Record<string, unknown>>
          : [];
        const known = await tx.user.findMany({ select: { id: true, email: true } });
        const byId = new Map(known.map((row) => [String(row.id), row]));
        const byEmail = new Map(known.map((row) => [identityEmail(row.email), row]));
        for (const row of sourceUsers) {
          const sourceId = typeof row.id === 'string' ? row.id : '';
          const email = identityEmail(row.email);
          if (!sourceId || !email || sourceId === request.ownerUserId) continue;
          const sameId = byId.get(sourceId);
          if (sameId && identityEmail(sameId.email) === email) continue;
          const sameEmail = byEmail.get(email);
          if (sameEmail) {
            const localId = String(sameEmail.id ?? '');
            if (!localId) throw new SourceIdentityConflict(sourceId);
            if (localId !== sourceId) identity[sourceId] = localId;
            continue;
          }
          if (sameId) throw new SourceIdentityConflict(sourceId);
          const account = {
            id: sourceId,
            email: typeof row.email === 'string' ? row.email : email,
            // Random, unknown secret: Prisma needs a hash, the operator must
            // re-secure this account after the recovery. Never an empty or
            // guessable credential, and never the source credential (it is not
            // exported at all).
            passwordHash: await options.hashPassword(crypto.randomBytes(24).toString('base64url')),
            firstName: typeof row.firstName === 'string' ? row.firstName : '',
            lastName: typeof row.lastName === 'string' ? row.lastName : '',
            platformRole: normalizeRestoredUserRole(row.role, {}),
            isActive: typeof row.isActive === 'boolean' ? row.isActive : true,
            // No local proof of email verification: fail closed for this account.
            emailVerifiedAt: null,
            legacyUser: false,
          };
          await tx.user.create({ data: account });
          flags.users.push(sourceId);
          byId.set(sourceId, account);
          byEmail.set(email, account);
        }
        if (createCompany) {
          await tx.company.create({
            data: {
              id: companyId,
              legalName: snapshot.manifest.companyInfo.legalName,
              entityType: portableCompanyEntityType(snapshot),
              taxId: snapshot.manifest.companyInfo.taxId ?? null,
            },
          });
          flags.company = true;
        }
        const member = await tx.companyMember.findUnique({
          where: { userId_companyId: { userId: sessionUserId, companyId } },
        });
        if (!member) {
          await tx.companyMember.create({ data: { userId: sessionUserId, companyId, role: 'company_admin' } });
          flags.member = true;
        }
        // Evidence of the destination's own audit history, read inside the same
        // transaction that proves the destination the restore targets. The ROWS are
        // returned too: the post-commit proof re-derives their digest and the
        // attribution proof from this same transaction read-set.
        const existing = await tx.auditLog.findMany({});
        // A company-scoped door REPLACES that company's data, so its own rows are
        // the replacement's scope, not history `assertDestinationAuditPreserved`
        // must see survive. That is the ONLY role of this filter (T38).
        //
        // It must never narrow the read-set the OVERLAP PROOF uses (T42):
        // `AuditLog` rows are never deleted by any restore (the application has no
        // audit delete path at all, and a reused id is skipped instead of
        // re-inserted), so a target-company row is retained history like any other —
        // and admission already certified it. Filtering it out here hid its attested
        // reuse/projection evidence, so the payload-derived digest was archived for a
        // row stored with erased references and the post-commit proof reported the
        // untouched row as "rewritten" (the reported RECOVERY_HISTORY_LOST), while a
        // payload-absent target-scoped row was neither archived nor asserted.
        const preserved = target.mode === 'initialize'
          ? existing
          : existing.filter((row) => row.companyId !== companyId);
        return { flags, retained: existing, preserved, identity };
      });
      created = prepared.flags;
      retainedRows = prepared.retained;
      preservedRows = prepared.preserved;
      // The reconciled map (owner + any reused same-email account) is what the
      // coordinator, the replacement and the recorded evidence must use.
      identityMap = prepared.identity;
    } catch (error) {
      if (error instanceof DestinationNotEmpty) {
        return refused(409, 'DB_NOT_EMPTY',
          'This installation already contains companies and cannot be initialized from a backup.');
      }
      if (error instanceof DestinationCompanyExists) {
        return refused(409, 'RECOVERY_COMPANY_EXISTS',
          'This installation already has this company. Restore its data from Configuracion > Respaldos ' +
          'del Sistema instead of adding it again; nothing was changed.');
      }
      if (error instanceof DestinationCompanyMissing) {
        return refused(409, 'RECOVERY_COMPANY_NOT_FOUND',
          'The company this restore targets does not exist on this installation. Nothing was changed.');
      }
      if (error instanceof SourceIdentityConflict) {
        // Never name the identifier: this reaches an anonymous caller.
        return refused(409, 'RECOVERY_IDENTITY_CONFLICT',
          'This installation already has a different account for one of the accounts in the backup, ' +
          'and no local account holds that email, so the backup cannot be restored without ' +
          'overwriting an existing identity. Nothing was changed.');
      }
      // The transaction rolled back: NOTHING was created, so nothing is deleted.
      return refused(500, 'RECOVERY_PREPARE_FAILED',
        `The destination installation could not be prepared. ${failureMessage(error)}`);
    }

    // 3. The existing coordinated replacement, in its portable source mode.
    let result: PortableCoordinatedRestoreResult;
    try {
      // The coordinator validates a SNAPSHOT document. These bytes come from the
      // container the caller just AEAD-authenticated (never from the wire), and
      // the portable reader requires that authenticated digest.
      result = await options.coordinatedRestore(
        companyId,
        JSON.stringify(request.snapshot),
        { recovery: 'portable', authenticatedDigest: request.fileDigest, auditArchive: archive },
        identityMap,
      );
    } catch (error) {
      await discard(created, { companyId, sessionUserId });
      return refused(400, 'RECOVERY_RESTORE_REFUSED', failureMessage(error));
    }
    if (result.status !== 'committed') {
      // Uncertain outcome: keep every row, never retry, require reconciliation.
      return {
        status: 'reconciliation_required',
        operationId: result.operationId,
        code: 'RECOVERY_RECONCILIATION_REQUIRED',
        message: result.error ?? 'The database outcome could not be confirmed.',
      };
    }

    // 4. Post-commit proof. The replacement already happened, so a missing proof
    //    re-closes maintenance and reports reconciliation instead of success.
    const proofFailure = async (code: string, message: string): Promise<PortableRestoreResult> => {
      try {
        await options.closeMaintenance?.();
      } catch {
        // Already fenced or unreachable: still fail closed on the response.
      }
      return { status: 'reconciliation_required', operationId: result.operationId, code, message };
    };

    // Evidence must describe the rows as they are stored, i.e. with the proven
    // identity map already applied (never a re-signed hash, only the reference).
    const sourceAuditRows = (snapshot.data.auditLogs ?? []) as AuditRow[];
    const storedAuditRows = sourceAuditRows.map((row) => {
      const source = row as AuditRow;
      if (typeof source.userId !== 'string') return source;
      const destination = identityMap[source.userId];
      return destination && destination !== source.userId ? { ...source, userId: destination } : source;
    });
    // ONE expectation set: the overlap planner below and the payload-absent
    // classification must both read it, so the post-commit proof can never disagree
    // with the admission decision (T36).
    const expectations = auditOverlapExpectations(sourceAuditRows, identityMap);
    // Same-installation recovery: an id already retained here is reused only as
    // the SAME authenticated event. The prepare transaction captured EVERY retained
    // row — the exact set admission certified — because the post-commit proof must
    // never see less than admission did (T36). A mismatch here means the admission
    // proof no longer holds, so nothing is certified. The documented drifts are
    // understood: a retained row whose user or company reference the dropped
    // ON DELETE SET NULL foreign key erased, proven by re-computing its ORIGINAL seal
    // over the bounded candidate reference sets (T30) — including the authenticated
    // payload company this snapshot carries, exactly as admission proved it, so the
    // post-commit proof can never disagree with admission.
    const overlap = planAuditOverlapWithAttribution(
      expectations,
      retainedRows,
      { payloadCompanyId: companyId },
    );
    if (overlap.conflicts.length > 0) {
      return proofFailure('RECOVERY_HISTORY_CONFLICT',
        'A retained audit row with the same identifier is not the authenticated event');
    }
    // T36: the SAME expectation set admission used classifies the payload-absent
    // rows of the SAME read-set, so every retained row is archived — the
    // payload-derived ones as today and the rest with the explicit `outsidePayload`
    // marker (T42: a company-scoped door's own rows included).
    const retainedAuditRows = retainedOutsidePayload(expectations, retainedRows);
    const provenance = buildRecoveryProvenance({
      snapshot,
      ownerUserId: request.ownerUserId,
      ownerEmail,
      fileDigest: request.fileDigest,
      payloadDigest: request.payloadDigest,
      identityMap,
      restoredAt: now().toISOString(),
      auditRows: storedAuditRows,
      journalRows: (snapshot.data.journalEntries ?? []) as JournalRow[],
      reusedAuditEvidence: overlap.reuse,
      auditProjections: overlap.projections,
      retainedAuditRows,
    });
    try {
      const storedAudit = await client.auditLog.findMany({});
      assertDestinationAuditPreserved(
        preservedRows.map((row) => auditEvidenceOf([row])[0]), storedAudit);
      const restoredAudit = await client.auditLog.findMany({ where: { companyId } });
      // Validate the evidence against the WHOLE installation, not the restored
      // company: a reused retained row may have its companyId erased by the legacy
      // FK, so a company-scoped read would report archived history as "missing"
      // although the row is present and byte-identical.
      assertStoredEvidence(storedAudit, provenance.auditEvidence);
      assertDestinationAuditRetained([result.operationId], restoredAudit);
      // Lines are part of the archived digest: read them in the same query.
      const restoredJournal = await client.journalEntry.findMany({
        where: { companyId }, include: { lines: true },
      });
      assertStoredEvidence(restoredJournal, provenance.journalEvidence, 'journal');
    } catch (error) {
      return proofFailure(
        error instanceof RecoveryProvenanceError ? error.code : 'RECOVERY_HISTORY_LOST',
        error instanceof Error ? error.message : 'Source history could not be certified',
      );
    }
    try {
      await options.provenance.record(provenance);
    } catch (error) {
      return proofFailure('RECOVERY_PROVENANCE_MISSING',
        error instanceof Error ? error.message : 'Recovery provenance could not be recorded');
    }

    return {
      status: 'committed',
      operationId: result.operationId,
      sessionUserId,
      counts: result.counts ?? (snapshot.manifest.recordCounts as unknown as Record<string, number | boolean>),
    };
  };
}

/** Every archived row must still exist and equal its authenticated digest. */
export function assertStoredEvidence(
  rows: readonly (AuditRow | JournalRow)[],
  evidence: readonly RecoveryRowEvidence[],
  kind: 'audit' | 'journal' = 'audit',
): void {
  if (evidence.length === 0) return;
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const entry of evidence) {
    const row = byId.get(entry.id);
    if (!row) {
      throw new RecoveryProvenanceError('RECOVERY_HISTORY_LOST', `${kind} row ${entry.id} is missing`);
    }
    const actual = kind === 'audit'
      ? auditEvidenceOf([row as AuditRow])[0].digest
      : journalEvidenceOf([row as JournalRow])[0].digest;
    if (actual !== entry.digest) {
      throw new RecoveryProvenanceError('RECOVERY_HISTORY_LOST', `${kind} row ${entry.id} was rewritten`);
    }
  }
}

/** The installation's own commit receipt must remain after the replacement. */
export function assertDestinationAuditRetained(
  requiredIds: readonly string[],
  present: readonly AuditRow[],
): void {
  const ids = new Set(present.map((row) => String(row.id)));
  for (const id of requiredIds) {
    if (!ids.has(id)) {
      throw new RecoveryProvenanceError('RECOVERY_RECEIPT_LOST', `local audit receipt ${id} is missing`);
    }
  }
}

/**
 * Retained destination audit history must survive a recovery BYTE-IDENTICAL.
 *
 * The evidence is captured in the preparation transaction (which also proves the
 * installation had no companies) and re-checked after the replacement, so a
 * deletion or a rewrite of any pre-existing audit row is reported instead of
 * being silently accepted. Nothing here re-signs or re-orders those rows.
 */
export function assertDestinationAuditPreserved(
  evidence: readonly RecoveryRowEvidence[],
  present: readonly AuditRow[],
): void {
  if (evidence.length === 0) return;
  const byId = new Map(present.map((row) => [String(row.id), row]));
  for (const entry of evidence) {
    const row = byId.get(entry.id);
    if (!row) {
      throw new RecoveryProvenanceError(
        'RECOVERY_DESTINATION_AUDIT_LOST', `retained audit row ${entry.id} is missing after the recovery`);
    }
    if (auditEvidenceOf([row])[0].digest !== entry.digest) {
      throw new RecoveryProvenanceError(
        'RECOVERY_DESTINATION_AUDIT_LOST', `retained audit row ${entry.id} was rewritten by the recovery`);
    }
  }
}

/** Kept for callers that only need the portable size/identity guards. */
export const RECOVERY_PROVENANCE_LIMITS = PORTABLE_LIMITS;
export { PortableRecoveryError };
