/**
 * S21 / T28 (L62) — THE EXACT SHAPE OF THE OPERATOR'S REAL FAILURE.
 *
 * The real installation refused completion with
 *   `RESTORE_ID_CONFLICT: AuditLog [mismatch: content; fields: userId]`
 * after a successful owner-email challenge (200). The improved diagnostic pinpoints
 * the ONLY differing canonical field: the retained, locally-certified audit row
 * references a HISTORICAL LOCAL account id that is neither the authenticated
 * source actor nor the current identity-map target (plausible local account churn,
 * e.g. the local account a previous recovery mapped the event onto).
 *
 * Such a row is still the SAME already-present event:
 *  - every other canonical field (content, stored seal, stored link, timestamp)
 *    equals the authenticated source event (an erased company reference is the
 *    same legacy drift the erased-reference path already tolerates);
 *  - the row's stored seal is the ORIGINAL source seal, kept verbatim, and it
 *    verifies under THIS installation's key over the ORIGINAL authenticated
 *    event — never over the retained row's own mutable actor/company columns —
 *    the same local-HMAC bar the erased-reference projection already had to clear;
 *  - the actor reference on the retained row is authentic local history data that
 *    the original seal never covered, so reuse rewrites nothing.
 * The retained row is therefore reused BYTE-IDENTICALLY: no insertion, no
 * projection, no re-sign.
 *
 * Everything else stays fail-closed, and each negative is pinned below: any other
 * canonical difference (content, seal, link, timestamp, action, a live foreign
 * company), missing or invalid local certification, a rotated/foreign installation
 * key, a null actor on one side only, and a caller that cannot describe the
 * authenticated source event at all.
 *
 * No real identifier appears here: company, accounts and audit ids are synthetic
 * (`@example.test` domain, deterministic prefixes).
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  createMemoryRecoveryChallengeStore, completePortableRecovery, requestPortableRecoveryChallenge,
  type PortableRecoveryDeps,
} from '@/lib/backup-recovery-auth';
import { createMemoryRecoveryLockStore } from '@/lib/backup-recovery-lock';
import {
  assertDestinationAuditPreserved, assertStoredEvidence, auditEvidenceOf, buildRecoveryProvenance,
  createPortableDestinationRestore,
} from '@/lib/backup-recovery-provenance';
import type { BackupData } from '@/lib/backup';
import { RESTORE_MODELS, validateRestoreDestination, type Row, type Tables } from '@/lib/backup-validation';
import {
  attestRetainedAttribution, auditHistoryDigestOf, auditOverlapExpectations, auditSealCandidates,
  auditSealReference, computeAuditHash, planAuditOverlap, planAuditOverlapWithAttribution,
  retainedActorSealHolds, retainedAttributionHolds, type AuditHistoryRowLike, type RecoveryArchive,
} from '@/lib/journal-hash';
import {
  COMPANY_ID, COMPANY_LEGAL_NAME, OWNER, SOURCE_PASSWORD,
  auditRow, fakeClient, fakeProvenance, makeSnapshot, portableFile, userRow,
} from './helpers';

/** The authenticated source actor (the account sealed in the backup). */
const SOURCE_ACTOR = OWNER.id;
/** Today's identity-map target: same person, same email, different local id. */
const MAPPED_TARGET = 'user-local-owner-current';
/** A historical LOCAL account id: neither the source actor nor today's target. */
const HISTORICAL_ACTOR = 'user-local-owner-previous';
/**
 * T31 — this installation's OWN, live local account id referenced by retained
 * audit history while the authenticated source event carries no actor at all.
 */
const LIVE_LOCAL_ACTOR = 'user-local-owner-live';
const SHARED = 'audit-owner-bound';

/** An audit row sealed over exactly these references under the LOCAL key. */
function sealedRow(input: {
  id: string;
  userId: string | null;
  companyId?: string | null;
  action?: string;
  entity?: string;
  entityId?: string | null;
  details?: string | null;
  previousHash?: string | null;
  createdAt?: string;
}): Row {
  const content = {
    id: input.id,
    companyId: input.companyId === undefined ? COMPANY_ID : input.companyId,
    userId: input.userId,
    action: input.action ?? 'JOURNAL_POSTED',
    entity: input.entity ?? 'JournalEntry',
    entityId: input.entityId === undefined ? 'entry-1' : input.entityId,
    details: input.details ?? null,
    previousHash: input.previousHash ?? null,
  };
  return {
    ...content,
    createdAt: input.createdAt ?? '2026-01-05T10:00:00.000Z',
    hash: computeAuditHash(content),
  };
}

function emptyTables(): Tables {
  return Object.fromEntries(Object.values(RESTORE_MODELS).map((model) => [model, [] as Row[]]));
}

/** Destination: the shell company + the local accounts + retained history. */
function destination(audits: Row[], extraUsers: Row[] = []): Tables {
  const tables = emptyTables();
  tables.Company = [{
    id: COMPANY_ID, legalName: 'Compania Origen S.A.', entityType: 'BUSINESS', taxId: null,
    createdAt: '2026-01-05T10:00:00.000Z', updatedAt: '2026-01-05T10:00:00.000Z',
  }];
  tables.User = [
    userRow(MAPPED_TARGET, OWNER.email),
    userRow(HISTORICAL_ACTOR, 'history@example.test'),
    ...extraUsers,
  ];
  tables.AuditLog = audits;
  return tables;
}

function sourceTables(audits: Row[]): Tables {
  const tables = emptyTables();
  tables.Company = [{ id: COMPANY_ID, legalName: 'Compania Origen S.A.' }];
  tables.User = [userRow(SOURCE_ACTOR, OWNER.email)];
  tables.AuditLog = audits;
  return tables;
}

function refusal(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the restore to be refused');
}

/** The real shape: source event + retained row that only differs in the actor. */
function realShape() {
  const source = sealedRow({ id: SHARED, userId: SOURCE_ACTOR });
  const retained = { ...source, userId: HISTORICAL_ACTOR };
  return { source, retained };
}

const MAP = { [SOURCE_ACTOR]: MAPPED_TARGET };

describe('retained audit row whose actor is a historical local account (S21/T28)', () => {
  it('reuses the retained row byte-identically instead of refusing a userId-only difference', () => {
    const { source, retained } = realShape();
    const before = JSON.stringify(retained);

    const decision = validateRestoreDestination(
      sourceTables([{ ...source }]), destination([retained]), COMPANY_ID, true, MAP,
    );

    // Same already-present event: reused as stored, never re-inserted.
    expect([...decision.auditReuse.keys()]).toEqual([SHARED]);
    // The evidence is the digest of the STORED retained row (historical actor
    // included), never the would-be-stored mapped expectation.
    expect([...decision.auditReuse.values()]).toEqual([auditHistoryDigestOf(retained as never)]);
    expect([...decision.auditReuse.values()])
      .not.toEqual([auditHistoryDigestOf({ ...retained, userId: MAPPED_TARGET } as never)]);
    // Nothing was projected, relabelled or rewritten: this is not an erased
    // reference, so the archive gains no attribution label.
    expect(decision.auditProjections.size).toBe(0);
    // T30 re-pins this value: the certificate now records the WHOLE verified
    // reference set (actor + company the stored seal covers), not the actor alone,
    // so the preservation re-proof can re-prove the SAME references.
    expect([...decision.auditActorCertifications.entries()])
      .toEqual([[SHARED, { userId: SOURCE_ACTOR, companyId: COMPANY_ID }]]);
    // Byte-identical: the validator certifies, it never edits history.
    expect(JSON.stringify(retained)).toBe(before);
  });

  it('admits the userId-only difference in the planner and records the certified actor', () => {
    // The planner-level contract behind the operator's message: the ONLY canonical
    // difference is `userId`, so the event resolves instead of conflicting.
    const { source, retained } = realShape();
    const expectations = auditOverlapExpectations([source], MAP);
    const plan = planAuditOverlapWithAttribution(expectations, [retained]);
    expect(plan.conflicts).toEqual([]);
    expect([...plan.reuse.keys()]).toEqual([SHARED]);
    expect([...plan.certifiedActors.keys()]).toEqual([SHARED]);
    expect(plan.projections.size).toBe(0);
    expect(plan.mismatches).toEqual([]);
  });

  it('still certifies the ORIGINAL seal under the local key and never the stored label', () => {
    const { source, retained } = realShape();
    const row = retained as unknown as AuditHistoryRowLike;
    const original = source as unknown as AuditHistoryRowLike;
    // The stored seal verifies over the ORIGINAL AUTHENTICATED EVENT…
    expect(retainedActorSealHolds(row, original)).toBe(true);
    // …and nothing else: the stored historical id is not what was signed, another
    // original actor describes another event, and a live equal reference is the
    // plain exact match, not this proof.
    expect(retainedActorSealHolds(row, { ...original, userId: HISTORICAL_ACTOR })).toBe(false);
    expect(retainedActorSealHolds(row, { ...original, userId: 'user-arbitrary-other' })).toBe(false);
    expect(retainedActorSealHolds(sealedRow({ id: SHARED, userId: SOURCE_ACTOR }), original)).toBe(false);
    // A retained row that keeps a LIVE FOREIGN company is a different event and is
    // never certified by this proof (only an ERASED company reference is drifted).
    expect(retainedActorSealHolds({ ...row, companyId: 'company-other' }, original)).toBe(false);
    // The erased-reference proof is a DIFFERENT contract: it only accepts a null.
    expect(retainedAttributionHolds(row, SOURCE_ACTOR)).toBe(false);
    // The row's stored seal is the SOURCE one, kept verbatim (never re-signed).
    expect(retained.hash).toBe(source.hash);
  });

  it('reuses an EARLIER recovery row whose company reference the legacy FK also erased', () => {
    // The real retry shape reported at L62/L65. An earlier recovery stored this
    // event under its LOCAL mapping target M and kept the ORIGINAL source seal
    // verbatim; the company was later deleted while `AuditLog_companyId_fkey` was
    // still `ON DELETE SET NULL` (migration 20261105000000 legacy semantics), so the
    // retained row's company reference is ERASED; M has since been replaced by a new
    // local account R — today's identity-map target. Every other canonical field,
    // the stored seal, the link and the timestamp are those of the authenticated
    // source event.
    //
    // Today this is refused with the operator's exact diagnostic
    //   `RESTORE_ID_CONFLICT: AuditLog [mismatch: content; fields: userId]`
    // because the stored seal was re-computed over the retained (erased) company
    // column instead of over the ORIGINAL authenticated event the seal covers.
    const { source, retained } = realShape();
    const erasedCompany = { ...retained, companyId: null };
    const before = JSON.stringify(erasedCompany);

    const decision = validateRestoreDestination(
      sourceTables([{ ...source }]), destination([erasedCompany]), COMPANY_ID, true, MAP,
    );

    // The same already-present event: reused as stored, never re-inserted.
    expect([...decision.auditReuse.keys()]).toEqual([SHARED]);
    expect([...decision.auditReuse.values()]).toEqual([auditHistoryDigestOf(erasedCompany as never)]);
    // Nothing was projected (the actor column is live local history, not an erased
    // reference) and nothing was relabelled: the certified reference set is
    // recorded so preservation can re-prove the same seal.
    expect(decision.auditProjections.size).toBe(0);
    expect([...decision.auditActorCertifications.entries()])
      .toEqual([[SHARED, { userId: SOURCE_ACTOR, companyId: COMPANY_ID }]]);
    // Byte-identical: the validator certifies, it never edits or re-signs history.
    expect(JSON.stringify(erasedCompany)).toBe(before);
    expect(erasedCompany.hash).toBe(source.hash);
  });

  it('refuses every canonical difference other than the actor reference', () => {
    const { source, retained } = realShape();
    const variants: Array<[string, Row]> = [
      ['details', { ...retained, details: 'rewritten before recovery' }],
      ['action', { ...retained, action: 'OTHER_ACTION' }],
      ['entity', { ...retained, entity: 'OtherEntity' }],
      ['entityId', { ...retained, entityId: 'entry-2' }],
      ['companyId', { ...retained, companyId: 'company-other' }],
      ['previousHash', { ...retained, previousHash: 'c'.repeat(64) }],
      ['createdAt', { ...retained, createdAt: '2026-01-05T10:00:00.001Z' }],
      ['hash', { ...retained, hash: 'b'.repeat(64) }],
    ];
    for (const [field, candidate] of variants) {
      const message = refusal(() => validateRestoreDestination(
        sourceTables([{ ...source }]), destination([candidate]), COMPANY_ID, true, MAP,
      ));
      expect(message, field).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
      expect(message, field).toContain(field);
      // Never a value: no id, actor id, company id, email, hash or content.
      for (const secret of [
        SHARED, COMPANY_ID, SOURCE_ACTOR, MAPPED_TARGET, HISTORICAL_ACTOR, OWNER.email,
        String(source.hash), 'b'.repeat(64), 'rewritten before recovery',
      ]) {
        expect(message, field).not.toContain(secret);
      }
    }
  });

  it('refuses a row that is locally certified for a DIFFERENT actor than the authenticated one', () => {
    // The retained row carries its own, valid local seal — over the historical
    // actor. Its stored seal is therefore not the authenticated event's seal, and
    // the extension must not treat a differently-signed row as that event.
    const { source } = realShape();
    const reSigned = sealedRow({ id: SHARED, userId: HISTORICAL_ACTOR });
    const message = refusal(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([reSigned]), COMPANY_ID, true, MAP,
    ));
    expect(message).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
    expect(message).toContain('fields: hash,userId');
  });

  it('refuses a rotated or foreign installation key instead of reusing readable content', () => {
    // Both rows were sealed by another installation (or before this key rotated):
    // the local HMAC proof is unavailable, so identical-looking content proves
    // nothing and the restore stays fail-closed.
    const content = {
      id: SHARED, companyId: COMPANY_ID, userId: SOURCE_ACTOR, action: 'JOURNAL_POSTED',
      entity: 'JournalEntry', entityId: 'entry-1', details: 'sealed elsewhere', previousHash: null,
    };
    const foreignHash = crypto.createHmac('sha256', 'foreign-installation-key-not-this-one')
      .update([
        content.id, content.companyId, content.userId, content.action, content.entity,
        content.entityId, content.details, '',
      ].join('|'))
      .digest('hex');
    const source = { ...content, createdAt: '2026-01-05T10:00:00.000Z', hash: foreignHash };
    const retained = { ...source, userId: HISTORICAL_ACTOR };
    const message = refusal(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([retained]), COMPANY_ID, true, MAP,
    ));
    expect(message).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
    expect(message).toContain('mismatch: source-seal');
    expect(retainedActorSealHolds(
      retained as unknown as AuditHistoryRowLike, source as unknown as AuditHistoryRowLike,
    )).toBe(false);
  });

  it('routes a retained null actor to the erased-reference projection, never to this extension', () => {
    // Retained row keeps NO actor while the source event has one: the legacy
    // erased-reference projection applies (never this extension, which certifies a
    // LIVE retained actor).
    //
    // T31 re-pins this test on purpose: it used to assert that the MIRROR shape
    // (source event without an actor, retained row with this installation's own
    // live local actor) is refused. That shape is now a certified reuse of
    // unchanged local history — see the T31 block below — so only the projection
    // direction is pinned here.
    const source = sealedRow({ id: SHARED, userId: SOURCE_ACTOR });
    const erased = { ...source, userId: null };
    const projected = validateRestoreDestination(
      sourceTables([{ ...source }]), destination([erased]), COMPANY_ID, true, MAP,
    );
    expect([...projected.auditProjections.entries()]).toEqual([[SHARED, { userId: SOURCE_ACTOR }]]);
    expect(projected.auditActorCertifications.size).toBe(0);
  });

  it('refuses without the authenticated source event, and never as a wildcard', () => {
    const { retained } = realShape();
    // Digest-only planner: nothing describes the source event, so no field-level
    // proof exists and the id stays a collision.
    const digestOnly = planAuditOverlap(
      [{ id: SHARED, storedDigest: auditHistoryDigestOf(retained as never) }],
      new Map([[SHARED, auditHistoryDigestOf({ ...retained, userId: MAPPED_TARGET } as never)]]),
    );
    expect(digestOnly.reuse.size).toBe(0);
    expect(digestOnly.conflicts).toEqual([SHARED]);

    // Planner without an original source row: same refusal, no actor assumption.
    const plan = planAuditOverlapWithAttribution(
      [{ id: SHARED, storedDigest: auditHistoryDigestOf({ ...retained, userId: MAPPED_TARGET } as never) }],
      [retained],
    );
    expect(plan.conflicts).toEqual([SHARED]);
    expect(plan.certifiedActors.size).toBe(0);

    // T36 re-pin, stated reason: this last assertion used to require a RESTORE_CHAIN
    // refusal for a retained row that is absent from the authenticated payload and
    // cannot be certified by the local key. Such a row is not a wildcard — it is
    // never reused, projected or rewritten — it is RETAINED IN PLACE, because the
    // restore cannot touch it at all; the archive freezes its stored bytes. The
    // wildcard prohibition itself is unchanged and pinned right above (the
    // digest-only planner and the planner without an original source row both stay
    // refusals), and a payload-PRESENT row keeps its full proof.
    const unsealedRetained = { ...retained, hash: 'd'.repeat(64) };
    const decision = validateRestoreDestination(
      sourceTables([auditRow('audit-other', COMPANY_ID, null)]),
      destination([unsealedRetained]), COMPANY_ID, true, MAP,
    );
    expect([...decision.auditRetainedInPlace.keys()]).toEqual([SHARED]);
    expect(decision.auditReuse.size).toBe(0);
    expect(decision.auditProjections.size).toBe(0);
    expect(decision.auditActorCertifications.size).toBe(0);
  });

  it('keeps the non-portable replacement contract exactly as strict as before', () => {
    const { source, retained } = realShape();
    // A LOCAL replacement never reuses retained rows: a row it OWNS is replaced,
    // and a row of another tenant is the pre-planner `RESTORE_ID_CONFLICT` with no
    // diagnosis attached. The new portable allowance must not leak here.
    const owned = validateRestoreDestination(
      sourceTables([{ ...source }]), destination([retained]), COMPANY_ID, false, MAP,
    );
    expect(owned.auditReuse.size).toBe(0);
    expect(owned.auditProjections.size).toBe(0);
    expect(owned.auditActorCertifications.size).toBe(0);

    const foreign = { ...retained, companyId: 'company-deleted-before-recovery' };
    expect(refusal(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([foreign]), COMPANY_ID, false, MAP,
    ))).toBe('RESTORE_ID_CONFLICT: AuditLog');
  });
});

/**
 * S19 / S21 / T30 (L66b) — THE SEAL'S ORIGINAL REFERENCES ARE NOT ALWAYS READABLE.
 *
 * An audit seal covers `id | companyId | userId | action | entity | entityId |
 * details | previousHash`. Both REFERENCES are excluded from the seal contract by
 * design, because the database mutates them: `AuditLog.userId` / `.companyId` were
 * `ON DELETE SET NULL` foreign keys, and a retained row may carry a historical
 * LOCAL account id (a previous recovery's mapping target, or local churn).
 *
 * The single reference set T28/T29 proved (the authenticated source event
 * exactly as the backup carries it) is therefore not the only legitimate origin:
 *  - the COMPANY reference may have been erased BEFORE the backup was exported, so
 *    the authenticated source event itself carries `NULL` while its seal names the
 *    company the row belonged to — the authenticated payload's company is the only
 *    remaining description of it;
 *  - the seal of locally sealed history may be computed over the RETAINED row's own
 *    historical actor instead of the source actor.
 *
 * Certification is therefore a BOUNDED candidate verification: {source actor,
 * retained actor} x {source event company, authenticated payload company} — at
 * most four PURE recomputations under this installation's key. A candidate is never
 * applied to a row: acceptance still reuses the retained row BYTE-IDENTICALLY (no
 * insert, no projection, no re-sign), and a reference outside that space (a foreign
 * company, a rotated/foreign key) matches nothing.
 */
describe('bounded seal-reference candidates (S21/T30)', () => {
  /**
   * Case (a): the company reference was erased by the legacy FK BEFORE the backup
   * was created, so the authenticated source event carries `companyId: null` while
   * its stored seal covers the payload company and the original actor.
   */
  function erasedBeforeExport() {
    const sealed = sealedRow({ id: SHARED, userId: SOURCE_ACTOR });
    const source = { ...sealed, companyId: null };
    const retained = { ...source, userId: HISTORICAL_ACTOR };
    return { sealed, source, retained };
  }

  /**
   * Case (b): the stored seal was computed over the RETAINED row's own actor
   * (locally sealed history); the authenticated source event differs only in its
   * actor reference.
   */
  function locallySealedHistory() {
    const retained = sealedRow({ id: SHARED, userId: HISTORICAL_ACTOR });
    const source = { ...retained, userId: SOURCE_ACTOR };
    return { source, retained };
  }

  it('reuses a source event whose company reference was erased BEFORE export', () => {
    const { sealed, source, retained } = erasedBeforeExport();
    const before = JSON.stringify(retained);

    const decision = validateRestoreDestination(
      sourceTables([{ ...source }]), destination([retained]), COMPANY_ID, true, MAP,
    );

    // The sealed content is proven over the PAYLOAD company, so the retained row is
    // the same already-present event: reused as stored, never re-inserted.
    expect([...decision.auditReuse.keys()]).toEqual([SHARED]);
    expect([...decision.auditReuse.values()]).toEqual([auditHistoryDigestOf(retained as never)]);
    expect(decision.auditProjections.size).toBe(0);
    // The verified reference set is recorded: the ORIGINAL actor and the company the
    // seal actually covers (which neither row still carries).
    expect([...decision.auditActorCertifications.entries()])
      .toEqual([[SHARED, { userId: SOURCE_ACTOR, companyId: COMPANY_ID }]]);
    // Byte-identical: nothing rewritten, projected or re-signed.
    expect(JSON.stringify(retained)).toBe(before);
    expect(sealed.hash).toBe(retained.hash);
  });

  it('reuses a retained row whose seal covers its own historical actor', () => {
    const { source, retained } = locallySealedHistory();
    const before = JSON.stringify(retained);

    const decision = validateRestoreDestination(
      sourceTables([{ ...source }]), destination([retained]), COMPANY_ID, true, MAP,
    );

    expect([...decision.auditReuse.keys()]).toEqual([SHARED]);
    expect([...decision.auditReuse.values()]).toEqual([auditHistoryDigestOf(retained as never)]);
    expect(decision.auditProjections.size).toBe(0);
    expect([...decision.auditActorCertifications.entries()])
      .toEqual([[SHARED, { userId: HISTORICAL_ACTOR, companyId: COMPANY_ID }]]);
    expect(JSON.stringify(retained)).toBe(before);
  });

  it('never certifies a seal computed over a company that is neither the event nor the payload company', () => {
    // A hash covering a FOREIGN company id is outside the bounded candidate space:
    // it must stay fail-closed even though the source event carries `null` and the
    // actor matches, because nothing here can describe that reference set.
    const foreign = sealedRow({ id: SHARED, userId: SOURCE_ACTOR, companyId: 'company-never-in-payload' });
    const source = { ...foreign, companyId: null };
    const retained = { ...source, userId: HISTORICAL_ACTOR };

    expect(auditSealReference(
      retained as unknown as AuditHistoryRowLike, source as unknown as AuditHistoryRowLike, COMPANY_ID,
    )).toBeNull();

    const message = refusal(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([retained]), COMPANY_ID, true, MAP,
    ));
    expect(message).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
    expect(message).toContain('mismatch: source-seal');
    // Fixed label only (T30): the seal covers no describable reference set, which is
    // a DIFFERENT stage from a content difference.
    expect(message).toContain('seal-candidates-unverified');
    for (const secret of [
      SHARED, COMPANY_ID, SOURCE_ACTOR, HISTORICAL_ACTOR, MAPPED_TARGET, OWNER.email,
      'company-never-in-payload', String(source.hash),
    ]) {
      expect(message).not.toContain(secret);
    }
  });

  it('bounds the candidate reference sets and collapses the no-ops', () => {
    const { source, retained } = realShape();
    // Source company and payload company coincide here, so the as-is reference
    // (already covered) is not recomputed twice.
    expect(auditSealCandidates(retained as unknown as AuditHistoryRowLike,
      source as unknown as AuditHistoryRowLike, COMPANY_ID)).toEqual([
      { userId: SOURCE_ACTOR, companyId: COMPANY_ID },
      { userId: HISTORICAL_ACTOR, companyId: COMPANY_ID },
    ]);
    // With a distinct payload company the space is exactly the documented four.
    const bounded = auditSealCandidates(retained as unknown as AuditHistoryRowLike,
      source as unknown as AuditHistoryRowLike, 'company-payload-other');
    expect(bounded).toHaveLength(4);
    expect(bounded).toEqual([
      { userId: SOURCE_ACTOR, companyId: COMPANY_ID },
      { userId: SOURCE_ACTOR, companyId: 'company-payload-other' },
      { userId: HISTORICAL_ACTOR, companyId: COMPANY_ID },
      { userId: HISTORICAL_ACTOR, companyId: 'company-payload-other' },
    ]);
  });

  it('keeps the label off a genuine content difference, including with an erased source actor', () => {
    // The new token means "no candidate reference set reproduces the seal", never
    // "the content differs" and never the erased-reference/null-actor shapes.
    const { source, retained } = realShape();
    const contentMessage = refusal(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([{ ...retained, details: 'rewritten' }]),
      COMPANY_ID, true, MAP,
    ));
    expect(contentMessage).toContain('fields: details');
    expect(contentMessage).not.toContain('seal-candidates-unverified');

    // T31 re-pins this half on purpose: an ERASED SOURCE actor alone is now a
    // certified reuse (see the T31 block), so the label-free refusal is pinned on
    // the shape that still fails — that same erased actor PLUS a content change.
    const nullActorSource = sealedRow({ id: SHARED, userId: null });
    const nullActorMessage = refusal(() => validateRestoreDestination(
      sourceTables([{ ...nullActorSource }]),
      destination([{ ...nullActorSource, userId: HISTORICAL_ACTOR, details: 'rewritten' }]),
      COMPANY_ID, true, MAP,
    ));
    expect(nullActorMessage).toContain('fields: details,userId');
    expect(nullActorMessage).not.toContain('seal-candidates-unverified');
  });
});

/**
 * S18 / S21 / T31 (L67) — THE ERASED REFERENCE IS ON THE SOURCE SIDE.
 *
 * The operator's real 23:03 attempt (already running the T29/T30 code) emitted
 * exactly `RESTORE_ID_CONFLICT: AuditLog [mismatch: content; fields: userId]`. Under
 * that code the ONLY shape that reaches that refusal is the MIRROR of the accepted
 * erased-reference projection:
 *  - the AUTHENTICATED source event carries `userId: null`, because the legacy
 *    `ON DELETE SET NULL` foreign key erased the actor BEFORE the backup was
 *    exported, so the stored seal covers the NULL-ACTOR payload;
 *  - the RETAINED row carries a non-null actor — this installation's own, live,
 *    locally certified local account id (the account a previous recovery mapped the
 *    event onto, or a local account with the same email);
 *  - every other canonical field INCLUDING the stored seal, the stored link and the
 *    timestamp is identical.
 *
 * The retained actor is historical LOCAL data the null-actor seal never covered, so
 * the event is still the same already-present event; the bounded seal-candidate
 * proof (T30) verifies the seal under this installation's key and reuse keeps the
 * retained row BYTE-IDENTICAL — no insert, no projection, no re-sign, and the null
 * reference of the source event is never written into retained history.
 *
 * Everything else stays fail-closed: a content difference in either direction, both
 * actors erased with any other difference, a seal no bounded candidate verifies
 * (fixed `seal-candidates-unverified` token), a rotated/foreign key, a live foreign
 * company, and the whole non-portable path.
 */
describe('source event whose actor was erased BEFORE the export (S21/T31)', () => {
  /**
   * The exact real shape: the seal covers the null-actor payload (the backup was
   * exported after the erasure) and the retained row keeps a live local actor.
   */
  function erasedActorBeforeExport() {
    const sealed = sealedRow({ id: SHARED, userId: null });
    const source = { ...sealed };
    const retained = { ...sealed, userId: LIVE_LOCAL_ACTOR };
    return { sealed, source, retained };
  }

  it('reuses the retained live local actor byte-identically instead of refusing userId', () => {
    const { sealed, source, retained } = erasedActorBeforeExport();
    const before = JSON.stringify(retained);

    const decision = validateRestoreDestination(
      sourceTables([{ ...source }]),
      destination([retained], [userRow(LIVE_LOCAL_ACTOR, 'live@example.test')]),
      COMPANY_ID, true, MAP,
    );

    // The same already-present event: reused as stored, never re-inserted.
    expect([...decision.auditReuse.keys()]).toEqual([SHARED]);
    expect([...decision.auditReuse.values()]).toEqual([auditHistoryDigestOf(retained as never)]);
    expect(decision.auditProjections.size).toBe(0);
    // The proven reference set is the SOURCE's: the seal covers the null-actor
    // payload, and the live local actor was never signed. Preservation re-proves
    // exactly these references.
    expect([...decision.auditActorCertifications.entries()])
      .toEqual([[SHARED, { userId: null, companyId: COMPANY_ID }]]);
    // Byte-identical: nothing rewritten, projected, re-signed or re-attributed.
    expect(JSON.stringify(retained)).toBe(before);
    expect(retained.hash).toBe(sealed.hash);
    expect(retained.userId).toBe(LIVE_LOCAL_ACTOR);
  });

  it('admits the mirror difference in the planner and records the verified reference set', () => {
    const { source, retained } = erasedActorBeforeExport();
    const plan = planAuditOverlapWithAttribution(auditOverlapExpectations([source], MAP), [retained]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.mismatches).toEqual([]);
    expect([...plan.reuse.keys()]).toEqual([SHARED]);
    expect([...plan.certifiedActors.entries()])
      .toEqual([[SHARED, { userId: null, companyId: COMPANY_ID }]]);
    // The live actor is retained history, not a projection of anything.
    expect(plan.projections.size).toBe(0);
    // The seal really is the null-actor one: recomputing it over the stored live
    // actor cannot reproduce it, which is why it is proven over the source event.
    expect(computeAuditHash({ ...retained as unknown as Parameters<typeof computeAuditHash>[0] }))
      .not.toBe(retained.hash);
  });

  it('refuses the erased source actor when any other canonical field differs too', () => {
    const { source, retained } = erasedActorBeforeExport();
    const variants: Array<[string, Row]> = [
      ['details', { ...retained, details: 'rewritten before recovery' }],
      ['companyId', { ...retained, companyId: 'company-other' }],
      ['action', { ...retained, action: 'OTHER_ACTION' }],
      ['previousHash', { ...retained, previousHash: 'c'.repeat(64) }],
      ['createdAt', { ...retained, createdAt: '2026-01-05T10:00:00.001Z' }],
      ['hash', { ...retained, hash: 'b'.repeat(64) }],
    ];
    for (const [field, candidate] of variants) {
      const message = refusal(() => validateRestoreDestination(
        sourceTables([{ ...source }]), destination([candidate]), COMPANY_ID, true, MAP,
      ));
      expect(message, field).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
      expect(message, field).toContain(field);
      for (const secret of [
        SHARED, COMPANY_ID, SOURCE_ACTOR, MAPPED_TARGET, LIVE_LOCAL_ACTOR, OWNER.email,
        'company-other', String(source.hash), 'b'.repeat(64), 'rewritten before recovery',
      ]) {
        expect(message, field).not.toContain(secret);
      }
    }
  });

  it('refuses BOTH actors erased when any other canonical field differs', () => {
    // No actor on either side and something else changed: nothing describes the
    // event as this row, so it stays a content conflict (never a wildcard).
    const { sealed } = erasedActorBeforeExport();
    const message = refusal(() => validateRestoreDestination(
      sourceTables([{ ...sealed }]),
      destination([{ ...sealed, details: 'rewritten before recovery' }]), COMPANY_ID, true, MAP,
    ));
    expect(message).toContain('fields: details');
    expect(message).not.toContain('userId');
    expect(message).not.toContain('seal-candidates-unverified');
  });

  it('refuses when no bounded candidate reproduces the seal, keeping the fixed token', () => {
    // A seal computed with a foreign installation key over the null-actor payload:
    // the bounded candidates ({null, retained} x {source company, payload company})
    // all fail, so the event cannot be proven and nothing is reused.
    const content = {
      id: SHARED, companyId: COMPANY_ID, userId: null, action: 'JOURNAL_POSTED',
      entity: 'JournalEntry', entityId: 'entry-1', details: null, previousHash: null,
    };
    const foreignHash = crypto.createHmac('sha256', 'foreign-installation-key-not-this-one')
      .update([
        content.id, content.companyId, '', content.action, content.entity,
        content.entityId, '', '',
      ].join('|'))
      .digest('hex');
    const source = { ...content, createdAt: '2026-01-05T10:00:00.000Z', hash: foreignHash };
    const retained = { ...source, userId: LIVE_LOCAL_ACTOR };

    const message = refusal(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([retained]), COMPANY_ID, true, MAP,
    ));
    expect(message).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
    expect(message).toContain('mismatch: source-seal');
    expect(message).toContain('seal-candidates-unverified');
    for (const secret of [
      SHARED, COMPANY_ID, LIVE_LOCAL_ACTOR, OWNER.email, foreignHash,
    ]) {
      expect(message).not.toContain(secret);
    }
  });

  it('keeps the non-portable replacement path closed for this shape', () => {
    // A LOCAL replacement replaces the owned row and never reuses retained rows, so
    // the portable allowance must not leak here whatever the seals say.
    const { source, retained } = erasedActorBeforeExport();
    const decision = validateRestoreDestination(
      sourceTables([{ ...source }]),
      destination([retained], [userRow(LIVE_LOCAL_ACTOR, 'live@example.test')]),
      COMPANY_ID, false, MAP,
    );
    expect(decision.auditReuse.size).toBe(0);
    expect(decision.auditProjections.size).toBe(0);
    expect(decision.auditActorCertifications.size).toBe(0);
  });
});

/**
 * S2 / S18 / S21 / T34 (L72) — NEITHER COPY OF THE EVENT CARRIES A SEAL.
 *
 * The operator's real installation still refuses completion with
 *   `RESTORE_ID_CONFLICT: AuditLog [mismatch: content; fields: userId]`
 * and the trace proved the ONLY reachable emitter is the `source.hash === null`
 * branch of `attestRetainedAttribution`: the conflicting events are the HASH-LESS
 * audit rows (unsealed legacy rows the export copies verbatim), and their only
 * canonical difference is the actor reference a legacy `ON DELETE SET NULL` erased
 * on THIS side (retained `userId: null`, source live). Every SEALED same-id row
 * already passes the bounded seal proof and is reused.
 *
 * With no seal on either side there is nothing to recompute, so the canonical
 * comparison is the whole proof: the retained row is reused BYTE-IDENTICALLY, the
 * source's live reference is only RECORDED (projection, never written), and
 * certification of the retained bytes is carried by the destination preservation
 * proof plus the provenance archive digest — which fail closed if those bytes
 * drift. The seal ABSENCE stays explicit: an HMAC re-proof refuses a seal-less row,
 * so any consumer that needs a seal cannot inherit this acceptance.
 *
 * Fail-closed edges pinned below: a seal on ONE side only (hash presence is a real
 * content difference), the REVERSED direction (retained live, source erased), and
 * any other canonical field difference.
 */
describe('hash-less retained event whose actor reference was erased (S2/S21/T34)', () => {
  /**
   * The measured real shape: no seal on EITHER side, the retained row's actor
   * reference erased, everything else (content, link, timestamp) identical.
   */
  function hashlessPair(overrides: { source?: Row; retained?: Row } = {}) {
    const content = {
      id: SHARED, companyId: COMPANY_ID, userId: SOURCE_ACTOR, action: 'JOURNAL_POSTED',
      entity: 'JournalEntry', entityId: 'entry-1', details: null, previousHash: null,
    };
    const source = { ...content, createdAt: '2026-01-05T10:00:00.000Z', hash: null, ...overrides.source };
    const retained = { ...source, userId: null, ...overrides.retained };
    return { source, retained };
  }

  it('reuses the retained row byte-identically instead of refusing the erased actor', () => {
    const { source, retained } = hashlessPair();
    const before = JSON.stringify(retained);

    const decision = validateRestoreDestination(
      sourceTables([{ ...source }]), destination([retained]), COMPANY_ID, true, MAP,
    );

    // The same already-present event: reused as stored, never re-inserted.
    expect([...decision.auditReuse.keys()]).toEqual([SHARED]);
    expect([...decision.auditReuse.values()]).toEqual([auditHistoryDigestOf(retained as never)]);
    // The source's LIVE reference is recorded so the archive can freeze it next to
    // the stored bytes — and it is never written into retained history.
    expect([...decision.auditProjections.entries()]).toEqual([[SHARED, { userId: SOURCE_ACTOR }]]);
    // No seal exists on either side, so nothing is certified as an HMAC.
    expect(decision.auditActorCertifications.size).toBe(0);
    // Byte-identical: the validator certifies, it never edits history.
    expect(JSON.stringify(retained)).toBe(before);
    expect(retained.hash).toBeNull();
  });

  it('admits the erased-reference difference in the planner and records the projection', () => {
    const { source, retained } = hashlessPair();
    const plan = planAuditOverlapWithAttribution(
      auditOverlapExpectations([source], MAP), [retained], { payloadCompanyId: COMPANY_ID },
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.mismatches).toEqual([]);
    expect([...plan.reuse.keys()]).toEqual([SHARED]);
    expect([...plan.projections.entries()]).toEqual([[SHARED, { userId: SOURCE_ACTOR }]]);
    expect(plan.certifiedActors.size).toBe(0);
    // The attribution proof itself returns the projection, never a content
    // mismatch — the operator's exact refusal is gone from this branch.
    expect(attestRetainedAttribution(
      retained as unknown as AuditHistoryRowLike,
      source as unknown as AuditHistoryRowLike,
      { payloadCompanyId: COMPANY_ID },
    )).toEqual({ projection: { userId: SOURCE_ACTOR } });
  });

  it('keeps the seal ABSENCE explicit: no HMAC proof is manufactured for it', () => {
    const { source, retained } = hashlessPair();
    const row = retained as unknown as AuditHistoryRowLike;
    // Every consumer that REQUIRES a seal refuses a seal-less row: the acceptance
    // above is carried by the canonical comparison and the stored-bytes digest, not
    // by an invented signature.
    expect(retainedAttributionHolds(row, { userId: SOURCE_ACTOR })).toBe(false);
    expect(retainedAttributionHolds(row, SOURCE_ACTOR)).toBe(false);
    expect(retainedActorSealHolds(row, source as unknown as AuditHistoryRowLike)).toBe(false);
    expect(auditSealReference(row, source as unknown as AuditHistoryRowLike, COMPANY_ID)).toBeNull();
  });

  it('refuses a seal on ONE side only (hash presence is a real content difference)', () => {
    const sealed = sealedRow({ id: SHARED, userId: SOURCE_ACTOR });

    // A hash-less source event against a HASHED retained row — here with the actor
    // reference erased too, so BOTH the seal presence and the actor differ.
    const { source } = hashlessPair();
    const hashedRetained = refusal(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([{ ...sealed, userId: null }]), COMPANY_ID, true, MAP,
    ));
    expect(hashedRetained).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
    expect(hashedRetained).toContain('fields: hash,userId');

    // A HASHED source event against a hash-less retained row (the reverse).
    const hashlessRetained = { ...sealed, hash: null, userId: null };
    const hashedSource = refusal(() => validateRestoreDestination(
      sourceTables([{ ...sealed }]), destination([hashlessRetained]), COMPANY_ID, true, MAP,
    ));
    expect(hashedSource).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
    expect(hashedSource).toContain('fields: hash');
  });

  it('refuses any OTHER canonical difference between two hash-less copies', () => {
    const { source, retained } = hashlessPair();
    const variants: Array<[string, Row]> = [
      ['details', { ...retained, details: 'rewritten before recovery' }],
      ['action', { ...retained, action: 'OTHER_ACTION' }],
      ['entity', { ...retained, entity: 'OtherEntity' }],
      ['entityId', { ...retained, entityId: 'entry-2' }],
      ['createdAt', { ...retained, createdAt: '2026-01-05T10:00:00.001Z' }],
      ['previousHash', { ...retained, previousHash: 'c'.repeat(64) }],
      ['companyId', { ...retained, companyId: 'company-other' }],
    ];
    for (const [field, candidate] of variants) {
      const message = refusal(() => validateRestoreDestination(
        sourceTables([{ ...source }]), destination([candidate]), COMPANY_ID, true, MAP,
      ));
      expect(message, field).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
      expect(message, field).toContain(field);
      // Never a value: no id, actor id, company id, email, content or link.
      for (const secret of [
        SHARED, COMPANY_ID, SOURCE_ACTOR, MAPPED_TARGET, HISTORICAL_ACTOR, OWNER.email,
        'company-other', 'c'.repeat(64), 'rewritten before recovery',
      ]) {
        expect(message, field).not.toContain(secret);
      }
    }
  });

  it('refuses the REVERSED direction: a live retained actor with an erased source one', () => {
    // Both sides hash-less, but the erased reference is on the SOURCE side. The
    // documented direction (retained NULL, source live) is what this acceptance
    // covers; the mirror without any seal describes an event this installation
    // cannot show it already holds, so it keeps the operator's original refusal.
    const { source } = hashlessPair({ source: { userId: null } });
    const retained = { ...source, userId: HISTORICAL_ACTOR };
    const message = refusal(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([retained]), COMPANY_ID, true, MAP,
    ));
    expect(message).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
    expect(message).toContain('fields: userId');
    for (const secret of [SHARED, COMPANY_ID, HISTORICAL_ACTOR, OWNER.email]) {
      expect(message).not.toContain(secret);
    }
  });

  it('keeps the non-portable replacement path closed for this shape', () => {
    const { source, retained } = hashlessPair();
    const decision = validateRestoreDestination(
      sourceTables([{ ...source }]), destination([retained]), COMPANY_ID, false, MAP,
    );
    expect(decision.auditReuse.size).toBe(0);
    expect(decision.auditProjections.size).toBe(0);
    expect(decision.auditActorCertifications.size).toBe(0);
  });

  it('reconciles an archived seal-less row with the destination (fail-closed)', () => {
    const { source, retained } = hashlessPair();
    const admit = (auditArchive: RecoveryArchive) => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([retained]), COMPANY_ID, true, MAP, { auditArchive },
    );
    // An archive that records the SAME absence is consistent with the stored bytes.
    expect([...admit(new Map([[SHARED, {
      digest: auditHistoryDigestOf(retained as never), sealLess: true,
    }]])).auditReuse.keys()]).toEqual([SHARED]);

    // A row archived WITH a seal whose hash has disappeared is a defect: the absence
    // must be the one the archive recorded, never an inferred one.
    expect(refusal(() => admit(new Map([[SHARED, { digest: auditHistoryDigestOf(retained as never) }]]))))
      .toContain('RESTORE_CHAIN');
    // And drifting the archived bytes still fails, seal or no seal.
    expect(refusal(() => admit(new Map([[SHARED, { digest: 'f'.repeat(64), sealLess: true }]]))))
      .toContain('RESTORE_CHAIN');
  });

  it('carries the certification as the stored-bytes digest and fails closed on drift', () => {
    // The acceptance carries no seal, so its certification IS the digest of the
    // bytes this installation stores: the archive freezes them together with the
    // erased reference, and BOTH durable proofs must refuse a row that moved after
    // admission instead of certifying bytes they can no longer read back.
    const { source, retained } = hashlessPair();
    const plan = planAuditOverlapWithAttribution(
      auditOverlapExpectations([source], MAP), [retained], { payloadCompanyId: COMPANY_ID },
    );
    const provenance = buildRecoveryProvenance({
      snapshot: makeSnapshot({ auditLogs: [{ ...source }] }),
      ownerUserId: OWNER.id,
      ownerEmail: OWNER.email,
      fileDigest: 'a'.repeat(64),
      payloadDigest: 'b'.repeat(64),
      identityMap: MAP,
      restoredAt: '2026-06-01T08:00:00.000Z',
      auditRows: [{ ...source, userId: MAPPED_TARGET }],
      reusedAuditEvidence: plan.reuse,
      auditProjections: plan.projections,
    });
    expect(provenance.auditEvidence).toEqual([
      {
        id: SHARED,
        digest: auditHistoryDigestOf(retained as never),
        projectedUserId: SOURCE_ACTOR,
        sealLess: true,
      },
    ]);

    const drifted = [{ ...retained, details: 'rewritten after admission' }];
    expect(() => assertStoredEvidence(drifted, provenance.auditEvidence))
      .toThrow(/RECOVERY_HISTORY_LOST/);
    expect(() => assertDestinationAuditPreserved(
      [auditEvidenceOf([retained])[0]], drifted,
    )).toThrow(/RECOVERY_DESTINATION_AUDIT_LOST/);
  });
});

/**
 * End-to-end through the REAL workflow (`requestPortableRecoveryChallenge` →
 * `completePortableRecovery` → `createPortableDestinationRestore`) over the REAL
 * admission decision. Pinned: ONE copy of the event after the recovery, the
 * retained row BYTE-IDENTICAL, and evidence recorded over the STORED digest — with
 * no invented attribution label when nothing was projected, and with the proven
 * erased reference (T34) when the seal-less shape needed one.
 */
const NOW = new Date('2026-06-01T08:00:00.000Z');
const RECEIPT_ID = 'op-recovery-committed';
const hashPassword = async (password: string) => `synthetic-hash:${password}`;
const verifyPassword = async (password: string, hash: string) => hash === `synthetic-hash:${password}`;

function flow(snapshot: BackupData, seed: Parameters<typeof fakeClient>[0]) {
  const { client, state } = fakeClient(seed);
  const provenance = fakeProvenance();
  const mail: Array<{ token: string }> = [];
  const restoreCalls: Array<{ identityMap: Record<string, string> }> = [];

  const tablesOf = (): Tables => {
    const tables = emptyTables();
    tables.Company = state.companies.map((row) => ({ entityType: 'BUSINESS', taxId: null, ...row }));
    tables.User = state.users.map((row) => ({ ...row }));
    tables.CompanyMember = state.members.map((row) => ({ ...row }));
    tables.AuditLog = state.audits.map((row) => ({ ...row }));
    return tables;
  };

  const restore = createPortableDestinationRestore({
    client: client as unknown as Parameters<typeof createPortableDestinationRestore>[0]['client'],
    provenance: provenance.recorder,
    now: () => NOW,
    hashPassword,
    verifyPassword,
    coordinatedRestore: async (companyId, text, settings, identityMap) => {
      restoreCalls.push({ identityMap });
      const parsed = JSON.parse(text) as BackupData;
      // The REAL admission decision, exactly as the production coordinator runs it.
      const decision = validateRestoreDestination(
        (() => {
          const tables = emptyTables();
          tables.Company = (parsed.data.company ?? []) as Row[];
          tables.User = (parsed.data.users ?? []) as Row[];
          tables.CompanyMember = (parsed.data.companyMembers ?? []) as Row[];
          tables.AuditLog = ((parsed.data.auditLogs ?? []) as Row[]).map((row) => ({ ...row }));
          return tables;
        })(),
        tablesOf(), companyId, true, identityMap,
        settings.auditArchive ? { auditArchive: settings.auditArchive } : {},
      );
      const map = (rows: Row[]) => rows.map((row) => {
        const mapped = typeof row.userId === 'string' ? identityMap[row.userId] : undefined;
        return mapped && mapped !== row.userId ? { ...row, userId: mapped } : { ...row };
      });
      state.companies = [{ id: companyId, legalName: parsed.manifest.companyInfo.legalName }];
      state.members = map((parsed.data.companyMembers ?? []) as Row[]);
      state.audits = [
        ...state.audits,
        // The PRODUCTION skip: a retained row already IS this event.
        ...map(((parsed.data.auditLogs ?? []) as Row[]))
          .filter((row) => !decision.auditReuse.has(String(row.id))),
        {
          id: RECEIPT_ID, companyId, userId: null, action: 'COMPANY_RESTORE_COMMITTED',
          entity: 'Backup', entityId: null, details: null, hash: null,
          previousHash: null, createdAt: NOW.toISOString(),
        },
      ];
      return { status: 'committed' as const, operationId: RECEIPT_ID, counts: parsed.manifest.recordCounts };
    },
  });

  const deps: PortableRecoveryDeps = {
    now: () => NOW,
    challenges: createMemoryRecoveryChallengeStore(),
    lock: createMemoryRecoveryLockStore(),
    mail: { send: async (message) => { mail.push(message as unknown as { token: string }); } },
    installationState: async () => ({ companies: state.companies.length, audits: state.audits.length }),
    restore,
  };
  return { deps, state, provenance, mail, restoreCalls };
}

async function recover(deps: PortableRecoveryDeps, text: string, mail: Array<{ token: string }>) {
  const requested = await requestPortableRecoveryChallenge(deps, {
    fileText: text,
    password: SOURCE_PASSWORD,
    companyLegalName: COMPANY_LEGAL_NAME,
    ownerEmail: OWNER.email,
  });
  expect(requested.status, JSON.stringify(requested)).toBe('challenge_sent');
  return completePortableRecovery(deps, {
    fileText: text,
    password: SOURCE_PASSWORD,
    companyLegalName: COMPANY_LEGAL_NAME,
    ownerEmail: OWNER.email,
    token: mail.at(-1)!.token,
  });
}

describe('the recovered installation holds ONE copy of the event (T28)', () => {
  it('keeps the retained row byte-identical, inserts no duplicate and records no projection', async () => {
    const source = sealedRow({ id: SHARED, userId: SOURCE_ACTOR });
    const retained = { ...source, userId: HISTORICAL_ACTOR };
    const snapshot = makeSnapshot({ auditLogs: [{ ...source }] });
    const f = flow(snapshot, {
      users: [
        { ...userRow(MAPPED_TARGET, OWNER.email), passwordHash: `synthetic-hash:${SOURCE_PASSWORD}` },
        { ...userRow(HISTORICAL_ACTOR, 'history@example.test'), passwordHash: 'synthetic-hash:other' },
      ],
      audits: [{ ...retained }],
    });
    const before = JSON.stringify(f.state.audits);

    const result = await recover(f.deps, portableFile(snapshot), f.mail);
    expect(result.status, JSON.stringify(result)).toBe('restored');

    // The proven identity mapping is the current target, and it never rewrote the
    // retained evidence.
    expect(f.restoreCalls[0].identityMap).toEqual({ [SOURCE_ACTOR]: MAPPED_TARGET });
    // The retained evidence is untouched; the ONE added row is the commit receipt.
    expect(f.state.audits.map((row) => String(row.id))).toEqual([SHARED, RECEIPT_ID]);
    const copies = f.state.audits.filter((row) => String(row.id) === SHARED);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toEqual(retained);
    expect(JSON.stringify(copies[0])).toBe(JSON.stringify(JSON.parse(before)[0]));
    expect(copies[0].userId).toBe(HISTORICAL_ACTOR);

    // Evidence describes the row AS STORED, with no fabricated attribution label.
    const record = f.provenance.records[0] as {
      auditEvidence: Array<{ id: string; digest: string; projectedUserId?: string }>;
    };
    expect(record.auditEvidence).toEqual([
      { id: SHARED, digest: auditHistoryDigestOf(retained as never) },
    ]);
  });

  it('reuses it when the legacy company FK erased the company reference too (L62/L65 retry)', async () => {
    // The exact real retry: the earlier recovery stored the event under its LOCAL
    // mapping target and the company was then deleted while
    // `AuditLog_companyId_fkey` was still ON DELETE SET NULL, so the retained row is
    // ALSO unowned. Its seal is the ORIGINAL source one, and the second recovery must
    // still finish byte-identically instead of reporting
    // `[mismatch: content; fields: userId]`.
    const source = sealedRow({ id: SHARED, userId: SOURCE_ACTOR });
    const retained = { ...source, userId: HISTORICAL_ACTOR, companyId: null };
    const snapshot = makeSnapshot({ auditLogs: [{ ...source }] });
    const f = flow(snapshot, {
      users: [
        { ...userRow(MAPPED_TARGET, OWNER.email), passwordHash: `synthetic-hash:${SOURCE_PASSWORD}` },
        { ...userRow(HISTORICAL_ACTOR, 'history@example.test'), passwordHash: 'synthetic-hash:other' },
      ],
      audits: [{ ...retained }],
    });
    const before = JSON.stringify(f.state.audits);

    const result = await recover(f.deps, portableFile(snapshot), f.mail);
    expect(result.status, JSON.stringify(result)).toBe('restored');
    expect(f.restoreCalls[0].identityMap).toEqual({ [SOURCE_ACTOR]: MAPPED_TARGET });

    // ONE copy of the event, byte-identical: nothing re-inserted, re-signed or
    // relabelled.
    expect(f.state.audits.map((row) => String(row.id))).toEqual([SHARED, RECEIPT_ID]);
    const copies = f.state.audits.filter((row) => String(row.id) === SHARED);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toEqual(retained);
    expect(JSON.stringify(copies[0])).toBe(JSON.stringify(JSON.parse(before)[0]));
    expect(copies[0].companyId).toBeNull();
    expect(copies[0].hash).toBe(source.hash);

    const record = f.provenance.records[0] as {
      auditEvidence: Array<{ id: string; digest: string; projectedCompanyId?: string }>;
    };
    expect(record.auditEvidence).toEqual([
      { id: SHARED, digest: auditHistoryDigestOf(retained as never) },
    ]);
  });

  it('finishes when the BACKUP carries an erased company reference (T30)', async () => {
    // T30: the company reference was erased by the legacy FK BEFORE the backup was
    // exported, so the authenticated source event carries `companyId: null` while its
    // seal covers the payload company. Admission and the POST-COMMIT re-proof must
    // agree on the same bounded reference set, otherwise the operator's shape turns
    // into a post-commit RECOVERY_HISTORY_CONFLICT / RECOVERY_HISTORY_LOST.
    const sealed = sealedRow({ id: SHARED, userId: SOURCE_ACTOR });
    const source = { ...sealed, companyId: null };
    const retained = { ...source, userId: HISTORICAL_ACTOR };
    const snapshot = makeSnapshot({ auditLogs: [{ ...source }] });
    const f = flow(snapshot, {
      users: [
        { ...userRow(MAPPED_TARGET, OWNER.email), passwordHash: `synthetic-hash:${SOURCE_PASSWORD}` },
        { ...userRow(HISTORICAL_ACTOR, 'history@example.test'), passwordHash: 'synthetic-hash:other' },
      ],
      audits: [{ ...retained }],
    });
    const before = JSON.stringify(f.state.audits);

    const result = await recover(f.deps, portableFile(snapshot), f.mail);
    expect(result.status, JSON.stringify(result)).toBe('restored');
    expect(f.restoreCalls[0].identityMap).toEqual({ [SOURCE_ACTOR]: MAPPED_TARGET });

    // ONE copy of the event, byte-identical.
    expect(f.state.audits.map((row) => String(row.id))).toEqual([SHARED, RECEIPT_ID]);
    const copies = f.state.audits.filter((row) => String(row.id) === SHARED);
    expect(copies).toHaveLength(1);
    expect(JSON.stringify(copies[0])).toBe(JSON.stringify(JSON.parse(before)[0]));
    expect(copies[0].companyId).toBeNull();
    expect(copies[0].hash).toBe(sealed.hash);

    // The post-commit evidence still describes the row AS STORED, with no invented
    // attribution label (nothing was projected).
    const record = f.provenance.records[0] as {
      auditEvidence: Array<{ id: string; digest: string; projectedCompanyId?: string }>;
    };
    expect(record.auditEvidence).toEqual([
      { id: SHARED, digest: auditHistoryDigestOf(retained as never) },
    ]);
  });

  it('finishes when BOTH copies of the event are hash-less (T34)', async () => {
    // T34 end to end: admission AND the post-commit re-proof must agree, so the
    // recovery completes with the hash-less retained row kept byte-identically, the
    // source's live reference never written into history, and the archive recording
    // the STORED bytes together with the erased reference it was proven against.
    const content = {
      id: SHARED, companyId: COMPANY_ID, userId: SOURCE_ACTOR, action: 'JOURNAL_POSTED',
      entity: 'JournalEntry', entityId: 'entry-1', details: null, previousHash: null,
    };
    const source = { ...content, createdAt: '2026-01-05T10:00:00.000Z', hash: null };
    const retained = { ...source, userId: null };
    const snapshot = makeSnapshot({ auditLogs: [{ ...source }] });
    const f = flow(snapshot, {
      users: [
        { ...userRow(MAPPED_TARGET, OWNER.email), passwordHash: `synthetic-hash:${SOURCE_PASSWORD}` },
      ],
      audits: [{ ...retained }],
    });
    const before = JSON.stringify(f.state.audits);

    const result = await recover(f.deps, portableFile(snapshot), f.mail);
    expect(result.status, JSON.stringify(result)).toBe('restored');
    expect(f.restoreCalls[0].identityMap).toEqual({ [SOURCE_ACTOR]: MAPPED_TARGET });

    // ONE copy of the event, byte-identical: nothing re-inserted, rewritten or
    // re-signed, and the erased column stays erased.
    expect(f.state.audits.map((row) => String(row.id))).toEqual([SHARED, RECEIPT_ID]);
    const copies = f.state.audits.filter((row) => String(row.id) === SHARED);
    expect(copies).toHaveLength(1);
    expect(JSON.stringify(copies[0])).toBe(JSON.stringify(JSON.parse(before)[0]));
    expect(copies[0].userId).toBeNull();
    expect(copies[0].hash).toBeNull();

    // The archive freezes the STORED bytes and records the erased reference it was
    // proven against — with no fabricated seal.
    const record = f.provenance.records[0] as {
      auditEvidence: Array<{ id: string; digest: string; projectedUserId?: string }>;
    };
    expect(record.auditEvidence).toEqual([
      {
        id: SHARED,
        digest: auditHistoryDigestOf(retained as never),
        projectedUserId: SOURCE_ACTOR,
        sealLess: true,
      },
    ]);
  });

  it('finishes when the BACKUP carries an erased ACTOR reference (T31)', async () => {
    // T31 mirror shape end to end: admission AND the post-commit re-proof must
    // agree, so the recovery completes with the retained live local actor kept
    // byte-identically, the null source reference never written into history, and
    // no fabricated attribution in the evidence.
    const sealed = sealedRow({ id: SHARED, userId: null });
    const source = { ...sealed };
    const retained = { ...sealed, userId: LIVE_LOCAL_ACTOR };
    const snapshot = makeSnapshot({ auditLogs: [{ ...source }] });
    const f = flow(snapshot, {
      users: [
        { ...userRow(MAPPED_TARGET, OWNER.email), passwordHash: `synthetic-hash:${SOURCE_PASSWORD}` },
        { ...userRow(LIVE_LOCAL_ACTOR, 'live@example.test'), passwordHash: 'synthetic-hash:live' },
      ],
      audits: [{ ...retained }],
    });
    const before = JSON.stringify(f.state.audits);

    const result = await recover(f.deps, portableFile(snapshot), f.mail);
    expect(result.status, JSON.stringify(result)).toBe('restored');
    expect(f.restoreCalls[0].identityMap).toEqual({ [SOURCE_ACTOR]: MAPPED_TARGET });

    // ONE copy of the event, byte-identical: the live local actor is retained
    // history and the source's null reference is never written into it.
    expect(f.state.audits.map((row) => String(row.id))).toEqual([SHARED, RECEIPT_ID]);
    const copies = f.state.audits.filter((row) => String(row.id) === SHARED);
    expect(copies).toHaveLength(1);
    expect(JSON.stringify(copies[0])).toBe(JSON.stringify(JSON.parse(before)[0]));
    expect(copies[0].userId).toBe(LIVE_LOCAL_ACTOR);
    expect(copies[0].hash).toBe(sealed.hash);

    const record = f.provenance.records[0] as {
      auditEvidence: Array<{ id: string; digest: string; projectedUserId?: string }>;
    };
    expect(record.auditEvidence).toEqual([
      { id: SHARED, digest: auditHistoryDigestOf(retained as never) },
    ]);
  });
});
