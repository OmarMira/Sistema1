/**
 * T15 — retained destination audit history must survive a portable recovery.
 *
 * The reported incident leaves an installation with ZERO companies but retained
 * audit rows. Restoring into it must:
 *  - keep every retained row byte-identical (no delete, no re-sign);
 *  - still certify it: a retained row must verify under the LOCAL key or match
 *    the authenticated recovery archive, never be exempted;
 *  - refuse an id collision instead of duplicating history;
 *  - keep the local (non-portable) merge contract exactly as strict as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  RESTORE_MODELS, validateRestoreDestination, type Row, type Tables,
} from '@/lib/backup-validation';
import {
  archiveOutsidePayloadOf, auditHistoryDigest, auditHistoryDigestOf, computeAuditHash,
  partitionAuditLineages, retainedAttributionHolds, verifyAuditChain,
} from '@/lib/journal-hash';
import { buildRecoveryProvenance } from '@/lib/backup-recovery-provenance';
import { COMPANY_ID, OWNER, auditRow, makeSnapshot, userRow } from './helpers';

/**
 * T36 — the AuditLog read the two chain verifiers perform, projected exactly like
 * Prisma (`select` returns only the named columns) plus the provenance archive
 * query. No ambient database: every row below is fictional.
 */
const chainState = vi.hoisted(() => ({
  audits: [] as Array<Record<string, unknown>>,
  provenance: [] as Array<{ provenance: unknown }>,
}));

vi.mock('@/lib/db', () => ({
  db: {
    auditLog: {
      findMany: async (query?: { select?: Record<string, unknown> }) =>
        chainState.audits.map((row) => {
          if (!query?.select) return { ...row };
          const projected: Record<string, unknown> = {};
          for (const key of Object.keys(query.select)) if (key in row) projected[key] = row[key];
          return projected;
        }),
    },
    $queryRawUnsafe: async () => chainState.provenance,
  },
}));

const DELETED_COMPANY = 'company-deleted-before-recovery';

function emptyTables(): Tables {
  return Object.fromEntries(Object.values(RESTORE_MODELS).map((model) => [model, [] as Row[]]));
}

/** Destination read-set: the shell company/user plus whatever history survived. */
function destination(audits: Row[], extra: Partial<Tables> = {}): Tables {
  const tables = emptyTables();
  tables.Company = [{
    id: COMPANY_ID, legalName: 'Compania Origen S.A.', entityType: 'BUSINESS', taxId: null,
    createdAt: '2026-01-05T10:00:00.000Z', updatedAt: '2026-01-05T10:00:00.000Z',
  }];
  tables.User = [userRow(OWNER.id, OWNER.email)];
  tables.AuditLog = audits;
  for (const [model, rows] of Object.entries(extra)) tables[model] = rows as Row[];
  return tables;
}

function sourceTables(audits: Row[]): Tables {
  const tables = emptyTables();
  tables.Company = [{ id: COMPANY_ID, legalName: 'Compania Origen S.A.' }];
  tables.User = [userRow(OWNER.id, OWNER.email)];
  tables.AuditLog = audits;
  return tables;
}

describe('retained destination audit history', () => {
  it('is preserved and certified by the local key without re-signing', () => {
    const retained = [auditRow('retained-1', DELETED_COMPANY, null)];
    retained.push(auditRow('retained-2', DELETED_COMPANY, retained[0].hash as string));
    const source = [auditRow('src-1', COMPANY_ID, null)];
    const before = JSON.stringify(retained);

    expect(() => validateRestoreDestination(
      sourceTables(source), destination(retained.map((row) => ({ ...row }))), COMPANY_ID, true,
    )).not.toThrow();
    // The validator never rewrites what it certifies.
    expect(JSON.stringify(retained)).toBe(before);
  });

  it('freezes a payload-absent row in place instead of recomputing it (T36 re-pin)', () => {
    // T36 re-pin, stated reason: this expectation used to be "a retained row that
    // matches neither the local key nor the archive is refused". That is exactly the
    // row a real installation holds (its seal covers references destroyed AFTER the
    // backup was exported, so NO recomputation can ever reproduce it) and refusing it
    // blocked every recovery of the reported installation. The restore never touches
    // such a row, so it is RETAINED IN PLACE and frozen by the archive instead.
    const genuine = auditRow('retained-1', DELETED_COMPANY, null);
    const tampered = { ...genuine, details: 'rewritten later' };
    const decision = validateRestoreDestination(
      sourceTables([auditRow('src-1', COMPANY_ID, null)]), destination([tampered]), COMPANY_ID, true,
    );
    expect([...decision.auditRetainedInPlace.keys()]).toEqual(['retained-1']);
    expect(decision.auditRetainedInPlace.get('retained-1'))
      .toBe(auditHistoryDigestOf(tampered as never));

    // The local-key requirement did NOT move for a row the payload DOES carry: the
    // same stored row refused above is still refused when the backup carries that id.
    expect(() => validateRestoreDestination(
      sourceTables([genuine]), destination([tampered]), COMPANY_ID, true,
    )).toThrow(/RESTORE_ID_CONFLICT/);
  });

  it('accepts a retained row certified by the authenticated recovery archive', () => {
    const archived = { ...auditRow('retained-1', DELETED_COMPANY, null), hash: 'a'.repeat(64) };
    const archive = new Map([[archived.id, auditHistoryDigest(archived as never)]]);
    expect(() => validateRestoreDestination(
      sourceTables([auditRow('src-1', COMPANY_ID, null)]), destination([archived]), COMPANY_ID, true, {},
      { auditArchive: archive },
    )).not.toThrow();
    // T36 re-pin, stated reason: the row is payload-ABSENT (no backup event carries
    // this id), so the restore never touches it and it is retained in place; the
    // archive is what freezes it post-commit. It used to be refused here, which is
    // exactly the refusal the reported installation could never get past. The
    // archive branch above is still the one that CERTIFIES an id the payload shares.
    expect(() => validateRestoreDestination(
      sourceTables([auditRow('src-1', COMPANY_ID, null)]), destination([archived]), COMPANY_ID, true,
    )).not.toThrow();
  });

  it('refuses an id collision with retained history instead of duplicating a row', () => {
    const retained = auditRow('audit-shared', COMPANY_ID, null);
    const colliding = { ...auditRow('audit-shared', COMPANY_ID, null), action: 'OTHER_ACTION' };
    expect(() => validateRestoreDestination(
      sourceTables([colliding]), destination([retained]), COMPANY_ID, true,
    )).toThrow(/RESTORE_ID_CONFLICT/);
  });

  it('keeps two certified lineages acceptable only in portable mode', () => {
    const retained = [auditRow('retained-1', DELETED_COMPANY, null)];
    const source = [auditRow('src-1', COMPANY_ID, null)];
    const lineages = partitionAuditLineages([
      ...retained.map((row) => ({ ...row })),
      ...source.map((row) => ({ ...row })),
    ]);
    expect(lineages.reasonCode).toBeUndefined();
    expect(lineages.lineages).toHaveLength(2);
  });

  it('still requires the strict installation-wide merge for a local replacement', () => {
    // Non-portable mode must not inherit the retained-audit allowance.
    const retained = auditRow('retained-1', DELETED_COMPANY, null);
    expect(() => validateRestoreDestination(
      sourceTables([auditRow('src-1', COMPANY_ID, null)]), destination([retained]), COMPANY_ID, false,
    )).toThrow(/RESTORE_CHAIN/);
  });
});

/** An audit row whose stored HMAC matches its own content under `userId`. */
function ownedAuditRow(id: string, userId: string, previousHash: string | null = null): Row {
  const content = {
    id, companyId: COMPANY_ID, userId, action: 'JOURNAL_POSTED', entity: 'JournalEntry',
    entityId: 'entry-1', details: null, previousHash,
  };
  return { ...content, createdAt: '2026-01-05T10:00:00.000Z', hash: computeAuditHash(content) };
}

/**
 * T17 / S16 — same-installation recovery. The destination can already hold the
 * VERY events the authenticated snapshot carries (a company was deleted and its
 * audit rows outlive it). Those rows must be REUSED (one copy per event), while a
 * same-id row with different canonical content stays a collision.
 */
describe('same-installation overlap with the authenticated source events', () => {
  it('reuses an identical retained row instead of duplicating its history', () => {
    const shared = auditRow('audit-shared', COMPANY_ID, null);
    const decision = validateRestoreDestination(
      sourceTables([shared]), destination([{ ...shared }]), COMPANY_ID, true,
    );
    expect([...decision.auditReuse.keys()]).toEqual(['audit-shared']);
  });

  it('reuses a whole retained chain that ends with the authenticated tail', () => {
    const first = auditRow('audit-1', COMPANY_ID, null);
    const second = auditRow('audit-2', COMPANY_ID, first.hash as string);
    const decision = validateRestoreDestination(
      sourceTables([first, second]), destination([{ ...first }, { ...second }]), COMPANY_ID, true,
    );
    expect([...decision.auditReuse.keys()].sort()).toEqual(['audit-1', 'audit-2']);
  });

  it('reuses only the matching rows and leaves genuinely new events to be inserted', () => {
    const shared = auditRow('audit-shared', COMPANY_ID, null);
    const extra = auditRow('audit-extra', COMPANY_ID, null);
    const decision = validateRestoreDestination(
      sourceTables([shared, extra]), destination([{ ...shared }]), COMPANY_ID, true,
    );
    expect([...decision.auditReuse.keys()]).toEqual(['audit-shared']);
  });

  it('still refuses a same-id row whose details, hash, link or timestamp differ', () => {
    const shared = auditRow('audit-shared', COMPANY_ID, null);
    const variants = [
      { ...shared, details: 'rewritten before recovery' },
      { ...shared, hash: 'b'.repeat(64) },
      { ...shared, previousHash: 'c'.repeat(64) },
      { ...shared, createdAt: '2026-01-05T10:00:00.001Z' },
      { ...shared, action: 'OTHER_ACTION' },
    ];
    for (const retained of variants) {
      expect(() => validateRestoreDestination(
        sourceTables([shared]), destination([retained]), COMPANY_ID, true,
      )).toThrow(/RESTORE_ID_CONFLICT/);
    }
  });

  it('proves an identity-mapped event instead of deeming arbitrary rows equal', () => {
    const localId = 'user-local-registered';
    const fromSource = ownedAuditRow('audit-shared', OWNER.id);
    // A retained row stored by an EARLIER recovery through this explicit mapping:
    // only the owner reference was remapped, the source seal was kept verbatim
    // and that earlier recovery's archive certifies the stored content.
    const mappedRetained = { ...fromSource, userId: localId };
    const tables = destination([{ ...mappedRetained }]);
    tables.User = [userRow(OWNER.id, OWNER.email), userRow(localId, OWNER.email)];
    const archive = new Map([[mappedRetained.id as string, auditHistoryDigestOf(mappedRetained as never)]]);

    const decision = validateRestoreDestination(
      sourceTables([fromSource]), tables, COMPANY_ID, true, { [OWNER.id]: localId },
      { auditArchive: archive },
    );
    // The expectation itself carries the proven mapping, and every canonical
    // field (content, stored hash, stored link, timestamp) still has to match.
    expect([...decision.auditReuse.keys()]).toEqual(['audit-shared']);

    // T28 (L62) changed this pinned expectation on purpose. The retained row's
    // stored actor is a certified historical LOCAL id (`localId`) and its seal is
    // the original source one, so it is the same already-present event EVEN when
    // no identity mapping is supplied today: reuse relays on the seal proof, not
    // on relabelling retained history through a map.
    const withoutMap = validateRestoreDestination(
      sourceTables([fromSource]), tables, COMPANY_ID, true, {}, { auditArchive: archive },
    );
    expect([...withoutMap.auditReuse.keys()]).toEqual(['audit-shared']);
    expect(withoutMap.auditProjections.size).toBe(0);
    expect([...withoutMap.auditActorCertifications.entries()])
      // T30 re-pins this value: the certificate records the whole verified reference
      // set (the source actor AND the company the stored seal covers), so the
      // preservation re-proof re-proves the SAME references.
      .toEqual([['audit-shared', { userId: OWNER.id, companyId: COMPANY_ID }]]);

    // A same-id row the mapping cannot explain stays a collision too.
    const unrelated = destination([ownedAuditRow('audit-shared', 'user-someone-else')]);
    unrelated.User = [userRow(OWNER.id, OWNER.email), userRow(localId, OWNER.email), userRow('user-someone-else', 'other@example.test')];
    expect(() => validateRestoreDestination(
      sourceTables([fromSource]), unrelated, COMPANY_ID, true, { [OWNER.id]: localId },
    )).toThrow(/RESTORE_ID_CONFLICT/);
  });
});

/**
 * T19 / S18 — LEGACY ATTRIBUTION DRIFT ALREADY PRESENT IN A REAL INSTALLATION.
 *
 * `AuditLog.userId` used to be a foreign key with ON DELETE SET NULL, so deleting
 * the owner of a company erased the reference on its surviving evidence rows
 * while the stored HMAC kept covering the ORIGINAL payload. The row is still the
 * authenticated event: the only difference is a reference the database erased.
 *
 * The certification below is a SIGNATURE proof, not a causality claim: it shows
 * that the stored seal was computed over this exact content with this exact
 * source user reference. It does not claim the null itself was signed, and it does
 * not accept any other null. Every field, including hash, link and timestamp, must
 * still equal the authenticated source event.
 */
describe('legacy FK-nulled audit attribution (signature-proven projection)', () => {
  const SHARED = 'audit-owner-bound';

  it('certifies the retained original signature and reports the explicit attribution', () => {
    const source = ownedAuditRow(SHARED, OWNER.id);
    // Exactly what the dropped referential action did: the reference disappears,
    // every signed field (content, hash, link, timestamp) stays untouched.
    const drifted = { ...source, userId: null };
    const before = JSON.stringify(drifted);

    const decision = validateRestoreDestination(
      sourceTables([{ ...source }]), destination([{ ...drifted }]), COMPANY_ID, true,
    );

    // One copy of the event: reused as stored, never re-inserted or rewritten.
    expect([...decision.auditReuse.keys()]).toEqual([SHARED]);
    // The identity relationship is explicit and derived from the authenticated
    // source event, never guessed from local accounts.
    expect([...decision.auditProjections.entries()]).toEqual([[SHARED, { userId: OWNER.id }]]);
    // The validator certifies; it never edits the evidence.
    expect(JSON.stringify(drifted)).toBe(before);
  });

  it('refuses a nulled reference whose seal was not computed with the source attribution', () => {
    const source = ownedAuditRow(SHARED, OWNER.id);
    const reSignedForNull = {
      ...source, userId: null,
      hash: computeAuditHash({
        id: SHARED, companyId: COMPANY_ID, userId: null, action: 'JOURNAL_POSTED',
        entity: 'JournalEntry', entityId: 'entry-1', details: null, previousHash: null,
      }),
    };
    expect(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([reSignedForNull]), COMPANY_ID, true,
    )).toThrow(/RESTORE_ID_CONFLICT/);

    // A simply forged seal is refused the same way.
    expect(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([{ ...source, userId: null, hash: 'f'.repeat(64) }]),
      COMPANY_ID, true,
    )).toThrow(/RESTORE_ID_CONFLICT/);
  });

  it('refuses any other canonical difference, including the link and the timestamp', () => {
    const source = ownedAuditRow(SHARED, OWNER.id);
    const drifted = { ...source, userId: null };
    const variants = [
      { ...drifted, details: 'rewritten before recovery' },
      { ...drifted, action: 'OTHER_ACTION' },
      { ...drifted, entityId: 'entry-2' },
      { ...drifted, companyId: 'company-other-before-recovery' },
      { ...drifted, previousHash: 'c'.repeat(64) },
      { ...drifted, createdAt: '2026-01-05T10:00:00.001Z' },
    ];
    for (const retained of variants) {
      expect(() => validateRestoreDestination(
        sourceTables([{ ...source }]), destination([retained]), COMPANY_ID, true,
      )).toThrow(/RESTORE_ID_CONFLICT/);
    }
  });

  it('refuses a conflicting non-null attribution under the same id', () => {
    const source = ownedAuditRow(SHARED, OWNER.id);
    // A different account reference is NOT a projection of this event, even when
    // the rest of the row (and its stored seal) is untouched.
    const otherUser = ownedAuditRow(SHARED, 'user-someone-else');
    const tables = destination([{ ...otherUser }]);
    tables.User = [userRow(OWNER.id, OWNER.email), userRow('user-someone-else', 'other@example.test')];
    expect(() => validateRestoreDestination(
      sourceTables([{ ...source }]), tables, COMPANY_ID, true,
    )).toThrow(/RESTORE_ID_CONFLICT/);
  });

  it('refuses a projection whose source seal does not verify under the local key', () => {
    // Rotated/foreign key: the authenticated source row itself cannot be certified
    // here, so its reference cannot be projected onto any retained row.
    const source = { ...ownedAuditRow(SHARED, OWNER.id), hash: 'a'.repeat(64) };
    expect(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([{ ...source, userId: null }]), COMPANY_ID, true,
    )).toThrow(/RESTORE_ID_CONFLICT/);
  });

  it('does not certify a nulled reference without the authenticated source event', () => {
    // No source event proves the original attribution, so the retained row cannot
    // be certified by the local key either: it stays a refusal, never a wildcard.
    const source = ownedAuditRow(SHARED, OWNER.id);
    expect(() => validateRestoreDestination(
      sourceTables([{ ...source, id: 'audit-other' }]),
      destination([{ ...source, userId: null }]), COMPANY_ID, true,
    )).toThrow(/RESTORE_CHAIN/);
  });

  it('re-verifies an archived attribution instead of trusting the stored label', () => {
    const drifted = { ...ownedAuditRow(SHARED, OWNER.id), userId: null };
    const forged = { ...drifted, hash: 'b'.repeat(64) };
    const archive = new Map([[
      SHARED,
      { digest: auditHistoryDigestOf(forged as never), projectedUserId: OWNER.id },
    ]]);
    expect(() => validateRestoreDestination(
      sourceTables([ownedAuditRow('audit-source', OWNER.id)]), destination([forged]), COMPANY_ID, true,
      {}, { auditArchive: archive },
    )).toThrow(/RESTORE_CHAIN/);
  });

  it('checks a stored attribution with the local key, never with a label', () => {
    const drifted = { ...ownedAuditRow(SHARED, OWNER.id), userId: null };
    expect(retainedAttributionHolds(drifted, OWNER.id)).toBe(true);
    expect(retainedAttributionHolds(drifted, 'user-someone-else')).toBe(false);
    // A row that still carries a reference is not a nulled-reference projection.
    expect(retainedAttributionHolds(ownedAuditRow(SHARED, OWNER.id), OWNER.id)).toBe(false);
    expect(retainedAttributionHolds({ ...drifted, hash: null }, OWNER.id)).toBe(false);
  });
});

/** An audit row sealed over exactly these references under the local key. */
function sealedRow(input: {
  id: string;
  companyId: string | null;
  userId: string | null;
  previousHash?: string | null;
  details?: string | null;
  createdAt?: string;
}): Row {
  const content = {
    id: input.id, companyId: input.companyId, userId: input.userId,
    action: 'JOURNAL_POSTED', entity: 'JournalEntry', entityId: 'entry-1',
    details: input.details ?? null, previousHash: input.previousHash ?? null,
  };
  return {
    ...content,
    createdAt: input.createdAt ?? '2026-01-05T10:00:00.000Z',
    hash: computeAuditHash(content),
  };
}

function refusal(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the restore to be refused');
}

/**
 * T20 / S19 — the SECOND legacy reference. `AuditLog_companyId_fkey` was
 * `ON DELETE SET NULL` until migration 20261105000000, so deleting a company
 * erased `companyId` on its surviving audit rows exactly like the user reference.
 * Such a row is UNOWNED, and the generic foreign-id gate used to refuse it before
 * the authenticated planner could prove it (the reported RESTORE_ID_CONFLICT
 * after the migration). It must reach the same planner, with only the erased
 * references projected.
 */
describe('legacy FK-nulled company attribution (NULL company / NULL both)', () => {
  const SHARED = 'audit-company-bound';

  it('reaches the planner and certifies a nulled company reference', () => {
    const source = sealedRow({ id: SHARED, companyId: COMPANY_ID, userId: OWNER.id });
    // Exactly what the dropped company referential action did.
    const drifted = { ...source, companyId: null };
    const before = JSON.stringify(drifted);

    const decision = validateRestoreDestination(
      sourceTables([{ ...source }]), destination([{ ...drifted }]), COMPANY_ID, true,
    );

    expect([...decision.auditReuse.keys()]).toEqual([SHARED]);
    expect([...decision.auditProjections.entries()]).toEqual([[SHARED, { companyId: COMPANY_ID }]]);
    // Certified, never edited.
    expect(JSON.stringify(drifted)).toBe(before);
  });

  it('certifies BOTH erased references at once, and neither alone', () => {
    const source = sealedRow({ id: SHARED, companyId: COMPANY_ID, userId: OWNER.id });
    const drifted = { ...source, companyId: null, userId: null };

    const decision = validateRestoreDestination(
      sourceTables([{ ...source }]), destination([{ ...drifted }]), COMPANY_ID, true,
    );
    expect([...decision.auditReuse.keys()]).toEqual([SHARED]);
    expect([...decision.auditProjections.entries()]).toEqual([
      [SHARED, { companyId: COMPANY_ID, userId: OWNER.id }],
    ]);

    // Atomic proof: reconstructing only one of the two references does not verify
    // the original seal, so no partial/sequential acceptance is possible.
    expect(retainedAttributionHolds(drifted, { companyId: COMPANY_ID })).toBe(false);
    expect(retainedAttributionHolds(drifted, { userId: OWNER.id })).toBe(false);
    expect(retainedAttributionHolds(drifted, { companyId: COMPANY_ID, userId: OWNER.id })).toBe(true);
  });

  it('still refuses a row attributed to a different live company', () => {
    const source = sealedRow({ id: SHARED, companyId: COMPANY_ID, userId: OWNER.id });
    const foreignCompany = sealedRow({ id: SHARED, companyId: 'company-other', userId: OWNER.id });
    const message = refusal(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([{ ...foreignCompany }]), COMPANY_ID, true,
    ));
    expect(message).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
    expect(message).toContain('fields: companyId');
  });

  it('refuses a nulled-company row whose content differs, naming only the fields', () => {
    const source = sealedRow({ id: SHARED, companyId: COMPANY_ID, userId: OWNER.id });
    const base = { ...source, companyId: null };
    const variants: Array<[Row, string]> = [
      [{ ...base, details: 'rewritten before recovery' }, 'details'],
      [{ ...base, hash: 'b'.repeat(64) }, 'hash'],
      [{ ...base, previousHash: 'c'.repeat(64) }, 'previousHash'],
      [{ ...base, createdAt: '2026-01-05T10:00:00.001Z' }, 'createdAt'],
      [{ ...base, action: 'OTHER_ACTION' }, 'action'],
    ];
    for (const [retained, field] of variants) {
      const message = refusal(() => validateRestoreDestination(
        sourceTables([{ ...source }]), destination([retained]), COMPANY_ID, true,
      ));
      expect(message).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
      expect(message).toContain(field);
      // Never the values themselves: no id, company id, owner id, email or hash.
      for (const secret of [SHARED, COMPANY_ID, OWNER.id, OWNER.email, String(source.hash), 'b'.repeat(64), 'rewritten before recovery']) {
        expect(message).not.toContain(secret);
      }
    }
  });

  it('refuses when the authenticated source seal is unavailable', () => {
    const source = { ...sealedRow({ id: SHARED, companyId: COMPANY_ID, userId: OWNER.id }), hash: 'a'.repeat(64) };
    const message = refusal(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([{ ...source, companyId: null }]), COMPANY_ID, true,
    ));
    expect(message).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
    expect(message).toContain('mismatch: source-seal');
  });

  it('keeps the non-portable gate and message exactly as before', () => {
    const source = sealedRow({ id: SHARED, companyId: COMPANY_ID, userId: OWNER.id });
    const drifted = { ...source, companyId: null };
    const message = refusal(() => validateRestoreDestination(
      sourceTables([{ ...source }]), destination([{ ...drifted }]), COMPANY_ID, false,
    ));
    // Pre-planner refusal: no planner diagnosis is attached.
    expect(message).toBe('RESTORE_ID_CONFLICT: AuditLog');
  });
});

/**
 * S4 / S21 — THE SAME PERSON, A DIFFERENT LOCAL ACCOUNT ID.
 *
 * The operationally reported failure: the portable file is made on THIS
 * installation, the company AND the source account are deleted (post-migration,
 * so the audit rows keep their original references), and a verified local owner
 * with the SAME email but a DIFFERENT id is registered before recovering.
 *
 * The retained audit rows still carry the ORIGINAL signed actor reference; audit
 * attribution is immutable EVIDENCE, not a foreign key, so the proven identity
 * map may never rewrite it. That mapping only describes how a row that is
 * genuinely ABSENT would be stored, so comparing against it alone reported
 * `content`/`fields: none` for history that is byte-identical to the
 * authenticated event. The retained row is matched against the EXACT original
 * source history as well, and only its already-stored digest is reused: no
 * projection, no rewrite, no re-sign, and the existing local-key/archive
 * certification of every preserved row still applies.
 */
describe('same email with a different local account id (original signed history)', () => {
  const SHARED = 'audit-owner-bound';
  const LOCAL_ID = 'user-local-registered';
  const MAP = { [OWNER.id]: LOCAL_ID };

  /** Destination holding ONLY the local account: the source actor may be gone. */
  function localDestination(audits: Row[]): Tables {
    const tables = destination(audits);
    tables.User = [userRow(LOCAL_ID, OWNER.email)];
    return tables;
  }

  it('reuses the retained ORIGINAL event byte-identically, with no projection', () => {
    const source = sealedRow({ id: SHARED, companyId: COMPANY_ID, userId: OWNER.id });
    const retained = { ...source };
    const before = JSON.stringify(retained);

    const decision = validateRestoreDestination(
      sourceTables([{ ...source }]), localDestination([retained]), COMPANY_ID, true, MAP,
    );

    // One copy per event: reused, never re-inserted.
    expect([...decision.auditReuse.keys()]).toEqual([SHARED]);
    // The archive records the row AS STORED (the original actor), never the
    // would-be-stored mapped expectation.
    expect([...decision.auditReuse.values()]).toEqual([auditHistoryDigestOf(retained as never)]);
    expect([...decision.auditReuse.values()])
      .not.toEqual([auditHistoryDigestOf({ ...retained, userId: LOCAL_ID } as never)]);
    // Nothing was projected, relabelled or rewritten.
    expect(decision.auditProjections.size).toBe(0);
    expect(JSON.stringify(retained)).toBe(before);
  });

  it('reuses an UNSEALED retained original exactly, keeping the legacy tolerance', () => {
    // Legacy rows nobody signed are compared by content only, exactly as the
    // digest-only planner always did; this is not a new exemption (no projection,
    // no certification bypass, and a changed field is still a refusal).
    const source = { ...sealedRow({ id: SHARED, companyId: COMPANY_ID, userId: OWNER.id }), hash: null };
    const decision = validateRestoreDestination(
      sourceTables([{ ...source }]), localDestination([{ ...source }]), COMPANY_ID, true, MAP,
    );
    expect([...decision.auditReuse.keys()]).toEqual([SHARED]);
    expect(decision.auditProjections.size).toBe(0);
  });

  it('refuses a changed original and names the real fields, never "none"', () => {
    const source = sealedRow({ id: SHARED, companyId: COMPANY_ID, userId: OWNER.id });
    const variants: Array<[Row, string]> = [
      [{ ...source, details: 'rewritten before recovery' }, 'details'],
      [{ ...source, action: 'OTHER_ACTION' }, 'action'],
      [{ ...source, entityId: 'entry-2' }, 'entityId'],
      [{ ...source, hash: 'b'.repeat(64) }, 'hash'],
      [{ ...source, previousHash: 'c'.repeat(64) }, 'previousHash'],
      [{ ...source, createdAt: '2026-01-05T10:00:00.001Z' }, 'createdAt'],
      // A reference CHANGED TOGETHER WITH ITS SEAL is a different event: the stored
      // seal no longer certifies the authenticated source payload (T28 changed this
      // pinned expectation on purpose — a changed reference that KEEPS the source
      // seal is now the certified historical-actor shape and is reused verbatim).
      [ownedAuditRow(SHARED, 'user-someone-else'), 'hash'],
    ];
    for (const [retained, field] of variants) {
      const message = refusal(() => validateRestoreDestination(
        sourceTables([{ ...source }]), localDestination([retained]), COMPANY_ID, true, MAP,
      ));
      expect(message).toContain(`fields: ${field}`);
      // The refusal must describe the comparison that actually failed.
      expect(message).not.toContain('fields: none');
    }
  });

  it('names the real field when an UNSEALED source row differs', () => {
    const source = { ...sealedRow({ id: SHARED, companyId: COMPANY_ID, userId: OWNER.id }), hash: null };
    const message = refusal(() => validateRestoreDestination(
      sourceTables([{ ...source }]),
      localDestination([{ ...source, details: 'rewritten before recovery' }]), COMPANY_ID, true, MAP,
    ));
    expect(message).toContain('fields: details');
    expect(message).not.toContain('fields: none');
  });

  it('still requires local-key or archive certification of the reused row', () => {
    // The retained row IS the source row verbatim, yet this installation cannot
    // certify its seal: reuse never authorizes a row nothing proves.
    const source = {
      ...sealedRow({ id: SHARED, companyId: COMPANY_ID, userId: OWNER.id }), hash: 'a'.repeat(64),
    };
    expect(() => validateRestoreDestination(
      sourceTables([{ ...source }]), localDestination([{ ...source }]), COMPANY_ID, true, MAP,
    )).toThrow(/RESTORE_CHAIN/);

    // The authenticated archive of an earlier recovery remains the only other
    // certification, exactly as before this correction.
    const archive = new Map([[SHARED, auditHistoryDigestOf(source as never)]]);
    expect(() => validateRestoreDestination(
      sourceTables([{ ...source }]), localDestination([{ ...source }]), COMPANY_ID, true, MAP,
      { auditArchive: archive },
    )).not.toThrow();
  });
});

const VANISHED_COMPANY = 'company-destroyed-after-the-backup';
const DESTROYED_ACTOR = 'user-erased-after-the-backup';
const ROW_TIME = '2026-01-05T10:00:00.000Z';

/**
 * T36 / S2 — the measured shape of a real destination.
 *
 * A company-scoped export only ever carries the payload company's own audit rows,
 * so a destination installation also holds rows that belong to NO event of the
 * payload: another tenant's rows and the unowned rows a legacy company deletion left
 * behind. Their stored seals cover references (actor and/or company) that were
 * destroyed after the backup was exported, so no recomputation can reproduce them
 * and no overlap projection exists for them — the pre-mutation certification gate
 * used to refuse the whole restore with
 * `retained destination audit history cannot be certified (local key or archive)`.
 *
 * The rows are RETAINED IN PLACE (never deleted, never re-inserted) and frozen by
 * the recovery archive, so admission accepts them while every row the payload DOES
 * carry keeps its full proof.
 */
function destroyedReferenceRow(id: string, previousHash: string | null = null): Row {
  // Exactly what the dropped referential actions left behind: both reference
  // columns are empty, while the sealed HMAC still covers the references that
  // existed when this installation wrote the row.
  const sealed = {
    id,
    companyId: VANISHED_COMPANY,
    userId: DESTROYED_ACTOR,
    action: 'COMPANY_DELETED',
    entity: 'Company',
    entityId: null,
    details: null,
    previousHash,
  };
  return {
    ...sealed,
    companyId: null,
    userId: null,
    createdAt: ROW_TIME,
    hash: computeAuditHash(sealed),
  };
}

/** A legacy row nobody ever sealed: no HMAC on either side. */
function unsealedPayloadlessRow(id: string, previousHash: string | null = null): Row {
  return {
    id, companyId: null, userId: null, action: 'LEGACY_MAINTENANCE', entity: 'System',
    entityId: null, details: 'unsealed', hash: null, previousHash, createdAt: ROW_TIME,
  };
}

describe('payload-absent retained rows are retained in place (T36)', () => {
  it('accepts rows whose seals cover references that no longer exist (G1)', () => {
    const sealed = destroyedReferenceRow('retained-destroyed');
    const unsealed = unsealedPayloadlessRow('retained-unsealed');
    const before = JSON.stringify([sealed, unsealed]);

    const decision = validateRestoreDestination(
      sourceTables([auditRow('audit-source', COMPANY_ID, null)]),
      destination([{ ...sealed }, { ...unsealed }]),
      COMPANY_ID,
      true,
    );

    // The decision is recorded for the post-commit archive, with the digest of the
    // bytes this installation actually stores.
    expect([...decision.auditRetainedInPlace.keys()].sort())
      .toEqual(['retained-destroyed', 'retained-unsealed']);
    expect(decision.auditRetainedInPlace.get('retained-destroyed'))
      .toBe(auditHistoryDigestOf(sealed as never));
    expect(decision.auditRetainedInPlace.get('retained-unsealed'))
      .toBe(auditHistoryDigestOf(unsealed as never));
    // Nothing was reused, projected, re-signed or rewritten.
    expect(decision.auditReuse.size).toBe(0);
    expect(decision.auditProjections.size).toBe(0);
    expect(decision.auditActorCertifications.size).toBe(0);
    expect(JSON.stringify([sealed, unsealed])).toBe(before);
  });

  it('still refuses a payload-PRESENT row that is not the authenticated event', () => {
    const retained = destroyedReferenceRow('retained-destroyed');
    const shared = auditRow('audit-shared', COMPANY_ID, null);
    const colliding = { ...shared, action: 'OTHER_ACTION' };
    let message = '';
    try {
      validateRestoreDestination(
        sourceTables([shared]), destination([{ ...retained }, { ...colliding }]), COMPANY_ID, true,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // The classification is per row: a payload-absent row is frozen, never a
    // blanket exemption for the ids the backup really carries.
    expect(message).toMatch(/^RESTORE_ID_CONFLICT: AuditLog/);
    expect(message).toContain('action');
  });

  it('keeps the local (non-portable) replacement contract closed', () => {
    const retained = destroyedReferenceRow('retained-destroyed');
    expect(() => validateRestoreDestination(
      sourceTables([auditRow('audit-source', COMPANY_ID, null)]),
      destination([{ ...retained }]), COMPANY_ID, false,
    )).toThrow(/RESTORE_CHAIN/);
  });
});

describe('the archive certifies a frozen payload-absent row (G7/T36)', () => {
  beforeEach(() => {
    chainState.audits = [];
    chainState.provenance = [];
  });

  function archiveOf(row: Row): void {
    chainState.provenance = [{
      provenance: buildRecoveryProvenance({
        snapshot: makeSnapshot(),
        ownerUserId: OWNER.id,
        ownerEmail: OWNER.email,
        fileDigest: 'a'.repeat(64),
        payloadDigest: 'b'.repeat(64),
        identityMap: {},
        restoredAt: '2026-06-01T08:00:00.000Z',
        auditRows: [],
        retainedAuditRows: [row as never],
      }),
    }];
  }

  it('certifies a frozen row by presence and stored-byte digest, not by recomputation', async () => {
    const retained = destroyedReferenceRow('retained-destroyed');
    chainState.audits = [{ ...retained }];

    // Negative control: the same row WITHOUT an archive entry is still a break,
    // because its seal can never be reproduced by this installation.
    const denied = await verifyAuditChain({});
    expect(denied.valid).toBe(false);
    expect(denied.reasonCode).toBe('HASH_MISMATCH');

    archiveOf(retained);
    const verdict = await verifyAuditChain({});
    expect(verdict.reasonCode).toBeUndefined();
    expect(verdict.valid).toBe(true);
    expect(verdict.firstBreak).toBeNull();
    expect(verdict.members).toBe(1);
  });

  it('marks the entry explicitly so no attribution is re-proved for it', () => {
    const retained = destroyedReferenceRow('retained-destroyed');
    archiveOf(retained);
    const entry = (chainState.provenance[0].provenance as {
      auditEvidence: Array<Record<string, unknown>>;
    }).auditEvidence;
    // Frozen, never overlap-attested: no projection is archived for a row the
    // payload does not carry, and the marker is what the verifier reads.
    expect(entry).toEqual([{
      id: 'retained-destroyed',
      digest: auditHistoryDigestOf(retained as never),
      outsidePayload: true,
    }]);
    expect(archiveOutsidePayloadOf({ digest: 'c'.repeat(64), outsidePayload: true })).toBe(true);
    expect(archiveOutsidePayloadOf({ digest: 'c'.repeat(64) })).toBe(false);
    expect(archiveOutsidePayloadOf('c'.repeat(64))).toBe(false);
  });

  /**
   * The archive record's self-consistency digest, replicated exactly as
   * `historyDigestOf` computes it (fixed field order, absent fields never
   * materialized). Asserted against the builder below, so this replication cannot
   * silently drift from the production rule.
   */
  type EvidenceEntry = {
    id: string; digest: string; projectedUserId?: string; projectedCompanyId?: string;
    sealLess?: true; outsidePayload?: true;
  };
  function historyDigestFor(audit: EvidenceEntry[], journal: EvidenceEntry[]): string {
    const canonical = (entry: EvidenceEntry) => {
      const out: Record<string, unknown> = { id: entry.id, digest: entry.digest };
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

  it('does not re-prove an attribution for a row the payload never carried', async () => {
    const retained = destroyedReferenceRow('retained-outside');
    chainState.audits = [{ ...retained }];
    archiveOf(retained);
    const record = chainState.provenance[0].provenance as {
      auditEvidence: EvidenceEntry[]; journalEvidence: EvidenceEntry[]; historyDigest: string;
    };
    // The digest this file computes for the builder's own record is the production
    // one: the replication below is trustworthy, and older records keep their digest
    // byte for byte because absent optional fields are never materialized.
    expect(record.historyDigest).toBe(
      historyDigestFor(record.auditEvidence, record.journalEvidence));

    // A record that ALSO carries an attribution label (nothing produces this today,
    // but a record is data) must not turn into a proof for a row that has no source
    // event: the marker decides, and the stored digest above is the certification.
    const labelled: EvidenceEntry[] = [{
      id: 'retained-outside',
      digest: auditHistoryDigestOf(retained as never),
      outsidePayload: true,
      projectedUserId: 'user-who-does-not-explain-this-row',
    }];
    chainState.provenance = [{
      provenance: {
        ...record, auditEvidence: labelled,
        historyDigest: historyDigestFor(labelled, record.journalEvidence),
      },
    }];
    const verdict = await verifyAuditChain({});
    expect(verdict.firstBreak).toBeNull();
    expect(verdict.valid).toBe(true);

    // The SAME label without the marker keeps failing: an attribution is re-proved
    // with the local key for every row the archive does not declare payload-absent.
    const unmarked = [{ ...labelled[0] }] as Array<Record<string, unknown>>;
    delete unmarked[0].outsidePayload;
    chainState.provenance = [{
      provenance: {
        ...record, auditEvidence: unmarked,
        historyDigest: historyDigestFor(unmarked as EvidenceEntry[], record.journalEvidence),
      },
    }];
    const denied = await verifyAuditChain({});
    expect(denied.valid).toBe(false);
    expect(denied.reasonCode).toBe('ARCHIVE_ATTRIBUTION_MISMATCH');
  });

  it('keeps an unsealed frozen row seal-less as well', async () => {
    const unsealed = unsealedPayloadlessRow('retained-unsealed');
    chainState.audits = [{ ...unsealed }];
    archiveOf(unsealed);
    const entry = (chainState.provenance[0].provenance as {
      auditEvidence: Array<Record<string, unknown>>;
    }).auditEvidence;
    expect(entry).toEqual([{
      id: 'retained-unsealed',
      digest: auditHistoryDigestOf(unsealed as never),
      outsidePayload: true,
      sealLess: true,
    }]);
    const verdict = await verifyAuditChain({});
    expect(verdict.valid).toBe(true);
  });

  it('fails on stored-byte drift of an archived frozen row', async () => {
    const retained = destroyedReferenceRow('retained-destroyed');
    archiveOf(retained);
    chainState.audits = [{ ...retained, details: 'rewritten after the archive' }];
    const verdict = await verifyAuditChain({});
    expect(verdict.valid).toBe(false);
    expect(verdict.reasonCode).toBe('ARCHIVE_HASH_MISMATCH');
  });

  it('keeps ARCHIVE_MEMBER_MISSING for an archived sealed row that disappeared', async () => {
    archiveOf(destroyedReferenceRow('retained-destroyed'));
    chainState.audits = [];
    const verdict = await verifyAuditChain({});
    expect(verdict.valid).toBe(false);
    expect(verdict.reasonCode).toBe('ARCHIVE_MEMBER_MISSING');
  });
});
