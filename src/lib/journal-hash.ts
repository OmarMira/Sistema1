import { createHash, createHmac } from 'crypto';

/**
 * Cryptographic audit chain service.
 * Each posted JournalEntry and AuditLog is chained via HMAC-SHA-256.
 * Any tampering with the database breaks the chain and is detectable.
 */

/**
 * JH2.12: HMAC_SECRET is resolved LAZILY at the moment a cryptographic
 * operation actually needs it. Importing this module (including under
 * `next build` page-data collection with NODE_ENV=production) must NOT
 * throw. A production runtime call without HMAC_SECRET still fails fast.
 * No insecure fallback in production; no hardcoded secrets.
 */
export function getJournalHmacSecret(): string {
  const secret = process.env.HMAC_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('HMAC_SECRET environment variable is required in production');
    }
    return 'dev-secret-not-for-production';
  }
  return secret;
}

/**
 * Compute HMAC-SHA-256 hash for a journal entry, chaining with the previous entry's hash.
 */
export function computeEntryHash(payload: {
  id: string;
  companyId: string;
  date: string;
  description: string;
  reference: string | null;
  status: string;
  totalDebit: number;
  totalCredit: number;
  previousHash: string | null;
}): string {
  const data = [
    payload.id,
    payload.companyId,
    payload.date,
    payload.description,
    payload.reference ?? '',
    payload.status,
    payload.totalDebit.toFixed(2),
    payload.totalCredit.toFixed(2),
    payload.previousHash ?? '',
  ].join('|');

  return createHmac('sha256', getJournalHmacSecret()).update(data).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Recovery evidence (portable bootstrap restore)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A portable recovery brings journal/audit history sealed with the SOURCE
 * installation's HMAC key. This machine does not hold that key, so those values
 * can never be recomputed locally — and they are never re-signed either.
 *
 * Instead the restore archives, from the AEAD-authenticated payload, a digest of
 * the exact canonical content of every historical row (including its stored hash
 * and previousHash). Verification then requires the stored row to still equal
 * that authenticated evidence digest; topology is verified from the stored links
 * as usual, and rows written locally AFTER the recovery are verified with the
 * local HMAC as before. A tampered archived row therefore fails verification
 * instead of being silently exempted.
 */
/**
 * One archived row: the digest of the row EXACTLY AS STORED, plus — only when a
 * retained row's user reference was erased by the legacy `ON DELETE SET NULL`
 * foreign key — the source attribution that the stored seal was computed with.
 *
 * The projection is never a relabel: it is accepted only while the stored HMAC
 * still verifies over the stored content with that reference, so an arbitrary
 * null is never certified.
 *
 * T34: an UNSEALED row (no hash on either side) has no HMAC to verify, so its
 * evidence is the stored digest alone — the destination preservation proof and this
 * archived digest are what freeze those bytes, and a proof that REQUIRES a seal still
 * refuses the row. Its projection records the erased reference the canonical
 * comparison proved; the archive is explicit about the absence, never a claim that
 * the null content was signed.
 */
export interface RecoveryArchiveEvidence {
  readonly digest: string;
  /** Original source company reference, when the legacy FK erased the stored one. */
  readonly projectedCompanyId?: string;
  readonly projectedUserId?: string;
  /**
   * T34: this row carried NO seal when it was archived (an unsealed legacy audit
   * row). The marker is EXPLICIT so the absence can never be inferred from the
   * stored row: a row archived WITH a seal whose hash later disappeared is still
   * reported, and the archived bytes are still compared, so drift keeps failing.
   */
  readonly sealLess?: true;
  /**
   * T36: this retained row belongs to NO event of the authenticated payload (a
   * company-scoped export never carries another tenant's or an unowned row). It is
   * RETAINED IN PLACE: the restore never deletes it (the audit table is never
   * pruned) and never rewrites it (a reused id is skipped), so there is no source
   * event to re-prove and none ever existed for it. Its certification is the
   * digest of its STORED bytes below — the archive freezes what this installation
   * holds and still detects any later drift.
   */
  readonly outsidePayload?: true;
}

/** Plain digest strings stay accepted for callers/tests that only hold digests. */
export type RecoveryArchiveValue = string | RecoveryArchiveEvidence;
export type RecoveryArchive = ReadonlyMap<string, RecoveryArchiveValue>;

/**
 * REFERENCES the authenticated source event was sealed with that the retained
 * row no longer carries, because a legacy `ON DELETE SET NULL` foreign key erased
 * them. Only these two fields may ever be reconstructed; every other canonical
 * field, the stored seal and the stored link must still match exactly.
 *
 * T34: when NEITHER copy carries a seal the same two fields may be recorded from
 * the canonical comparison alone (there is no signature to re-prove); see
 * `sealLessErasedReferences`.
 */
export interface AuditAttributionProjection {
  readonly companyId?: string;
  readonly userId?: string;
}

/** The stored/authenticated digest of an archive entry, whatever form it has. */
export function archiveDigestOf(value: RecoveryArchiveValue): string {
  return typeof value === 'string' ? value : value.digest;
}

/**
 * T34: does this archive entry declare that its row had NO seal? A plain digest
 * string never does, and an entry that does not declare it is treated as SEALED
 * (so a disappeared hash is still a reported defect, never an excuse).
 */
export function archiveSealLessOf(value: RecoveryArchiveValue): boolean {
  return typeof value !== 'string' && value.sealLess === true;
}

/**
 * T36: does this archive entry declare that its row is NOT part of the payload?
 * Such a row is frozen, not overlap-attested: there is no authenticated source
 * event to re-prove it against, so the stored-bytes digest is its certification.
 * A plain digest string never makes that claim.
 */
export function archiveOutsidePayloadOf(value: RecoveryArchiveValue): boolean {
  return typeof value !== 'string' && value.outsidePayload === true;
}

/** The explicit original attribution of a retained row, when one is archived. */
export function archiveAttributionOf(
  value: RecoveryArchiveValue,
): AuditAttributionProjection | undefined {
  if (typeof value === 'string') return undefined;
  const projection: { companyId?: string; userId?: string } = {};
  if (value.projectedCompanyId !== undefined) projection.companyId = value.projectedCompanyId;
  if (value.projectedUserId !== undefined) projection.userId = value.projectedUserId;
  return projection.companyId === undefined && projection.userId === undefined
    ? undefined
    : projection;
}

/** Injective field encoding shared by both evidence digests. */
function evidenceFrame(fields: readonly string[]): string {
  return createHash('sha256').update(fields.map(lenPrefixed).join('|')).digest('hex');
}

function evidenceTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Canonical digest of an audit row as stored (content + stored chain links). */
export function auditHistoryDigest(row: {
  id: string;
  companyId: string | null;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  details: string | null;
  hash: string | null;
  previousHash: string | null;
  createdAt: Date | string;
}): string {
  return evidenceFrame([
    row.id,
    row.companyId ?? '',
    row.userId ?? '',
    row.action,
    row.entity,
    row.entityId ?? '',
    row.details ?? '',
    row.hash ?? '',
    row.previousHash ?? '',
    evidenceTime(row.createdAt),
  ]);
}

/**
 * Loose audit-row shape: a PostgreSQL read (Date timestamps, nullable columns) or
 * the same row after it travelled through the authenticated snapshot (ISO
 * strings). Both MUST digest identically, so normalization lives in exactly one
 * place for the archive, the restore validator and the post-commit proof.
 */
export interface AuditHistoryRowLike {
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

/** Canonical audit content of a loosely typed row. No field is skipped. */
export function auditHistoryRow(row: AuditHistoryRowLike): Parameters<typeof auditHistoryDigest>[0] {
  return {
    id: String(row.id),
    companyId: row.companyId == null ? null : String(row.companyId),
    userId: row.userId == null ? null : String(row.userId),
    action: String(row.action ?? ''),
    entity: String(row.entity ?? ''),
    entityId: row.entityId == null ? null : String(row.entityId),
    details: row.details == null ? null : String(row.details),
    hash: row.hash == null ? null : String(row.hash),
    previousHash: row.previousHash == null ? null : String(row.previousHash),
    // `String(date)` drops milliseconds, which once made a stored row's digest
    // differ from the authenticated one by the truncated instant. Keep Dates.
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt)),
  };
}

/** Digest of a loosely typed audit row, normalized exactly once. */
export function auditHistoryDigestOf(row: AuditHistoryRowLike): string {
  return auditHistoryDigest(auditHistoryRow(row));
}

/**
 * A retained row whose references are ABSENT can still be certified as the
 * authenticated event when the stored seal verifies over its stored content with
 * the SOURCE references. This proves the original signature covered that payload
 * with those references — not that the database action was observed, and not that
 * the absent values themselves were ever signed.
 *
 * Both references must be supplied TOGETHER when both were erased: reconstructing
 * only one of them cannot reproduce the original payload, so a sequential /
 * partial acceptance is impossible by construction.
 */
export function retainedAttributionHolds(
  row: AuditHistoryRowLike,
  claim: string | AuditAttributionProjection,
): boolean {
  const projection: AuditAttributionProjection = typeof claim === 'string' ? { userId: claim } : claim;
  if (projection.companyId === undefined && projection.userId === undefined) return false;
  const canonical = auditHistoryRow(row);
  if (canonical.hash == null) return false;
  // Only a reference the database erased qualifies; a live reference is not a
  // projection and must match the authenticated event directly.
  if (projection.companyId !== undefined && canonical.companyId !== null) return false;
  if (projection.userId !== undefined && canonical.userId !== null) return false;
  return computeAuditHash({
    ...canonical,
    companyId: projection.companyId ?? canonical.companyId,
    userId: projection.userId ?? canonical.userId,
  }) === canonical.hash;
}

/**
 * S19/S21/T30 — the REFERENCE SET a stored seal was proven with.
 *
 * An audit seal covers `id | companyId | userId | action | entity | entityId |
 * details | previousHash`; both references are excluded from that contract on
 * purpose, because the database mutates them (`AuditLog.userId` and `.companyId`
 * were `ON DELETE SET NULL` foreign keys) and a previous recovery may have stored a
 * historical LOCAL account id. Recording WHICH reference set reproduced the seal is
 * what lets every consumer RE-PROVE the certificate instead of trusting a stored
 * opinion. It is never applied to any row: nothing is projected, relabelled or
 * re-signed.
 */
export interface AuditSealReference {
  readonly userId: string | null;
  readonly companyId: string | null;
}

/**
 * The BOUNDED reference space a stored seal may cover (S19/S21/T30).
 *
 * Neither side can always read the original references: a user reference erased by
 * the dropped `ON DELETE SET NULL`, a local account the installation churned, or a
 * company reference erased by the legacy FK BEFORE the backup was created (so the
 * AUTHENTICATED source event itself carries `companyId: null` although its seal
 * names the company the row belonged to). The candidates are therefore
 * {source actor, retained actor} x {source event company, authenticated payload
 * company} — AT MOST FOUR reference sets, each a PURE recomputation, with the
 * no-op (equal to the source event exactly as carried) collapsing. Nothing outside
 * this space is ever tried, so a foreign company or a rotated key matches nothing.
 */
export function auditSealCandidates(
  retainedRow: AuditHistoryRowLike,
  sourceRow: AuditHistoryRowLike,
  payloadCompanyId?: string | null,
): AuditSealReference[] {
  const retained = auditHistoryRow(retainedRow);
  const source = auditHistoryRow(sourceRow);
  const companies: Array<string | null> = [source.companyId];
  if (payloadCompanyId !== undefined) companies.push(payloadCompanyId);
  const candidates: AuditSealReference[] = [];
  const seen = new Set<string>();
  for (const userId of [source.userId, retained.userId]) {
    for (const companyId of companies) {
      const key = `${userId ?? ''}\u0000${companyId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ userId, companyId });
    }
  }
  return candidates;
}

/**
 * Does this installation's key reproduce the SOURCE event's stored seal with one of
 * the bounded candidate reference sets? Returns the matching set, or `null` when no
 * candidate does — which keeps the refusal (a rotated/foreign key, or a reference
 * set nobody can describe).
 */
export function auditSealReference(
  retainedRow: AuditHistoryRowLike,
  sourceRow: AuditHistoryRowLike,
  payloadCompanyId?: string | null,
): AuditSealReference | null {
  const source = auditHistoryRow(sourceRow);
  if (source.hash == null) return null;
  for (const candidate of auditSealCandidates(retainedRow, sourceRow, payloadCompanyId)) {
    if (computeAuditHash({
      id: source.id,
      companyId: candidate.companyId,
      userId: candidate.userId,
      action: source.action,
      entity: source.entity,
      entityId: source.entityId,
      details: source.details,
      previousHash: source.previousHash,
    }) === source.hash) return candidate;
  }
  return null;
}

/**
 * The REFERENCE preconditions of the certified-actor proof: both actors are known
 * and differ, and the stored seal/link content already matches the authenticated
 * event. The seal itself is verified separately (and only once) by
 * `auditSealReference`.
 */
/**
 * The ONE tolerated live actor difference, in BOTH directions (S21/T28-T31).
 *
 * The seal never covered either reference column, so a difference in `userId`
 * alone says nothing about which event the content describes — provided the
 * stored seal/link content already matches and no live foreign company is kept.
 * The two accepted directions are:
 *  - both actors known and different: a previous recovery's local mapping target
 *    or local account churn (T28);
 *  - the SOURCE actor erased (`null`) while the retained row keeps a LIVE local
 *    actor (T31): the legacy `ON DELETE SET NULL` foreign key ran BEFORE the backup
 *    was exported, so the authenticated event lost the reference while this
 *    installation still holds the event under its own local account id, and the
 *    stored seal covers the NULL-ACTOR payload.
 * Neither direction is applied to a row: acceptance only reuses what is stored.
 */
function actorReferencesDiffer(
  retained: Parameters<typeof auditHistoryDigest>[0],
  source: Parameters<typeof auditHistoryDigest>[0],
): boolean {
  if (source.userId !== null && retained.userId === null) return false;
  if (retained.hash == null || retained.hash !== source.hash) return false;
  if (retained.companyId !== null && retained.companyId !== source.companyId) return false;
  return retained.userId !== source.userId;
}

/**
 * S21/T28/T30 — the retained row's actor is a HISTORICAL LOCAL account id.
 *
 * A previous recovery on this installation may have mapped the event onto the
 * local account that existed then (`identityMap` applies to `AuditLog.userId`),
 * and local accounts are churned: that id is now neither the authenticated source
 * actor nor today's identity-map target. Its stored seal was never computed over
 * it — the seal is the ORIGINAL one, kept verbatim. The same is true of a company
 * reference a legacy `ON DELETE SET NULL` foreign key erased: both columns are
 * mutable local data the seal never covered.
 *
 * The proof is therefore taken over the ORIGINAL AUTHENTICATED EVENT with the
 * BOUNDED candidate reference sets (`auditSealReference`), never by trusting the
 * retained row's own references. A row sealed for a rotated/foreign key, or one
 * that keeps a live FOREIGN company, fails here and stays a refusal.
 */
export function retainedActorSealHolds(
  row: AuditHistoryRowLike,
  original: AuditHistoryRowLike,
  payloadCompanyId?: string | null,
): boolean {
  const canonical = auditHistoryRow(row);
  const source = auditHistoryRow(original);
  if (canonical.hash == null || source.hash == null || source.userId === null) return false;
  // A null stored actor is the erased-reference case (`retainedAttributionHolds`)
  // and an equal one is the plain exact match: neither is this proof.
  if (canonical.userId === null || canonical.userId === source.userId) return false;
  // The company reference the legacy FK erased is the only other tolerated
  // difference; a live foreign company describes a different event.
  if (canonical.companyId !== null && canonical.companyId !== source.companyId) return false;
  return actorReferencesDiffer(canonical, source) &&
    auditSealReference(row, original, payloadCompanyId) !== null;
}

/**
 * One incoming source event, described by the digest this restore would STORE
 * for it (the proven identity map is already applied by the caller).
 */
export interface AuditOverlapExpectation {
  id: string;
  /**
   * Digest of the row exactly as it would be written, so no field escapes. This is
   * the EXPECTATION for a row that is genuinely absent here; it is not a
   * description of this installation's retained history.
   */
  storedDigest: string;
  /**
   * The AUTHENTICATED source event itself (original, unremapped references).
   * Carried whenever the caller can describe it, because a proven identity map
   * only says how an ABSENT row would be stored: the history this installation
   * already holds is compared against this original event as well. A source that
   * carries a seal is proved before anything can be projected from it, so a
   * rotated key, a foreign key or a forged value still authorizes nothing.
   */
  attribution?: { source: AuditHistoryRowLike };
}

/** Fixed canonical field vocabulary for safe, value-free conflict reporting. */
const AUDIT_EVIDENCE_FIELDS = [
  'companyId', 'userId', 'action', 'entity', 'entityId', 'details', 'hash', 'previousHash', 'createdAt',
] as const;
export type AuditEvidenceField = (typeof AUDIT_EVIDENCE_FIELDS)[number];

/**
 * Why an id that both sides share was NOT accepted. Carries NO values: only a
 * fixed reason and fixed canonical field names, so it can be logged or returned to
 * an unauthenticated caller without exposing ids, references, content, hashes,
 * tokens or backup bytes.
 */
export interface AuditOverlapMismatch {
  /** Internal only: never serialized by `auditOverlapDiagnostic`. */
  id: string;
  /**
   * `source-seal`: the authenticated source event's own seal cannot be verified
   * here (rotated/foreign key, or a reference set outside the bounded candidates),
   * so nothing can be projected through it.
   * `content`: canonical fields other than an erased reference differ.
   * `original-seal`: content matches, but the stored seal does not verify with the
   * proven references.
   */
  reason: 'content' | 'original-seal' | 'source-seal';
  fields: AuditEvidenceField[];
  /**
   * T30 — the BOUNDED candidate reference sets were all recomputed and none
   * reproduced the stored seal. Reported as one fixed token so an operator log
   * pinpoints the failing stage; never a value, id, hash, count of fields or
   * secret.
   */
  sealCandidatesUnverified?: boolean;
}

export interface AuditOverlapPlan {
  /** Retained id -> digest of the STORED retained row (its preserved evidence). */
  reuse: Map<string, string>;
  /** Same id but different canonical content: a collision, never a variant. */
  conflicts: string[];
  /** Value-free description of each refused id (see `auditOverlapDiagnostic`). */
  mismatches: AuditOverlapMismatch[];
}

export interface AuditAttributedOverlapPlan extends AuditOverlapPlan {
  /**
   * Retained id -> the source references its stored seal was proven with — or, for a
   * row with NO seal on either side (T34), the erased references the canonical
   * comparison of the two hash-less copies proved. Either way it is only RECORDED:
   * no row is projected, relabelled or re-signed.
   */
  projections: Map<string, AuditAttributionProjection>;
  /**
   * Retained id -> the reference set its stored seal was proven with, for rows
   * reused verbatim although their stored references are different, certified
   * local-history values (see `retainedActorSealHolds`). These rows are never
   * rewritten and never relabelled: the map exists so every consumer can RE-PROVE
   * the certificate with the SAME references instead of trusting a stored opinion.
   */
  certifiedActors: Map<string, AuditSealReference>;
}

/**
 * Restore-level context the bounded seal proof needs (S19/S21/T30).
 */
export interface AuditOverlapOptions {
  /**
   * Company id of the AUTHENTICATED portable payload (the company this restore
   * carries). It is the only remaining description of a company reference a legacy
   * `ON DELETE SET NULL` erased BEFORE the backup was created, so it joins the
   * candidate reference sets as `{ ..., companyId: payloadCompanyId }`.
   */
  readonly payloadCompanyId?: string | null;
}

/**
 * Safe, deterministic conflict summary: fixed reasons and field names only.
 * An empty string means the refusal did NOT come from this planner (a pre-planner
 * gate), which is the only way a caller can tell the two apart.
 */
export function auditOverlapDiagnostic(
  plan: { conflicts: readonly string[]; mismatches: readonly AuditOverlapMismatch[] },
): string {
  if (plan.conflicts.length === 0) return '';
  const reasons = [...new Set(plan.mismatches.map((entry) => entry.reason))].sort();
  const fields = [...new Set(plan.mismatches.flatMap((entry) => entry.fields))].sort();
  const reason = reasons.length > 0 ? reasons.join('+') : 'content';
  // T30: ONE fixed token, no values and no counts of anything derived from the data.
  const seal = plan.mismatches.some((entry) => entry.sealCandidatesUnverified === true)
    ? '; seal-candidates-unverified'
    : '';
  return ` [mismatch: ${reason}; fields: ${fields.length > 0 ? fields.join(',') : 'none'}${seal}]`;
}

/** Canonical field differences between a retained row and the expected event. */
function differingFields(
  retained: Parameters<typeof auditHistoryDigest>[0],
  expected: Parameters<typeof auditHistoryDigest>[0],
): AuditEvidenceField[] {
  const fields: AuditEvidenceField[] = [];
  if (retained.companyId !== expected.companyId) fields.push('companyId');
  if (retained.userId !== expected.userId) fields.push('userId');
  if (retained.action !== expected.action) fields.push('action');
  if (retained.entity !== expected.entity) fields.push('entity');
  if (retained.entityId !== expected.entityId) fields.push('entityId');
  if (retained.details !== expected.details) fields.push('details');
  if (retained.hash !== expected.hash) fields.push('hash');
  if (retained.previousHash !== expected.previousHash) fields.push('previousHash');
  if (evidenceTime(retained.createdAt) !== evidenceTime(expected.createdAt)) fields.push('createdAt');
  return fields;
}

/**
 * S2/S18/S21/T34 — BOTH copies of one event are HASH-LESS.
 *
 * Unsealed legacy audit rows travel verbatim through a portable export and are kept
 * verbatim on the destination, so a same-installation recovery can meet its own copy
 * of such an event with NO seal on either side: the retained row's actor reference
 * was erased by the dropped `ON DELETE SET NULL` foreign key while the authenticated
 * source event still carries the live one, and every other canonical field —
 * content, stored link, timestamp — is identical.
 *
 * With no seal there is nothing to recompute, so the canonical comparison is the
 * whole proof. The reference set the source still carries is RETURNED as a
 * projection so the caller can record it, but nothing is ever written into retained
 * history: the retained row stays byte-identical, and the source's live reference is
 * never signed, relabelled or copied. Certification of those stored bytes is carried
 * downstream by the destination preservation proof and the provenance archive digest
 * (`assertDestinationAuditPreserved`, the archive's own digest), which fail closed if
 * the row drifts; and the ABSENCE of a seal stays explicit, because every proof that
 * requires an HMAC (`retainedAttributionHolds`, `auditSealReference`) still refuses a
 * seal-less row.
 *
 * This is deliberately narrower than the sealed paths: a seal on ONE side only is a
 * real content difference (hash presence differs), the REVERSED direction (retained
 * live, source erased) is not the documented drift, and any other canonical field
 * difference keeps its refusal.
 */
function sealLessErasedReferences(
  retained: Parameters<typeof auditHistoryDigest>[0],
  source: Parameters<typeof auditHistoryDigest>[0],
): AuditAttributionProjection | null {
  // A seal on either side is not this shape: the stored hash is canonical content.
  if (retained.hash !== null || source.hash !== null) return null;
  const projection: { companyId?: string; userId?: string } = {};
  if (retained.companyId === null && source.companyId !== null) projection.companyId = source.companyId;
  if (retained.userId === null && source.userId !== null) projection.userId = source.userId;
  // No erased reference on the retained row at all: nothing was drifted.
  if (projection.companyId === undefined && projection.userId === undefined) return null;
  const differences = differingFields(retained, source);
  if (differences.length === 0) return null;
  const onlyErasedReferences = differences.every((field) =>
    (field === 'userId' && projection.userId !== undefined) ||
    (field === 'companyId' && projection.companyId !== undefined));
  return onlyErasedReferences ? projection : null;
}

/**
 * Prove that a retained row IS the authenticated source event under the ONE
 * documented drift: a company and/or user reference erased by the dropped
 * `ON DELETE SET NULL` foreign keys while the row kept its original seal.
 *
 * The source event's own seal must verify under this installation's key — with one
 * of the BOUNDED candidate reference sets (`auditSealReference`), because the
 * reference a seal covers is not always readable on either row — and every
 * canonical field must match the authenticated event, with erased references
 * reconstructed from it and NOTHING else. Otherwise a value-free mismatch is
 * returned. Nothing is rewritten.
 *
 * ONE branch carries no seal at all: a HASH-LESS source event meeting a HASH-LESS
 * retained row that differs ONLY in an erased reference (T34). There is no HMAC to
 * re-prove there, so the canonical comparison decides and the callers record the
 * reference instead of writing it.
 */
export function attestRetainedAttribution(
  retainedRow: AuditHistoryRowLike,
  sourceRow: AuditHistoryRowLike,
  options?: AuditOverlapOptions,
):
  | { projection: AuditAttributionProjection }
  /** The stored seal was proven with this reference set (never applied to a row). */
  | { certifiedActor: AuditSealReference }
  | { mismatch: AuditOverlapMismatch } {
  const retained = auditHistoryRow(retainedRow);
  const source = auditHistoryRow(sourceRow);
  const id = retained.id;
  if (source.hash == null) {
    // T34 (L72): BOTH copies of the event are hash-less and the only canonical
    // difference is a reference the legacy foreign key erased on THIS side. There is
    // no seal to recompute on either side, so the canonical comparison decides; the
    // returned projection is RECORDED by the caller (`projections`), never written,
    // which keeps the retained row byte-identical (see `sealLessErasedReferences`).
    const sealLess = sealLessErasedReferences(retained, source);
    if (sealLess !== null) return { projection: sealLess };
    // No seal travels with this source event, so nothing can be projected through
    // it. Report the fields that ACTUALLY differ (the seal is the last candidate):
    // an empty field list would read like "your data is corrupt" for a comparison
    // that never happened.
    const differences = differingFields(retained, source);
    return { mismatch: { id, reason: 'content', fields: differences.length > 0 ? differences : ['hash'] } };
  }
  // S19/S21/T30 — BOUNDED seal proof. The reference the original seal covers may no
  // longer be readable: a user reference erased by the dropped `ON DELETE SET NULL`
  // or a local account this installation churned, and a company reference erased by
  // the legacy FK BEFORE the backup was created (so the AUTHENTICATED source event
  // itself carries `null` while its seal names the company). At most four PURE
  // recomputations under this key decide whether the seal is reproducible here; a
  // reference outside that space (rotated/foreign key, foreign company) matches
  // nothing. No row is read back or written.
  const seal = auditSealReference(retainedRow, sourceRow, options?.payloadCompanyId);
  if (seal === null) {
    return { mismatch: { id, reason: 'source-seal', fields: [], sealCandidatesUnverified: true } };
  }
  // What the row must look like: the authenticated event, with each reference
  // replaced by the STORED value when (and only when) the stored one was erased.
  const expected = {
    ...source,
    companyId: retained.companyId === null ? null : source.companyId,
    userId: retained.userId === null ? null : source.userId,
  };
  const fields = differingFields(retained, expected);
  if (fields.length > 0) {
    // S21/T28-T31: the ONE tolerated live difference. The retained row's actor is a
    // historical LOCAL account id (a previous recovery's mapping target, or local
    // account churn) — or, in the T31 mirror, this installation's own live local
    // actor while the AUTHENTICATED event carries NO actor at all, because the
    // legacy `ON DELETE SET NULL` foreign key erased the reference BEFORE the backup
    // was exported (so the stored seal covers the null-actor payload). Either way
    // every other canonical field INCLUDING the stored seal, the stored link and the
    // timestamp equals the authenticated source event.
    //
    // Rationale: the retained row is certified local history and its seal is the
    // ORIGINAL one, kept verbatim. The seal proof above already ran over the BOUNDED
    // reference space, which INCLUDES the retained row's own actor and the source
    // event's `null`, so the certificate needs no second recomputation. The same
    // applies to a company reference the legacy FK erased, whose expected digest is
    // already the shifted one: what the seal covers is the original payload, so the
    // event's content is proven identical and skipping the duplicate insert rewrites
    // nothing — no insert, no projection, no re-sign, and the source's null reference
    // is never written into retained history.
    // Everything else (any other field, a null retained actor) keeps its previous
    // fail-closed refusal.
    if (fields.length === 1 && fields[0] === 'userId' && actorReferencesDiffer(retained, source)) {
      return { certifiedActor: seal };
    }
    return { mismatch: { id, reason: 'content', fields } };
  }
  const projection: { companyId?: string; userId?: string } = {};
  if (retained.companyId === null && source.companyId !== null) projection.companyId = source.companyId;
  if (retained.userId === null && source.userId !== null) projection.userId = source.userId;
  if (projection.companyId === undefined && projection.userId === undefined) {
    // Nothing was erased here, so this is not an attribution case at all.
    return { mismatch: { id, reason: 'content', fields: [] } };
  }
  if (!retainedAttributionHolds(retainedRow, projection)) {
    return { mismatch: { id, reason: 'original-seal', fields: [] } };
  }
  return { projection };
}

/**
 * Compare the incoming source events with the audit rows this installation
 * already retains, by id.
 *
 * A same-installation recovery can legitimately meet its own history (a company
 * was deleted while its audit rows outlive it), so an id may already be present.
 * Reuse is allowed ONLY when the retained row equals the authenticated source row
 * in every canonical field - content, stored hash, stored link and timestamp -
 * because `storedDigest` is computed from the snapshot row with the explicit,
 * authorized identity mapping applied. Anything else stays a conflict: rows are
 * never treated as interchangeable, never rewritten and never de-duplicated.
 */
export function planAuditOverlap(
  source: readonly AuditOverlapExpectation[],
  retained: ReadonlyMap<string, string>,
): AuditOverlapPlan {
  const reuse = new Map<string, string>();
  const conflicts: string[] = [];
  for (const row of source) {
    const stored = retained.get(row.id);
    if (stored === undefined) continue;
    if (stored === row.storedDigest) reuse.set(row.id, stored);
    else conflicts.push(row.id);
  }
  // A digest-only caller has no row to describe: no field names exist here.
  return { reuse, conflicts, mismatches: [] };
}

/** Expectations for a set of source audit rows under the authorized mapping. */
export function auditOverlapExpectations(
  rows: readonly AuditHistoryRowLike[],
  identityMap: Readonly<Record<string, string>> = {},
): AuditOverlapExpectation[] {
  return rows.map((row) => {
    const canonical = auditHistoryRow(row);
    const mapped = typeof canonical.userId === 'string' ? identityMap[canonical.userId] : undefined;
    return {
      id: canonical.id,
      storedDigest: auditHistoryDigest(
        mapped && mapped !== canonical.userId ? { ...canonical, userId: mapped } : canonical,
      ),
      // The ORIGINAL row always travels with the expectation: the planner compares
      // it with the retained history (and proves its seal before any projection).
      attribution: { source: canonical },
    };
  });
}

/**
 * T36 — the payload-ABSENT half of a preserved audit history.
 *
 * Derived from the SAME expectation set the overlap planner is given, so the
 * admission decision, the recovery transaction's safety snapshot and the
 * post-commit proof can never disagree about which rows the backup carries: a
 * retained row is payload-absent exactly when the authenticated payload has no
 * event for its id. Those rows are frozen in place by the restore (never deleted,
 * never re-inserted, never rewritten), so they are not certified by repeating an
 * overlap proof that cannot exist for them; the recovery archive freezes their
 * stored bytes instead.
 */
export function retainedOutsidePayload<T extends AuditHistoryRowLike>(
  source: readonly AuditOverlapExpectation[],
  retained: readonly T[],
): T[] {
  const known = new Set(source.map((expectation) => expectation.id));
  return retained.filter((row) => !known.has(String(row.id)));
}

/**
 * Same-id comparison that also understands the ONE documented legacy drift: a
 * company and/or user reference erased by the dropped `ON DELETE SET NULL`
 * foreign keys while the row kept the source seal.
 *
 * Such a row is reused - and its references recorded - only through
 * `attestRetainedAttribution`; anything else is a conflict, exactly like before.
 * A live (non-null) reference is never projected, so a row attributed to a
 * different live company or account stays a refusal.
 *
 * Two EXACT comparisons are made, because a proven identity map only describes
 * how an ABSENT row would be stored: audit attribution is immutable evidence,
 * not a foreign key, so retained history is never rewritten to a local actor.
 *  1. the row this restore would store (mapped expectation), and
 *  2. the AUTHENTICATED ORIGINAL source event (unmapped references).
 * Matching the second one reuses the stored row verbatim: no projection, no
 * rewrite, no re-sign, and the caller's own certification of every preserved row
 * (local key or authenticated archive) still decides whether it may be kept.
 *
 * S21/T28 adds the ONE further accepted shape, and only through a proof:
 * `retainedActorSealHolds`. A retained row whose actor reference is a historical
 * LOCAL account id differs from the authenticated event in `userId` alone (a
 * company reference the legacy FK erased masks as equal, exactly as above); its
 * stored seal still verifies under this installation's key over the ORIGINAL
 * authenticated payload, so the event's content is proven identical and the
 * certified local actor is kept as stored. Such a row is reused byte-identically
 * (recorded in `certifiedActors`) and is never projected, relabelled or re-signed.
 * Every other difference, an unverifiable seal (rotated/foreign key), a null
 * RETAINED actor and every difference on more than that one field stay refusals.
 *
 * T31 adds the MIRROR of that shape, with the same proof and the same fail-closed
 * edges: the AUTHENTICATED event carries NO actor (the legacy `ON DELETE SET NULL`
 * ran before the backup was exported, so the seal covers the null-actor payload)
 * while the retained row keeps this installation's own LIVE local actor. The actor
 * is historical local data the seal never covered, so the retained row is again
 * reused byte-identically: the source's null reference is never written into
 * retained history.
 *
 * T30 makes the seal proof itself BOUNDED but reference-agnostic: the reference set
 * the seal covers is not always readable (an actor erased or churned locally, a
 * company reference erased BEFORE the backup was exported). `options.payloadCompanyId`
 * adds the authenticated payload company to the candidate space; a caller that omits
 * it simply proves fewer references, never more.
 */
export function planAuditOverlapWithAttribution(
  source: readonly AuditOverlapExpectation[],
  retained: readonly AuditHistoryRowLike[],
  options?: AuditOverlapOptions,
): AuditAttributedOverlapPlan {
  const byId = new Map(retained.map((row) => [String(row.id), row]));
  const reuse = new Map<string, string>();
  const conflicts: string[] = [];
  const projections = new Map<string, AuditAttributionProjection>();
  const certifiedActors = new Map<string, AuditSealReference>();
  const mismatches: AuditOverlapMismatch[] = [];
  for (const expectation of source) {
    const row = byId.get(expectation.id);
    if (!row) continue;
    const stored = auditHistoryDigestOf(row);
    if (stored === expectation.storedDigest) {
      reuse.set(expectation.id, stored);
      continue;
    }
    const original = expectation.attribution?.source;
    if (original !== undefined && stored === auditHistoryDigestOf(original)) {
      // Verbatim retained original (every canonical field, including the id, the
      // stored seal, the stored link and the timestamp). The retained row IS the
      // authenticated event; the reused evidence is the digest of what is stored.
      reuse.set(expectation.id, stored);
      continue;
    }
    const attested:
      | { projection: AuditAttributionProjection }
      | { certifiedActor: AuditSealReference }
      | { mismatch: AuditOverlapMismatch } = original === undefined
      // A caller that cannot describe the source event cannot prove anything.
      ? { mismatch: { id: expectation.id, reason: 'content', fields: ['hash'] } }
      : attestRetainedAttribution(row, original, options);
    if ('projection' in attested) {
      reuse.set(expectation.id, stored);
      projections.set(expectation.id, attested.projection);
      continue;
    }
    if ('certifiedActor' in attested) {
      // Byte-identical reuse: the stored row already IS the authenticated event,
      // only its certified local references differ from the source ones.
      reuse.set(expectation.id, stored);
      certifiedActors.set(expectation.id, attested.certifiedActor);
      continue;
    }
    conflicts.push(expectation.id);
    mismatches.push(attested.mismatch);
  }
  return { reuse, conflicts, projections, certifiedActors, mismatches };
}

/** Canonical digest of a journal entry (header + stored links + all lines). */
export function journalHistoryDigest(entry: {
  id: string;
  companyId: string;
  date: Date | string;
  description: string;
  reference: string | null;
  status: string;
  hash: string | null;
  previousHash: string | null;
  hashVersion: string | null;
  lines: JournalHashLinePayload[];
}): string {
  return journalEvidenceDigest(entry, entry.status);
}

/**
 * F3 — the journal workflow statuses (`JournalEntryStatus` in
 * `prisma/schema.prisma`) that may legitimately change AFTER a row was archived.
 *
 * `status` is local, MUTABLE workflow state: voiding a restored entry, a
 * rollback or a reclassification rewrites it on the destination, while the
 * archived evidence necessarily recorded the value the row had when it arrived.
 * Comparing the archived digest against the current status therefore reported a
 * legitimate void as `ARCHIVE_HASH_MISMATCH` and blocked both chain verification
 * and every new portable export. Extend this list only together with the schema
 * enum.
 */
const MUTABLE_JOURNAL_STATUSES: readonly string[] = ['draft', 'posted', 'void', 'pending_review'];

/**
 * The digest frame is unchanged (so every stored/archived digest computed by
 * earlier code still matches byte for byte); only the value spliced into the
 * `status` slot can vary here.
 */
function journalEvidenceDigest(
  entry: Parameters<typeof journalHistoryDigest>[0],
  status: string,
): string {
  const lines = entry.lines.map((line) => lineCanonical(line)).sort().join(';');
  return evidenceFrame([
    entry.id,
    entry.companyId,
    evidenceTime(entry.date),
    entry.description,
    entry.reference ?? '',
    status,
    entry.hash ?? '',
    entry.previousHash ?? '',
    entry.hashVersion ?? '',
    lines,
  ]);
}

/**
 * F3 — does a stored row still match its archived evidence, ignoring ONLY the
 * mutable workflow status?
 *
 * The archived digest was computed with the status the row had when it was
 * archived, which is not stored separately, so the candidate digests are
 * recomputed for every status the schema allows and for the row's current one.
 * Every other field (content, date, reference, stored hash and link, hash
 * version, lines, tenant) is part of the frame, so any immutable change still
 * fails the comparison and is reported as tampering.
 */
export function journalArchiveMatches(
  entry: Parameters<typeof journalHistoryDigest>[0],
  archivedDigest: string,
): boolean {
  const candidates = new Set<string>([entry.status, ...MUTABLE_JOURNAL_STATUSES]);
  for (const status of candidates) {
    if (journalEvidenceDigest(entry, status) === archivedDigest) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// JH2 — Versioned hash contract ("v2")
// ─────────────────────────────────────────────────────────────────────────────

/** Version prefix INSIDE the HMAC input — the hash itself is version-bound. */
export const JOURNAL_HASH_V2_PREFIX = 'JH:v2|';

export interface JournalHashLinePayload {
  glAccountId: string;
  /** number | Prisma.Decimal | string — normalized defensively to number */
  debit: number | string | { toNumber(): number };
  credit: number | string | { toNumber(): number };
  description?: string | null;
}

function lineCanonical(l: JournalHashLinePayload): string {
  const debit = toMoneyNumber(l.debit);
  const credit = toMoneyNumber(l.credit);
  const description = l.description ?? '';
  // F2 (JH2.15): every field is length-prefixed with its UTF-8 byte length
  // (hex, ':' separator) — boundaries are therefore unambiguous regardless of
  // any '|', ';', Unicode or newlines inside the content. Value-based only:
  // line physical order/index is not part of the hash (stable sort below).
  return (
    lenPrefixed(l.glAccountId) +
    lenPrefixed(debit.toFixed(2)) +
    lenPrefixed(credit.toFixed(2)) +
    lenPrefixed(description)
  );
}

/**
 * F2 (JH2.15) — injective field encoding: "utf8ByteLength(hex):bytes".
 * The reader knows exactly where each field ends, so delimiter characters
 * inside free text can never be confused with structure. Not an artisanal
 * escaping scheme: a deterministic structural encoding.
 */
function lenPrefixed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8').toString(16)}:${value}`;
}

function toMoneyNumber(v: JournalHashLinePayload['debit']): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return v.toNumber();
}

/**
 * V2: HMAC-SHA-256 over "JH:v2|" + pipe-joined protected fields, with ALL
 * lines canonicalized (stable lexicographic sort over the serialized lines).
 * Line order in the DB is irrelevant. `status` is NOT part of the payload:
 * the hash represents the accounting substance at the moment of POST.
 * Legacy-opaque tails chain via previousHash exactly like v2 tails.
 */
export function computeEntryHashV2(payload: {
  id: string;
  companyId: string;
  date: Date | string;
  description: string;
  reference: string | null;
  previousHash: string | null;
  lines: JournalHashLinePayload[];
}): string {
  const dateIso =
    payload.date instanceof Date
      ? payload.date.toISOString()
      : new Date(payload.date).toISOString();

  // F2 (JH2.15): length-prefixed line encoding; sorted on the serialized
  // bytes (line order independence retained); without any line-number position.
  const linesFrame = `${lenPrefixed(String(payload.lines.length))};` +
    payload.lines
      .map((l) => lineCanonical(l))
      .sort()
      .join(';');

  const data =
    JOURNAL_HASH_V2_PREFIX +
    [
      payload.id,
      payload.companyId,
      dateIso,
      payload.description,
      payload.reference ?? '',
      payload.previousHash ?? '',
      linesFrame,
    ]
      // Every field is length-prefixed: separators cannot be spoofed by
      // content ('|' inside descriptions is just data).
      .map(lenPrefixed)
      .join('|');

  return createHmac('sha256', getJournalHmacSecret()).update(data).digest('hex');
}

/**
 * Compute HMAC-SHA-256 hash for an audit log entry, chaining with the previous log's hash.
 */
export function computeAuditHash(payload: {
  id: string;
  companyId: string | null;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  details: string | null;
  previousHash: string | null;
}): string {
  const data = [
    payload.id,
    payload.companyId ?? '',
    payload.userId ?? '',
    payload.action,
    payload.entity,
    payload.entityId ?? '',
    payload.details ?? '',
    payload.previousHash ?? '',
  ].join('|');

  return createHmac('sha256', getJournalHmacSecret()).update(data).digest('hex');
}

/**
 * Explicit verdict for "an archive record exists but this machine cannot read
 * it". Kept distinct from a tamper code: the stored rows do not prove tampering
 * and blaming them made operators chase a phantom HASH_MISMATCH.
 */
export const ARCHIVE_UNAVAILABLE = 'ARCHIVE_UNAVAILABLE';

/** Internal signal: an existing recovery archive could not be read. */
class RecoveryArchiveUnavailableError extends Error {
  constructor(readonly detail: unknown) {
    super('The portable recovery archive exists but could not be read');
    this.name = 'RecoveryArchiveUnavailableError';
  }
}

/** Fail-closed firstBreak shared by both chain verifiers. */
function archiveUnavailableBreak(): NonNullable<IntegrityResult['firstBreak']> {
  return {
    entryId: '(recovery archive)',
    entryDate: 'n/a',
    description: 'the portable recovery archive recorded on this installation could not be read',
    expectedHash: '<readable recovery archive>',
    actualHash: `unreadable (${ARCHIVE_UNAVAILABLE})`,
  };
}

/**
 * Load the authenticated recovery evidence for the given ids.
 *
 * Two states look alike from the outside and must never be merged:
 *  (a) this installation HAS no recovery archive — no portable recovery was ever
 *      restored here, or the provenance module cannot load on this runtime, or
 *      the archive table has not been created yet. Local HMAC verification then
 *      applies unchanged, exactly as before this boundary existed;
 *  (b) an archive record exists but reading/parsing it failed. The history it
 *      alone can certify is then uncertifiable, so the caller must report that
 *      state instead of a tamper code the stored rows do not prove.
 * Both paths stay fail-closed; (b) simply stops lying about the cause.
 */
async function loadRecoveryArchive(
  kind: 'journal' | 'audit',
  companyId: string | null,
): Promise<RecoveryArchive | undefined> {
  let provenance: typeof import('./backup-recovery-provenance');
  try {
    provenance = await import('./backup-recovery-provenance');
  } catch {
    // The provenance module refuses non-Node runtimes: no archive is possible.
    return undefined;
  }
  try {
    const evidence = await provenance.loadRecoveryEvidence(kind, companyId);
    return evidence.size > 0 ? evidence : undefined;
  } catch (error) {
    if (error instanceof provenance.RecoveryProvenanceError &&
        error.code === 'RECOVERY_PROVENANCE_ABSENT') {
      // The archive table does not exist (migration not applied). On a purely
      // LOCAL installation this is the normal state and nothing changes.
      return undefined;
    }
    throw new RecoveryArchiveUnavailableError(error);
  }
}

async function loadJournalArchive(companyId: string): Promise<RecoveryArchive | undefined> {
  return loadRecoveryArchive('journal', companyId);
}

/**
 * Verify the integrity of the entire journal entry hash chain for a company.
 * Returns { valid, totalChecked, firstBreak }.
 */
export interface IntegrityResult {
  valid: boolean;
  totalChecked: number;
  firstBreak: {
    entryId: string;
    entryDate: string;
    description: string;
    expectedHash: string;
    actualHash: string;
  } | null;
  /** JH2 extensions — optional to preserve the historical shape. */
  reasonCode?: string;
  /** Chain members (posted + formerly-posted, hash != null). */
  members?: number;
  /** Members whose hash is legacy (hashVersion != 'v2'). */
  legacyMembers?: number;
  /** Members whose hash is version 'v2'. */
  v2Members?: number;
  /** true/false when a chain-head row exists; null when no head row exists. */
  headConsistent?: boolean | null;
  /** true when a legacy row could not be certified under its own format. */
  legacyUncertifiable?: boolean;
}

export async function verifyJournalChain(
  companyId: string,
): Promise<IntegrityResult> {
  const { db } = await import('@/lib/db');

  let archive: RecoveryArchive | undefined;
  try {
    archive = await loadJournalArchive(companyId);
  } catch (error) {
    // Fail closed when recovered history cannot be certified.
    if (!(error instanceof RecoveryArchiveUnavailableError)) throw error;
    return {
      valid: false,
      totalChecked: 0,
      firstBreak: archiveUnavailableBreak(),
      reasonCode: ARCHIVE_UNAVAILABLE,
    };
  }

  // Include archived drafts for evidence checks, not as chain members. Without
  // recovery evidence the existing posted/void query remains unchanged.
  const rows = (await db.journalEntry.findMany({
    where: {
      companyId,
      OR: [
        { status: 'posted' },
        { status: 'void' },
        ...(archive ? [{ id: { in: [...archive.keys()] } }] : []),
      ],
    },
    select: {
      id: true,
      companyId: true,
      date: true,
      description: true,
      reference: true,
      status: true,
      hash: true,
      previousHash: true,
      hashVersion: true,
      lines: {
        select: {
          glAccountId: true,
          debit: true,
          credit: true,
          description: true,
        },
      },
    },
  })) as unknown as ChainRow[];

  const head = await db.journalChainHead.findUnique({
    where: { companyId },
    select: { lastHash: true, lastEntryId: true },
  });

  const v = buildChainVerdict(companyId, rows, head, archive);
  return {
    valid: v.valid ?? false,
    totalChecked: v.totalChecked ?? 0,
    firstBreak: v.firstBreak ?? null,
    reasonCode: v.reasonCode,
    headConsistent: v.headConsistent,
    members: v.members,
    legacyMembers: v.legacyMembers,
    v2Members: v.v2Members,
    legacyUncertifiable: v.legacyUncertifiable,
  };
}

export interface ChainVerdict {
  valid?: boolean;
  reasonCode?: string;
  firstBreak?: IntegrityResult['firstBreak'];
  totalChecked?: number;
  members?: number;
  legacyMembers?: number;
  v2Members?: number;
  tailId?: string;
  tailHash?: string;
  headConsistent?: boolean | null;
  legacyUncertifiable?: boolean;
}

/**
 * Minimal shape of an audit chain member used by the topology helpers.
 * `createdAt` is part of the recovery evidence digest but not of the links.
 */
export interface AuditLinkRow {
  id: string;
  hash: string | null;
  previousHash: string | null;
}

export interface AuditLineagePartition<T extends AuditLinkRow> {
  /**
   * One entry per ROOT (`previousHash === null`), in stored-link order.
   *
   * A local installation has exactly one. A portable recovery adds the source
   * installation's history as its own lineage, because those rows carry source
   * HMAC values that are retained verbatim and can never be re-linked to the
   * destination chain without rewriting history.
   */
  lineages: T[][];
  /** First structural break, or undefined when the stored links are coherent. */
  reasonCode?: string;
  offender?: T;
}

/**
 * Partition hashed audit rows into link-connected lineages and report the FIRST
 * structural defect (duplicate stored hash, fork, missing root, cycle, orphan).
 *
 * This is the shared topology contract for the installation-wide verifier and
 * for the restore validator: a row is never exempted here, and every member must
 * be reachable from exactly one ROOT through its stored `previousHash` link.
 */
export function partitionAuditLineages<T extends AuditLinkRow>(
  rows: readonly T[],
): AuditLineagePartition<T> {
  const members = rows.filter((row) => row.hash != null);
  if (members.length === 0) return { lineages: [] };

  const byStoredHash = new Map<string, number>();
  for (const member of members) {
    byStoredHash.set(member.hash as string, (byStoredHash.get(member.hash as string) ?? 0) + 1);
  }
  for (const [storedHash, count] of byStoredHash) {
    if (count > 1) {
      return { lineages: [], reasonCode: 'DUPLICATE_MEMBER_HASH', offender: members.find((m) => m.hash === storedHash) };
    }
  }

  const successor = new Map<string, T>();
  for (const member of members) {
    if (member.previousHash == null) continue;
    if (successor.has(member.previousHash)) {
      return { lineages: [], reasonCode: 'CHAIN_FORK', offender: member };
    }
    successor.set(member.previousHash, member);
  }

  const roots = members.filter((member) => member.previousHash == null);
  if (roots.length === 0) return { lineages: [], reasonCode: 'CHAIN_ROOT_COUNT', offender: members[0] };

  const visited = new Set<string>();
  const lineages: T[][] = [];
  for (const root of roots) {
    if (visited.has(root.id)) {
      return { lineages: [], reasonCode: 'CHAIN_ORPHAN', offender: root };
    }
    const lineage: T[] = [root];
    visited.add(root.id);
    let current: T = root;
    for (;;) {
      const next = successor.get(current.hash as string);
      if (!next) break;
      if (visited.has(next.id)) return { lineages: [], reasonCode: 'CHAIN_CYCLE', offender: next };
      visited.add(next.id);
      lineage.push(next);
      current = next;
    }
    lineages.push(lineage);
  }
  if (visited.size !== members.length) {
    return { lineages: [], reasonCode: 'CHAIN_ORPHAN', offender: members.find((m) => !visited.has(m.id)) };
  }
  return { lineages };
}

export interface ChainRow {
  id: string;
  companyId: string;
  date: Date;
  description: string;
  reference: string | null;
  status: string;
  hash: string | null;
  previousHash: string | null;
  hashVersion: string | null;
  lines: Array<{
    glAccountId: string;
    debit: number | string | { toNumber(): number };
    credit: number | string | { toNumber(): number };
    description?: string | null;
  }>;
}

/**
 * Pure (DB-free) link-topology chain verdict. JH2.12 extraction: shared by
 * verifyJournalChain (with rows + head from the DB) and by the restore
 * transaction (rows + candidate head from the backup being validated).
 * ROOT = member with previousHash === null; TAIL = lastwalked member.
 */
export function buildChainVerdict(
  companyId: string,
  entries: ChainRow[],
  // head: the actual chain-head row, or null when absent. `undefined`
  // SELECTS derivation mode: head checks are skipped and only the certified
  // TAIL is returned (used by restore inside its own tx).
  head: { lastHash: string | null; lastEntryId: string | null } | null | undefined,
  // archive: authenticated evidence for recovered source members (id -> digest).
  // Absent means "everything here was written locally" (unchanged behavior).
  archive?: RecoveryArchive,
): ChainVerdict {

  // JH2 classification: link-topology based. Members = rows carrying a hash;
  // posted rows without a hash violate the membership contract, never-posted
  // rows (void without hash) are ignored.
  const memberRows = entries.filter((e) => e.hash != null);
  const unsealed = entries.filter(
    (e) => e.status === 'posted' && e.hash == null,
  );
  const unknownVersion = memberRows.filter(
    (m) => m.hashVersion != null && m.hashVersion !== 'v2',
  );
  const meta = {
    members: memberRows.length,
    legacyMembers: memberRows.filter((m) => m.hashVersion == null).length,
    v2Members: memberRows.filter((m) => m.hashVersion === 'v2').length,
  };

  // (1)(7) a posted entry must never lack its seal.
  if (unsealed.length > 0) {
    const u = unsealed[0];
    return {
      valid: false,
      totalChecked: 0,
      firstBreak: {
        entryId: u.id,
        entryDate: u.date.toISOString(),
        description: u.description,
        expectedHash: '<!=null>',
        actualHash: 'null',
      },
      reasonCode: 'MEMBER_HASH_NULL',
      members: 0,
    };
  }

  // Unknown version marker: explicit legacy-uncertifiable evidence. Never
  // silently reinterpreted as tamper, never rewritten.
  if (unknownVersion.length > 0) {
    const u = unknownVersion[0];
    return {
      valid: false,
      totalChecked: 0,
      firstBreak: {
        entryId: u.id,
        entryDate: u.date.toISOString(),
        description: u.description,
        expectedHash: "<hashVersion in {null, 'v2'}>",
        actualHash: String(u.hashVersion),
      },
      reasonCode: 'HASH_VERSION_UNKNOWN',
      legacyUncertifiable: true,
      ...meta,
    };
  }

  // Recovery evidence also covers unsealed drafts. Check their presence and
  // authenticated content before accepting even an empty chain; never require
  // them to have a seal or manufacture one for them.
  if (archive && archive.size > 0) {
    const storedRows = new Map(entries.map((row) => [row.id, row]));
    for (const [id, evidence] of archive) {
      const row = storedRows.get(id);
      if (!row) {
        return {
          valid: false,
          totalChecked: 0,
          firstBreak: {
            entryId: id,
            entryDate: 'n/a',
            description: 'recovered journal member missing',
            expectedHash: '<archived member present>',
            actualHash: 'absent',
          },
          reasonCode: 'ARCHIVE_MEMBER_MISSING',
          ...meta,
        };
      }
      // Hashed members retain their topology and digest checks below. A removed
      // seal cannot pass here: hash/link/version are part of the archived digest.
      if (row.hash == null && !journalArchiveMatches(row, archiveDigestOf(evidence))) {
        return {
          valid: false,
          totalChecked: 0,
          firstBreak: {
            entryId: row.id,
            entryDate: row.date.toISOString(),
            description: row.description,
            expectedHash: archiveDigestOf(evidence),
            actualHash: journalHistoryDigest(row),
          },
          reasonCode: 'ARCHIVE_HASH_MISMATCH',
          ...meta,
        };
      }
    }
  }

  if (memberRows.length === 0) {
    // JH2: zero members does NOT automatically PASS — a chain-head row
    // bearing an opaque tail (lastHash/lastEntryId) while the member set is
    // empty means the members were removed under a live head (corruption or
    // artificial deletion). Only a clean head (both nulls) may PASS vacuous.
    if (!head) {
      return { valid: true, totalChecked: 0, firstBreak: null, ...meta };
    }
    if (head.lastHash == null && head.lastEntryId == null) {
      return {
        valid: true,
        totalChecked: 0,
        firstBreak: null,
        headConsistent: true,
        ...meta,
      };
    }
    return {
      valid: false,
      totalChecked: 0,
      firstBreak: {
        entryId: head.lastEntryId ?? '(head)',
        entryDate: 'n/a',
        description: 'chain-head without members',
        expectedHash: '<no members AND lastHash/lastEntryId must be null>',
        actualHash: (head.lastHash ?? 'null') as string,
      },
      reasonCode: 'CHAIN_HEAD_WITHOUT_MEMBERS',
      headConsistent: false,
      ...meta,
    };
  }

  // F1 (JH2.15): reject EXPLICITLY two different members carrying the same
  // stored hash value. Independent from fork (previousHash reuse), id
  // duplicates and recomputed-mismatch detection.
  const storedHashCount = new Map<string, number>();
  for (const m of memberRows) storedHashCount.set(m.hash as string, (storedHashCount.get(m.hash as string) ?? 0) + 1);
  for (const [dupHash, n] of storedHashCount) {
    if (n > 1) {
      const dup = memberRows.find((m) => m.hash === dupHash)!;
      return {
        valid: false,
        totalChecked: 0,
        firstBreak: {
          entryId: dup.id,
          entryDate: dup.date.toISOString(),
          description: dup.description,
          expectedHash: '<unique stored hash per member>',
          actualHash: `${n} members carry ${dupHash.slice(0, 12)}…`,
        },
        reasonCode: 'DUPLICATE_MEMBER_HASH',
        ...meta,
      };
    }
  }

  // (4) no fork: at most one successor per stored previousHash reference.
  const successorCount = new Map<string, number>();
  for (const m of memberRows) {
    if (m.previousHash == null) continue;
    successorCount.set(
      m.previousHash,
      (successorCount.get(m.previousHash) ?? 0) + 1,
    );
  }
  for (const [prevHash, n] of successorCount) {
    if (n > 1) {
      const dup = memberRows.find((m) => m.previousHash === prevHash)!;
      return {
        valid: false,
        totalChecked: 0,
        firstBreak: {
          entryId: dup.id,
          entryDate: dup.date.toISOString(),
          description: dup.description,
          expectedHash: '<unique successor>',
          actualHash: `${n} members chain on ${prevHash}`,
        },
        reasonCode: 'CHAIN_FORK',
        ...meta,
      };
    }
  }

  // (1)(9) exactly one ROOT (previousHash=null).
  const roots = memberRows.filter((m) => m.previousHash == null);
  if (roots.length !== 1) {
    const u = roots[0] ?? memberRows[0];
    return {
      valid: false,
      totalChecked: 0,
      firstBreak: {
        entryId: u.id,
        entryDate: u.date.toISOString(),
        description: u.description,
        expectedHash: '<exactly one ROOT: previousHash=null>',
        actualHash: `<${roots.length} roots>`,
      },
      reasonCode: 'CHAIN_ROOT_COUNT',
      ...meta,
    };
  }

  const root = roots[0];
  // Walk ROOT -> TAIL along stored links (createdAt is NOT an order
  // authority; the stored hash links are the topology).
  const visited = new Set<string>([root.id]);
  const order: typeof memberRows = [root];
  let cur: (typeof memberRows)[number] = root;
  while (true) {
    const next = memberRows.find((m) => m.previousHash === cur.hash);
    if (!next) break;
    if (visited.has(next.id)) {
      return {
        valid: false,
        totalChecked: visited.size,
        firstBreak: {
          entryId: next.id,
          entryDate: next.date.toISOString(),
          description: next.description,
          expectedHash: '<acyclic>',
          actualHash: 'cycle detected',
        },
        reasonCode: 'CHAIN_CYCLE',
        ...meta,
      };
    }
    visited.add(next.id);
    order.push(next);
    cur = next;
  }

  // (2)(3)(6) unique linear chain: full reachability, no orphan, no
  // parallel chain.
  if (visited.size !== memberRows.length) {
    const orphan = memberRows.find((m) => !visited.has(m.id))!;
    return {
      valid: false,
      totalChecked: visited.size,
      firstBreak: {
        entryId: orphan.id,
        entryDate: orphan.date.toISOString(),
        description: orphan.description,
        expectedHash: '<reachable from ROOT>',
        actualHash: 'unreachable / parallel chain',
      },
      reasonCode: 'CHAIN_ORPHAN',
      ...meta,
    };
  }

  // (10) stored previousHash must equal the stored hash of the previous
  // member (the stored link is audited, not just derived).
  for (let i = 1; i < order.length; i++) {
    if (order[i].previousHash !== order[i - 1].hash) {
      const m = order[i];
      return {
        valid: false,
        totalChecked: visited.size,
        firstBreak: {
          entryId: m.id,
          entryDate: m.date.toISOString(),
          description: m.description,
          expectedHash: (order[i - 1].hash ?? 'null') as string,
          actualHash: (m.previousHash ?? 'null') as string,
        },
        reasonCode: 'STORED_PREVIOUS_HASH_MISMATCH',
        ...meta,
      };
    }
  }

  // (11) recomputed hash == stored hash under the row's own hashVersion.
  // Legacy rows are verified under V1 with their stored previousHash and are
  // never converted; every local result is explicit legacy evidence.
  // Recovered members are verified against their authenticated evidence digest
  // instead (the source key is gone); they are never recomputed or re-signed.
  for (const m of order) {
    const archived = archive?.get(m.id);
    if (archived !== undefined) {
      // F3: the archived digest covers the status the row had when it was
      // archived; a later legitimate void/rollback/reclassification is local
      // workflow state, not tampering. Nothing else is tolerated.
      if (!journalArchiveMatches(
        m as unknown as Parameters<typeof journalHistoryDigest>[0], archiveDigestOf(archived))) {
        return {
          valid: false,
          totalChecked: visited.size,
          firstBreak: {
            entryId: m.id,
            entryDate: m.date.toISOString(),
            description: m.description,
            expectedHash: archiveDigestOf(archived),
            actualHash: journalHistoryDigest(m as unknown as Parameters<typeof journalHistoryDigest>[0]),
          },
          reasonCode: 'ARCHIVE_HASH_MISMATCH',
          ...meta,
        };
      }
      continue;
    }
    const isV2 = m.hashVersion === 'v2';
    const expected = isV2
      ? computeEntryHashV2({
          id: m.id,
          companyId: m.companyId,
          date: m.date as Date,
          description: m.description,
          reference: m.reference,
          previousHash: m.previousHash,
          lines: (m as unknown as { lines: JournalHashLinePayload[] }).lines,
        })
      : recomputeLegacyHash(m);
    if (m.hash !== expected) {
      return {
        valid: false,
        totalChecked: visited.size,
        firstBreak: {
          entryId: m.id,
          entryDate: m.date.toISOString(),
          description: m.description,
          expectedHash: expected,
          actualHash: m.hash as string,
        },
        reasonCode: isV2 ? 'HASH_MISMATCH' : 'LEGACY_HASH_RECOMPUTE_MISMATCH',
        legacyUncertifiable: !isV2,
        ...meta,
      };
    }
  }

  // (13) TAIL — unique by fork/orphan checks; single-node ROOT == TAIL.
  // The head is a durable serialization anchor that must mirror the TAIL.
  const tail = cur;
  let headConsistent: boolean | null = null;
  if (head) {
    headConsistent = head.lastHash === tail.hash && head.lastEntryId === tail.id;
    if (!headConsistent) {
      return {
        valid: false,
        totalChecked: visited.size,
        firstBreak: {
          entryId: tail.id,
          entryDate: tail.date.toISOString(),
          description: tail.description,
          expectedHash: head.lastHash ?? 'null',
          actualHash: (tail.hash ?? 'null') as string,
        },
        reasonCode: 'CHAIN_HEAD_MISMATCH',
        ...meta,
      };
    }
  } else if (meta.v2Members > 0 && head !== undefined) {
    return {
      valid: false,
      totalChecked: visited.size,
      firstBreak: {
        entryId: tail.id,
        entryDate: tail.date.toISOString(),
        description: tail.description,
        expectedHash: '<chain-head row>',
        actualHash: 'absent',
      },
      reasonCode: 'MISSING_CHAIN_HEAD',
      ...meta,
    };
  }

  return {
    valid: true,
    totalChecked: visited.size,
    firstBreak: null,
    reasonCode: undefined,
    headConsistent,
    tailId: tail.id,
    tailHash: tail.hash as string,
    ...meta,
  };
}

/**
 * Legacy (V1) hash of a member row, reconstructed from the historical
 * 035a56d contract: HMAC-SHA-256 over [id|companyId|date.toISOString() |
 * description | reference ?? '' | status('posted') | totalDebit.toFixed(2) |
 * totalCredit.toFixed(2) | previousHash ?? '']. Totals derive from the row
 * lines (immutable after POST); the stored previousHash is the declared
 * link. Legacy rows are never converted or re-hashed.
 */
export function recomputeLegacyHash(entry: {
  id: string;
  companyId: string;
  date: Date;
  description: string;
  reference: string | null;
  previousHash: string | null;
  lines: JournalHashLinePayload[];
}): string {
  const totalDebit = entry.lines.reduce((s, l) => s + toMoneyNumber(l.debit), 0);
  const totalCredit = entry.lines.reduce((s, l) => s + toMoneyNumber(l.credit), 0);
  return computeEntryHash({
    id: entry.id,
    companyId: entry.companyId,
    date: entry.date.toISOString(),
    description: entry.description,
    reference: entry.reference,
    status: 'posted',
    totalDebit,
    totalCredit,
    previousHash: entry.previousHash,
  });
}

/**
 * Result of an audit chain verification.
 * The audit chain is GLOBAL: `previousHash` links are not company-scoped, so a
 * tenant filter cannot be applied to the walk itself without breaking it.
 */
export interface AuditChainResult extends IntegrityResult {
  scope: 'global-audit-chain';
  /** Rows carrying a hash (chain members). */
  members: number;
  /** Rows written before chaining was activated — tolerated, never verified. */
  legacyRows: number;
  /** Rows belonging to the requested company (absent when no scope is given). */
  companyRows?: number;
}

export interface AuditChainScope {
  /** Caller company — governs reporting only, never the chain walk. */
  companyId?: string | null;
}

type AuditChainRow = {
  id: string;
  companyId: string | null;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  details: string | null;
  hash: string | null;
  previousHash: string | null;
  /** Part of the recovery evidence digest, so it must be read, not assumed. */
  createdAt: Date | string;
};

/**
 * Verify the integrity of the audit log hash chain.
 *
 * S12: rows without a hash are legacy history written before chaining was
 * activated. They are counted but never verified, so a mixed hashed/unhashed
 * history stays valid while every new row is sealed. The walk follows the
 * stored links (ROOT = previousHash null, TAIL = last reachable member), the
 * same topology contract used for journal entries.
 */
export async function verifyAuditChain(scope?: AuditChainScope): Promise<AuditChainResult> {
  const { db } = await import('@/lib/db');
  const companyId = scope?.companyId ?? null;

  const logs = (await db.auditLog.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      companyId: true,
      userId: true,
      action: true,
      entity: true,
      entityId: true,
      details: true,
      hash: true,
      previousHash: true,
      // Required by auditHistoryDigest (the recovery evidence covers the stored
      // timestamp). Omitting it made every archive-aware audit check throw.
      createdAt: true,
    },
  })) as AuditChainRow[];

  const members = logs.filter((l) => l.hash != null);
  const legacyRows = logs.length - members.length;
  const base = {
    scope: 'global-audit-chain' as const,
    members: members.length,
    legacyRows,
    ...(companyId ? { companyRows: logs.filter((l) => l.companyId === companyId).length } : {}),
  };

  let archive: RecoveryArchive | undefined;
  try {
    archive = await loadRecoveryArchive('audit', companyId);
  } catch (error) {
    if (!(error instanceof RecoveryArchiveUnavailableError)) throw error;
    return {
      ...base,
      valid: false,
      totalChecked: logs.length,
      firstBreak: archiveUnavailableBreak(),
      reasonCode: ARCHIVE_UNAVAILABLE,
    };
  }
  if (archive) {
    /*
     * T34: an archived SEAL-LESS row has no chain membership to prove, so presence is
     * all it can be asked for; every other archived id must still be a HASHED member,
     * exactly as before (a sealed row whose hash disappeared stays a reported defect).
     */
    const missing = [...archive.entries()]
      .filter(([id, value]) => (archiveSealLessOf(value)
        ? !logs.some((row) => row.id === id)
        : !members.some((member) => member.id === id)))
      .map(([id]) => id);
    if (missing.length > 0) {
      return {
        ...base,
        valid: false,
        totalChecked: logs.length,
        firstBreak: {
          entryId: missing[0],
          entryDate: '',
          description: 'recovered audit member missing',
          expectedHash: '<archived member present>',
          actualHash: 'absent',
        },
        reasonCode: 'ARCHIVE_MEMBER_MISSING',
      };
    }
    /*
     * T34: a seal-less archived row is certified by the bytes this installation
     * stores — the archive declared the absence explicitly, so it can never excuse a
     * missing seal, and any drift of those bytes still fails here.
     */
    for (const row of logs) {
      const archived = archive.get(row.id);
      if (archived === undefined || !archiveSealLessOf(archived)) continue;
      const actual = auditHistoryDigest(
        row as unknown as Parameters<typeof auditHistoryDigest>[0]);
      const expected = archiveDigestOf(archived);
      if (actual !== expected) {
        return {
          ...base,
          valid: false,
          totalChecked: logs.length,
          firstBreak: {
            entryId: row.id,
            entryDate: '',
            description: `unsealed archived audit row: ${row.entity}${row.entityId ? `:${row.entityId}` : ''}`,
            expectedHash: expected,
            actualHash: actual,
          },
          reasonCode: 'ARCHIVE_HASH_MISMATCH',
        };
      }
    }
  }

  if (members.length === 0) {
    return { valid: true, totalChecked: logs.length, firstBreak: null, ...base };
  }

  /**
   * A break located in another tenant is reported without cross-tenant
   * identifiers: the caller learns the chain is broken, not whose row broke it.
   */
  const breakFor = (
    row: AuditChainRow,
    totalChecked: number,
    reasonCode: string,
    firstBreak: NonNullable<IntegrityResult['firstBreak']>,
  ): AuditChainResult => ({
    valid: false,
    totalChecked,
    firstBreak:
      companyId != null && row.companyId !== companyId
        ? {
            entryId: '(outside the caller company)',
            entryDate: '',
            description: 'redacted (other tenant)',
            expectedHash: '<integrity>',
            actualHash: '<integrity>',
          }
        : firstBreak,
    reasonCode,
    ...base,
  });

  // (F1) two members must never share a stored hash value, (fork) at most one
  // successor per stored previousHash reference, and every member must be
  // reachable from exactly one ROOT through its stored link. The walk is now
  // expressed as a partition so a portable-recovered installation can hold the
  // source lineage next to the retained local one — see the root-count note.
  const partition = partitionAuditLineages(members);
  if (partition.reasonCode) {
    const offender = partition.offender as AuditChainRow;
    const detail = partition.reasonCode === 'DUPLICATE_MEMBER_HASH'
      ? `<unique stored hash per member>`
      : partition.reasonCode === 'CHAIN_FORK'
        ? '<unique successor>'
        : partition.reasonCode === 'CHAIN_ROOT_COUNT'
          ? '<exactly one ROOT: previousHash=null>'
          : partition.reasonCode === 'CHAIN_CYCLE'
            ? '<acyclic>'
            : '<reachable from ROOT>';
    const actual = partition.reasonCode === 'CHAIN_ROOT_COUNT'
      ? '<0 roots>'
      : partition.reasonCode === 'CHAIN_CYCLE'
        ? 'cycle detected'
        : partition.reasonCode === 'CHAIN_ORPHAN'
          ? 'unreachable / parallel chain'
          : `${offender.hash?.slice(0, 12) ?? ''}…`;
    return breakFor(offender, 0, partition.reasonCode, {
      entryId: offender.id,
      entryDate: '',
      description: `${offender.entity}${offender.entityId ? `:${offender.entityId}` : ''}`,
      expectedHash: detail,
      actualHash: actual,
    });
  }
  const order: AuditChainRow[] = partition.lineages.flat() as AuditChainRow[];

  /**
   * ROOT COUNT.
   *
   * A purely local installation keeps EXACTLY ONE linear chain, as before: a
   * second root means history was spliced in and is reported as invalid.
   *
   * A portable recovery is the single documented exception, and it is itself
   * bound to evidence: the recovered source history keeps the SOURCE
   * installation's stored hashes (it is never re-signed), so it cannot be linked
   * onto the destination chain. It becomes a second lineage that is only
   * accepted while a recovery archive exists on this installation, and every one
   * of its members must still pass the per-row archive/local-HMAC check below.
   * A root that cannot be certified therefore still fails; the allowance is
   * "more than one CERTIFIED lineage after a recorded recovery", never "more
   * than one root is fine".
   */
  if (partition.lineages.length !== 1 && !archive) {
    const offender = partition.lineages[1]?.[0] ?? order[0];
    return breakFor(offender, 0, 'CHAIN_ROOT_COUNT', {
      entryId: offender.id,
      entryDate: '',
      description: `${offender.entity}${offender.entityId ? `:${offender.entityId}` : ''}`,
      expectedHash: '<exactly one ROOT: previousHash=null>',
      actualHash: `<${partition.lineages.length} roots> without a recovery archive`,
    });
  }

  // recomputed hash == stored hash. Recovered rows are verified against their
  // authenticated evidence digest instead of being recomputed under this key.
  for (const m of order) {
    const archived = archive?.get(m.id);
    if (archived !== undefined) {
      const actual = auditHistoryDigest(m as unknown as Parameters<typeof auditHistoryDigest>[0]);
      const expected = archiveDigestOf(archived);
      if (actual !== expected) {
        return breakFor(m, order.length, 'ARCHIVE_HASH_MISMATCH', {
          entryId: m.id,
          entryDate: '',
          description: `${m.entity}${m.entityId ? `:${m.entityId}` : ''}`,
          expectedHash: expected,
          actualHash: actual,
        });
      }
      // An archived attribution is re-verified with the LOCAL key on every check:
      // the label alone certifies nothing, so a rewritten row or a fabricated
      // projection still fails here instead of passing as a stored opinion. A row
      // with BOTH references erased is proven with both, never one at a time.
      // T36: a row the payload does not carry is RETAINED IN PLACE, so no
      // attribution is re-proved for it — no source event exists to project from,
      // and the stored-bytes digest compared above is its whole certification.
      const claim = archiveOutsidePayloadOf(archived)
        ? undefined
        : archiveAttributionOf(archived);
      if (claim !== undefined && !retainedAttributionHolds(m as AuditHistoryRowLike, claim)) {
        return breakFor(m, order.length, 'ARCHIVE_ATTRIBUTION_MISMATCH', {
          entryId: m.id,
          entryDate: '',
          description: `${m.entity}${m.entityId ? `:${m.entityId}` : ''}`,
          // Never the reference itself: only that the archived proof failed.
          expectedHash: '<original seal over the stored content with the archived attribution>',
          actualHash: m.hash as string,
        });
      }
      continue;
    }
    const expectedHash = computeAuditHash({
      id: m.id,
      companyId: m.companyId,
      userId: m.userId,
      action: m.action,
      entity: m.entity,
      entityId: m.entityId,
      details: m.details,
      previousHash: m.previousHash,
    });
    if (m.hash !== expectedHash) {
      return breakFor(m, order.length, 'HASH_MISMATCH', {
        entryId: m.id,
        entryDate: '',
        description: `${m.entity}${m.entityId ? `:${m.entityId}` : ''}`,
        expectedHash,
        actualHash: m.hash as string,
      });
    }
  }

  return { valid: true, totalChecked: logs.length, firstBreak: null, ...base };
}
