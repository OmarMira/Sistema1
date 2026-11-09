/**
 * T26 / S3, S4, S15, S16, S18, S19 — adversarial edges of the owner-verified
 * recovery WORKFLOW.
 *
 * The positive flow, the source-owner-deletion flow, the same-email/different-id
 * mapping and the basic token controls are already pinned by
 * `bootstrap-recovery.test.ts`, `source-owner-authorization.test.ts`,
 * `recovery-challenge.test.ts` and the PostgreSQL contract suite. This file only
 * adds the edges those do NOT cover, and every case asserts the observable
 * public-interface effect (workflow result, stored rows, provenance) including
 * "nothing changed" after a refusal:
 *
 *  1. token bound to the exact uploaded file and to its own lifecycle (expiry,
 *     single use after a REFUSED restore, cross-file use that must not burn it);
 *  2. brute force split across the two stages cannot bypass the shared budget;
 *  3. a retained audit row tampered in ANY canonical field before the restore is
 *     refused and every stored row stays byte-identical;
 *  4. the recovery archive either certifies a retained row or fails closed
 *     (unreadable archive / attestation that does not match the stored row);
 *  5. identity edges: a mapped local account keeps its whole stored row
 *     byte-identical, and the source owner stamp variants (legacy grandfathered,
 *     invalid timestamp, email disagreement) fail closed.
 *
 * Synthetic data only: fictional company/owner/audit values, an in-memory
 * destination client and the real validators. No database, file, credential or
 * server is touched, and no fixed real identifier is used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECOVERY_POLICY, createMemoryRecoveryChallengeStore,
  completePortableRecovery, requestPortableRecoveryChallenge,
  type PortableRecoveryDeps,
} from '@/lib/backup-recovery-auth';
import { createMemoryRecoveryLockStore } from '@/lib/backup-recovery-lock';
import { createPortableDestinationRestore } from '@/lib/backup-recovery-provenance';
import { RESTORE_MODELS, validateRestoreDestination, type Row, type Tables } from '@/lib/backup-validation';
import { sealSnapshot } from '@/lib/backup-format';
import { createPortableContainer } from '@/lib/backup-portable';
import type { RecoveryArchive } from '@/lib/journal-hash';
import { auditHistoryDigestOf, computeAuditHash } from '@/lib/journal-hash';
import type { BackupData } from '@/lib/backup';
import {
  COMPANY_ID, COMPANY_LEGAL_NAME, OWNER, SOURCE_PASSWORD,
  auditRow, fakeClient, fakeProvenance, makeSnapshot, portableFile, userRow,
} from './helpers';

const NOW = new Date('2026-04-01T08:00:00.000Z');
const DELETED_COMPANY = 'company-deleted-before-recovery';
const LOCAL_ID = 'user-local-registered';
const RECEIPT_ID = 'op-recovery-committed';

/** Synthetic credential helpers: no bcrypt cost, no real password anywhere. */
const hashPassword = async (password: string) => `synthetic-hash:${password}`;
const verifyPassword = async (password: string, hash: string) =>
  hash === `synthetic-hash:${password}`;

function emptyTables(): Tables {
  return Object.fromEntries(Object.values(RESTORE_MODELS).map((model) => [model, [] as Row[]]));
}

/** Incoming side of the replacement, built from the authenticated snapshot. */
function sourceTables(snapshot: BackupData): Tables {
  const tables = emptyTables();
  tables.Company = (snapshot.data.company ?? []) as Row[];
  tables.User = (snapshot.data.users ?? []) as Row[];
  tables.AuditLog = ((snapshot.data.auditLogs ?? []) as Row[]).map((row) => ({ ...row }));
  tables.JournalEntry = (snapshot.data.journalEntries ?? []) as Row[];
  return tables;
}

/** Destination read-set: whatever the prepare transaction committed. */
function destinationTables(state: { users: Row[]; companies: Row[]; audits: Row[] }): Tables {
  const tables = emptyTables();
  tables.Company = state.companies.map((row) => ({ entityType: 'BUSINESS', taxId: null, ...row }));
  tables.User = state.users.map((row) => ({ ...row }));
  tables.AuditLog = state.audits.map((row) => ({ ...row }));
  return tables;
}

interface Flow {
  deps: PortableRecoveryDeps;
  store: ReturnType<typeof createMemoryRecoveryChallengeStore>;
  lock: ReturnType<typeof createMemoryRecoveryLockStore>;
  mail: Array<{ to: string; token: string }>;
  provenance: ReturnType<typeof fakeProvenance>;
  clock: { now: Date };
  /** Restore attempts that reached the coordinated replacement. */
  attempts: Array<{ companyId: string; fileText: string; identityMap: Record<string, string> }>;
  state: ReturnType<typeof fakeClient>['state'];
  snapshot: BackupData;
  /** The exact uploaded bytes the current challenge was issued for. */
  text: string;
}

function flow(options: {
  seed?: Parameters<typeof fakeClient>[0];
  snapshot?: BackupData;
  /** `throw` makes the coordinated replacement refuse (pre-commit refusal). */
  coordinated?: 'validate-and-commit' | 'throw';
  archive?: () => Promise<RecoveryArchive | undefined>;
  /**
   * T36: rewrite this preserved audit row AFTER admission and before the
   * replacement returns, i.e. between the two proofs of the same operation.
   */
  driftRetainedId?: string;
} = {}): Flow {
  const { client, state } = fakeClient(options.seed ?? {});
  const store = createMemoryRecoveryChallengeStore();
  const lock = createMemoryRecoveryLockStore();
  const provenance = fakeProvenance();
  const mail: Flow['mail'] = [];
  const clock = { now: new Date(NOW) };
  const attempts: Flow['attempts'] = [];
  const snapshot = options.snapshot ?? makeSnapshot();

  const restore = createPortableDestinationRestore({
    client,
    provenance: provenance.recorder,
    now: () => clock.now,
    hashPassword,
    verifyPassword,
    readAuditArchive: options.archive,
    coordinatedRestore: async (companyId, text, settings, identityMap) => {
      if (options.coordinated === 'throw') {
        throw new Error('RESTORE_SCHEMA: destination refused the payload');
      }
      attempts.push({ companyId, fileText: text, identityMap });
      const parsed = JSON.parse(text) as BackupData;
      // The REAL admission decision (retained-audit planner, archive attestation,
      // identity mapping). A refusal here aborts before anything is written.
      const decision = validateRestoreDestination(
        sourceTables(parsed), destinationTables(state), companyId, true, identityMap,
        settings.auditArchive ? { auditArchive: settings.auditArchive } : {},
      );
      const incoming = ((parsed.data.auditLogs ?? []) as Row[]).map((row) => {
        const mapped = typeof row.userId === 'string' ? identityMap[row.userId] : undefined;
        return mapped && mapped !== row.userId ? { ...row, userId: mapped } : { ...row };
      });
      state.companies = [{ id: companyId, legalName: parsed.manifest.companyInfo.legalName }];
      // T36: fail-closed probe. Mutating a preserved row here happens AFTER the
      // admission decision and BEFORE the post-commit proof, so only that proof can
      // still catch it.
      if (options.driftRetainedId !== undefined) {
        state.audits = state.audits.map((row) => (String(row.id) === options.driftRetainedId
          ? { ...row, details: 'rewritten after admission' }
          : row));
      }
      // Reused rows are preserved, never re-inserted (same-installation recovery).
      state.audits = [
        ...state.audits,
        ...incoming.filter((row) => !decision.auditReuse.has(String(row.id))),
        {
          id: RECEIPT_ID, companyId, userId: null, action: 'COMPANY_RESTORE_COMMITTED',
          entity: 'Backup', entityId: null, details: null, hash: null, previousHash: null,
          createdAt: NOW.toISOString(),
        },
      ];
      state.journals = [...state.journals, ...((parsed.data.journalEntries ?? []) as Row[])];
      return { status: 'committed' as const, operationId: RECEIPT_ID, counts: parsed.manifest.recordCounts };
    },
  });

  const deps: PortableRecoveryDeps = {
    now: () => clock.now,
    challenges: store,
    lock,
    mail: { send: async (message) => { mail.push(message as unknown as Flow['mail'][number]); } },
    installationState: async () => ({ companies: state.companies.length, audits: state.audits.length }),
    restore,
  };
  return {
    deps, store, lock, mail, provenance, clock, attempts, state, snapshot, text: portableFile(snapshot),
  };
}

function request(f: Flow, overrides: Partial<{
  fileText: string; password: string; companyLegalName: string; ownerEmail: string;
}> = {}) {
  f.text = overrides.fileText ?? f.text;
  return requestPortableRecoveryChallenge(f.deps, {
    fileText: f.text,
    password: overrides.password ?? SOURCE_PASSWORD,
    companyLegalName: overrides.companyLegalName ?? COMPANY_LEGAL_NAME,
    ownerEmail: overrides.ownerEmail ?? OWNER.email,
  });
}

async function challenge(f: Flow, overrides: Partial<{ fileText: string }> = {}): Promise<string> {
  const result = await request(f, overrides);
  expect(result.status).toBe('challenge_sent');
  return f.mail.at(-1)!.token;
}

function complete(f: Flow, token: string, overrides: Partial<{
  fileText: string; password: string; companyLegalName: string; ownerEmail: string;
}> = {}) {
  return completePortableRecovery(f.deps, {
    fileText: overrides.fileText ?? f.text,
    password: overrides.password ?? SOURCE_PASSWORD,
    companyLegalName: overrides.companyLegalName ?? COMPANY_LEGAL_NAME,
    ownerEmail: overrides.ownerEmail ?? OWNER.email,
    token,
  });
}

/** A local account that already belongs to the same person (same email, other id). */
function localAccount(email = OWNER.email) {
  return {
    ...userRow(LOCAL_ID, email, 'user'),
    passwordHash: `synthetic-hash:${SOURCE_PASSWORD}`,
    emailVerifiedAt: new Date('2026-02-01T00:00:00.000Z'),
    legacyUser: false,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('token bound to the exact file and to its own lifecycle (S3/S15)', () => {
  it('refuses an expired token without restoring or touching a mapped local identity', async () => {
    const seeded = localAccount();
    const f = flow({ seed: { users: [{ ...seeded }] } });
    const token = await challenge(f);
    const usersBefore = JSON.stringify(f.state.users);

    f.clock.now = new Date(NOW.getTime() + RECOVERY_POLICY.tokenMs + 1000);
    const result = await complete(f, token);

    expect(result).toMatchObject({ status: 400, code: 'RECOVERY_TOKEN_EXPIRED' });
    // Observable effects: zero restores, zero companies, zero provenance, and the
    // local account is byte-identical (no re-hash, no role change, no duplicate).
    expect(f.attempts).toHaveLength(0);
    expect(f.state.companies).toHaveLength(0);
    expect(f.provenance.records).toHaveLength(0);
    expect(JSON.stringify(f.state.users)).toBe(usersBefore);
    expect(f.state.users).toHaveLength(1);
    expect(f.lock.describe()).toBeNull();
    // The draft stays spent for its own file: recovery needs a new challenge.
    expect(f.store.describe().challenges[0].usedAt).toBeNull();
  });

  it('refuses the second use of a token after a REFUSED restore (still-empty installation)', async () => {
    const f = flow({ coordinated: 'throw' });
    const token = await challenge(f);

    const first = await complete(f, token);
    expect(first).toMatchObject({ status: 400, code: 'RECOVERY_RESTORE_REFUSED' });
    // The refused attempt left nothing behind, so the NEXT check cannot be the
    // "installation is not empty" shortcut: the token itself must be spent.
    expect(f.state.companies).toHaveLength(0);
    expect(f.state.users).toHaveLength(0);
    expect(f.store.describe().challenges[0].usedAt).not.toBeNull();

    const replay = await complete(f, token);
    expect(replay).toMatchObject({ status: 400, code: 'RECOVERY_TOKEN_USED' });
    expect(f.provenance.records).toHaveLength(0);
    expect(f.state.companies).toHaveLength(0);
    expect(f.state.users).toHaveLength(0);
  });

  it('refuses a different backup file with this token and keeps the token usable for its own file', async () => {
    const f = flow();
    const other = makeSnapshot({ auditLogs: [auditRow('audit-other-file', COMPANY_ID, null)] });
    const otherText = portableFile(other);
    expect(otherText).not.toBe(f.text);
    const token = await challenge(f);

    const foreign = await complete(f, token, { fileText: otherText });
    expect(foreign).toMatchObject({ status: 400, code: 'RECOVERY_TOKEN_INVALID' });
    expect(f.attempts).toHaveLength(0);
    expect(f.state.companies).toHaveLength(0);
    // The foreign attempt did not burn the draft: the token still belongs to A.
    expect(f.store.describe().challenges[0].usedAt).toBeNull();

    const own = await complete(f, token);
    expect(own).toMatchObject({ status: 'restored', operationId: RECEIPT_ID });
    expect(f.attempts).toHaveLength(1);
    expect(f.state.companies).toHaveLength(1);
    // The restored evidence is A's (no audit row), never B's.
    const record = f.provenance.records[0] as Record<string, any>;
    expect(record.companyId).toBe(COMPANY_ID);
    expect(record.auditEvidence).toEqual([]);
    expect(f.state.audits.some((row) => String(row.id) === 'audit-other-file')).toBe(false);
  });

  it('rejects a malformed token before charging an attempt or reading the file', async () => {
    const f = flow();
    // The challenge request is charged against the file budget; a malformed token
    // must not add to it and must not reach the restore.
    await challenge(f);
    const charged = f.store.describe().attemptsUsed;
    for (const token of ['A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)} `, '']) {
      const result = await complete(f, token);
      expect(result).toMatchObject({ status: 400, code: 'RECOVERY_TOKEN_INVALID' });
    }
    expect(f.store.describe().attemptsUsed).toBe(charged);
    expect(f.attempts).toHaveLength(0);
    expect(f.state.companies).toHaveLength(0);
  });

  it('blocks a brute force split across both stages instead of accepting the right password', async () => {
    const f = flow();
    const token = await challenge(f);

    let blocked: unknown = null;
    for (let attempt = 0; attempt < RECOVERY_POLICY.attempts; attempt += 1) {
      const guess = await complete(f, token, { password: `wrong-guess-${attempt}` });
      if ((guess as { status: number | string }).status === 429) { blocked = guess; break; }
      expect(guess).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
      // A wrong guess never consumes the token: only the attempt budget moves.
      expect(f.store.describe().challenges[0].usedAt).toBeNull();
    }
    expect(blocked).toMatchObject({ status: 429, code: 'RECOVERY_TOO_MANY_ATTEMPTS' });

    const correct = await complete(f, token);
    expect(correct).toMatchObject({ status: 429, code: 'RECOVERY_TOO_MANY_ATTEMPTS' });
    expect(f.attempts).toHaveLength(0);
    expect(f.state.companies).toHaveLength(0);
    expect(f.provenance.records).toHaveLength(0);
  });
});

describe('retained audit tampering is refused without rewriting stored rows (S16/S18)', () => {
  const retainedOriginal = () => auditRow('audit-shared', COMPANY_ID, null);

  it('reuses the untouched retained event byte-identically (control)', async () => {
    const retained = retainedOriginal();
    const f = flow({
      seed: { audits: [{ ...retained }] },
      snapshot: makeSnapshot({ auditLogs: [{ ...retained }] }),
    });
    const token = await challenge(f);
    const result = await complete(f, token);
    expect(result).toMatchObject({ status: 'restored' });
    const copies = f.state.audits.filter((row) => String(row.id) === 'audit-shared');
    expect(copies).toHaveLength(1);
    expect(copies[0]).toEqual(retained);
  });

  it('refuses a retained row tampered in any canonical field and leaves every stored row byte-identical', async () => {
    const source = retainedOriginal();
    const variants: Array<[string, Row]> = [
      ['action', { ...source, action: 'OTHER_ACTION' }],
      ['entity', { ...source, entity: 'OtherEntity' }],
      ['entityId', { ...source, entityId: 'other-entity' }],
      ['details', { ...source, details: 'rewritten before recovery' }],
      ['hash', { ...source, hash: 'b'.repeat(64) }],
      ['previousHash', { ...source, previousHash: 'c'.repeat(64) }],
      ['createdAt', { ...source, createdAt: '2026-01-05T10:00:00.001Z' }],
      ['companyId', { ...source, companyId: DELETED_COMPANY }],
    ];
    for (const [field, retained] of variants) {
      const f = flow({
        seed: { audits: [{ ...retained }] },
        snapshot: makeSnapshot({ auditLogs: [{ ...source }] }),
      });
      const before = JSON.stringify(f.state.audits);
      const usersBefore = JSON.stringify(f.state.users);
      const token = await challenge(f);
      const result = await complete(f, token);

      // Refused by the REAL admission planner: the retained row is not the
      // authenticated event.
      expect(result, field).toMatchObject({ status: 400, code: 'RECOVERY_RESTORE_REFUSED' });
      expect((result as { message: string }).message, field).toMatch(/RESTORE_ID_CONFLICT/);
      // Nothing was certified, nothing was rewritten, no ledger row was kept.
      expect(JSON.stringify(f.state.audits), field).toBe(before);
      expect(JSON.stringify(f.state.users), field).toBe(usersBefore);
      expect(f.state.companies, field).toHaveLength(0);
      expect(f.provenance.records, field).toHaveLength(0);
    }
  });

  it('reuses a retained row that differs ONLY in the actor reference (T31)', async () => {
    // T31: this entry used to sit in the refusal matrix above. It is the shape the
    // recovery must now ACCEPT — the authenticated event carries `userId: null`
    // (the actor reference was erased BEFORE the export) while the retained row
    // keeps a live, locally certified actor reference covered by no seal; the
    // stored seal proves the null-actor payload, so the row is reused
    // BYTE-IDENTICALLY: never relabelled, projected or re-signed.
    const source = retainedOriginal();
    const retained = { ...source, userId: 'user-someone-else' };
    const f = flow({
      seed: { audits: [{ ...retained }] },
      snapshot: makeSnapshot({ auditLogs: [{ ...source }] }),
    });
    const before = JSON.stringify(f.state.audits);
    const token = await challenge(f);
    const result = await complete(f, token);

    expect(result).toMatchObject({ status: 'restored' });
    // Exactly ONE copy of the event, byte-identical: nothing re-inserted.
    const copies = f.state.audits.filter((row) => String(row.id) === 'audit-shared');
    expect(copies).toHaveLength(1);
    expect(copies[0]).toEqual(retained);
    expect(JSON.stringify(f.state.audits.slice(0, 1))).toBe(before);
    // The stored actor reference is retained history: never remapped onto a local
    // account, and no account is manufactured for it.
    expect(copies[0].userId).toBe('user-someone-else');
    expect(f.state.users.some((user) => String(user.id) === 'user-someone-else')).toBe(false);
    // Only the restored payload's company exists: no other company was touched.
    expect(f.state.companies).toHaveLength(1);
    expect(f.state.companies[0].id).toBe(COMPANY_ID);
    // Evidence describes the STORED row: no attribution rewrite or invented label.
    expect(f.provenance.records).toHaveLength(1);
    const record = f.provenance.records[0] as { auditEvidence: Array<Record<string, unknown>> };
    expect(record.auditEvidence).toHaveLength(1);
    expect(record.auditEvidence[0]).not.toHaveProperty('projectedUserId');
    expect(record.auditEvidence[0]).not.toHaveProperty('projectedCompanyId');
  });

  it('refuses an archive attestation that does not certify the stored retained row', async () => {
    // A retained row this installation never signed itself (foreign source key):
    // only the authenticated archive of an earlier recovery can certify it.
    const retained = { ...auditRow('retained-foreign', DELETED_COMPANY, null), hash: 'a'.repeat(64) };
    const source = auditRow('audit-source', COMPANY_ID, null);

    const certified = flow({
      seed: { audits: [{ ...retained }] },
      snapshot: makeSnapshot({ auditLogs: [{ ...source }] }),
      archive: async () => new Map([[retained.id as string, 'd'.repeat(64)]]),
    });
    // A digest that is not the stored row's digest certifies nothing.
    const certifiedToken = await challenge(certified);
    const refused = await complete(certified, certifiedToken);
    expect(refused).toMatchObject({ status: 400, code: 'RECOVERY_RESTORE_REFUSED' });
    expect((refused as { message: string }).message).toMatch(/RESTORE_(CHAIN|ID_CONFLICT)/);
    expect(certified.state.audits).toEqual([retained]);
    expect(certified.state.companies).toHaveLength(0);
    expect(certified.provenance.records).toHaveLength(0);
  });

  it('refuses an unreadable recovery archive before preparing anything', async () => {
    const f = flow({
      snapshot: makeSnapshot(),
      archive: async () => {
        throw new Error('relation "BootstrapRecoveryProvenance" does not exist');
      },
    });
    const token = await challenge(f);
    const result = await complete(f, token);

    expect(result).toMatchObject({ status: 409, code: 'RECOVERY_PROVENANCE_UNREADABLE' });
    // Pre-commit refusal: no shell was created, no restore started, no evidence.
    expect(f.attempts).toHaveLength(0);
    expect(f.state.companies).toHaveLength(0);
    expect(f.state.users).toHaveLength(0);
    expect(f.provenance.records).toHaveLength(0);
    expect(f.lock.describe()).toBeNull();
  });
});

describe('identity edges of the source-owner credential (S4/S15/S18)', () => {
  it('keeps the whole mapped local account byte-identical and never creates the source id', async () => {
    const seeded = localAccount();
    const f = flow({ seed: { users: [{ ...seeded }] } });
    const usersBefore = JSON.stringify(f.state.users);
    const token = await challenge(f);
    const result = await complete(f, token);

    expect(result).toMatchObject({ status: 'restored', sessionUserId: LOCAL_ID });
    expect(f.attempts[0].identityMap).toEqual({ [OWNER.id]: LOCAL_ID });
    // Byte-identical: password hash, platform role, verification state and every
    // other stored field of the local account are untouched, and the source
    // account id is never materialized locally.
    expect(JSON.stringify(f.state.users)).toBe(usersBefore);
    expect(f.state.users.some((user) => user.id === OWNER.id)).toBe(false);
    expect(f.state.users.some((user) => user.platformRole === 'super_admin')).toBe(false);
    // Membership is the documented one, and it points at the local id.
    expect(f.state.members).toEqual([
      expect.objectContaining({ userId: LOCAL_ID, companyId: COMPANY_ID, role: 'company_admin' }),
    ]);
  });

  it('accepts a legacy grandfathered source owner without a verified email stamp', async () => {
    const f = flow();
    const text = portableFile(f.snapshot, SOURCE_PASSWORD, OWNER, {
      emailVerifiedAt: null, legacyUser: true,
    });
    const requested = await request(f, { fileText: text });
    expect(requested).toMatchObject({ status: 'challenge_sent' });
    expect(f.mail).toHaveLength(1);
    const completed = await complete(f, f.mail[0].token, { fileText: text });
    expect(completed).toMatchObject({ status: 'restored' });
  });

  it('refuses a stamp timestamp that is not a real date', async () => {
    const snapshot = makeSnapshot();
    sealSnapshot(snapshot);
    const text = createPortableContainer({
      snapshot,
      password: SOURCE_PASSWORD,
      owner: {
        ownerUserId: OWNER.id,
        ownerEmail: OWNER.email,
        emailVerifiedAt: '2026-01-02T00:00:00.000Z',
        legacyUser: false,
        verifiedAt: 'not-a-real-date',
      },
      companyLegalName: COMPANY_LEGAL_NAME,
      createdAt: snapshot.manifest.createdAt,
    });
    const f = flow({ snapshot });
    const result = await request(f, { fileText: text });
    expect(result).toMatchObject({ status: 403, code: 'RECOVERY_OWNER_UNAVAILABLE' });
    expect(f.mail).toHaveLength(0);
    expect(f.attempts).toHaveLength(0);
  });

  it('refuses a sealed owner email that disagrees with the owner row inside the backup', async () => {
    const f = flow({
      snapshot: makeSnapshot({ users: [userRow(OWNER.id, 'otro-correo@example.test')] }),
    });
    const result = await request(f);
    expect(result).toMatchObject({ status: 403, code: 'RECOVERY_OWNER_UNAVAILABLE' });
    expect(f.mail).toHaveLength(0);
    expect(f.attempts).toHaveLength(0);
  });
});

/**
 * T36 / S2 — THE MEASURED SHAPE OF A REAL DESTINATION.
 *
 * The portable audit section is COMPANY-SCOPED, so an installation also holds audit
 * rows that belong to no event of the payload: another tenant's rows and the unowned
 * rows a legacy company deletion left behind. Their stored seals cover references
 * (actor, company) that were destroyed AFTER the backup was exported, so nothing in
 * this installation can recompute them and no overlap projection exists for them.
 *
 * They are never deleted and never rewritten (the replacement preserves `AuditLog`
 * and skips reused ids), so the recovery archives their stored bytes and both
 * durable proofs — the post-commit proof here, the chain verifiers after it — read
 * those bytes back instead of demanding an impossible recomputation.
 */
const VANISHED_COMPANY = 'company-destroyed-after-the-backup';
const DESTROYED_ACTOR = 'user-erased-after-the-backup';
const ROW_TIME = '2026-01-05T10:00:00.000Z';

/** A retained row whose seal covers references that no longer exist anywhere. */
function destroyedReferenceRow(id: string): Row {
  const sealed = {
    id, companyId: VANISHED_COMPANY, userId: DESTROYED_ACTOR, action: 'COMPANY_DELETED',
    entity: 'Company', entityId: null, details: null, previousHash: null,
  };
  return {
    ...sealed, companyId: null, userId: null, createdAt: ROW_TIME,
    hash: computeAuditHash(sealed),
  };
}

/** A legacy row nobody ever sealed. */
function unsealedPayloadlessRow(id: string): Row {
  return {
    id, companyId: null, userId: null, action: 'LEGACY_MAINTENANCE', entity: 'System',
    entityId: null, details: 'unsealed', hash: null, previousHash: null, createdAt: ROW_TIME,
  };
}

describe('payload-absent retained history archives end to end (T36)', () => {
  function seed() {
    return {
      hashed: destroyedReferenceRow('retained-destroyed'),
      unsealed: unsealedPayloadlessRow('retained-unsealed'),
      payload: auditRow('audit-from-payload', COMPANY_ID, null),
    };
  }

  it('restores, archives EVERY preserved row and keeps the frozen rows byte-identical', async () => {
    const rows = seed();
    const snapshot = makeSnapshot({ auditLogs: [{ ...rows.payload }] });
    const f = flow({
      seed: { audits: [{ ...rows.hashed }, { ...rows.unsealed }] },
      snapshot,
    });
    const retainedBefore = JSON.stringify([rows.hashed, rows.unsealed]);

    const token = await challenge(f);
    const result = await complete(f, token);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'restored' });

    // The frozen rows are untouched: no delete, no rewrite, no re-sign.
    expect(JSON.stringify(f.state.audits.slice(0, 2))).toBe(retainedBefore);

    // The archive covers EVERY preserved row, and marks the payload-absent ones
    // explicitly so no later verification mistakes them for overlap-attested
    // source events (none exist) or for locally recomputable rows (they are not).
    expect(f.provenance.records).toHaveLength(1);
    const evidence = (f.provenance.records[0] as {
      auditEvidence: Array<{ id: string; digest: string; outsidePayload?: true; sealLess?: true }>;
    }).auditEvidence;
    expect(evidence).toEqual([
      { id: 'audit-from-payload', digest: auditHistoryDigestOf(rows.payload as never) },
      { id: 'retained-destroyed', digest: auditHistoryDigestOf(rows.hashed as never), outsidePayload: true },
      {
        id: 'retained-unsealed', digest: auditHistoryDigestOf(rows.unsealed as never),
        outsidePayload: true, sealLess: true,
      },
    ]);
    // Coverage is exactly the preserved set: nothing left uncertifiable.
    expect(evidence.map((entry) => entry.id).sort())
      .toEqual(['audit-from-payload', 'retained-destroyed', 'retained-unsealed']);
  });

  it('fails the post-commit proof when a frozen row drifted after admission', async () => {
    const rows = seed();
    const snapshot = makeSnapshot({ auditLogs: [{ ...rows.payload }] });
    const f = flow({
      seed: { audits: [{ ...rows.hashed }, { ...rows.unsealed }] },
      snapshot,
      driftRetainedId: 'retained-destroyed',
    });

    const token = await challenge(f);
    const result = await complete(f, token);
    // The bytes admitted are not the bytes stored: the recovery reports
    // reconciliation instead of success, and no provenance record is written.
    expect(result).toMatchObject({
      status: 'reconciliation_required', code: 'RECOVERY_DESTINATION_AUDIT_LOST',
    });
    expect(f.provenance.records).toHaveLength(0);
  });
});
