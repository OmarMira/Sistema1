import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECOVERY_POLICY, createMemoryRecoveryChallengeStore,
  completePortableRecovery, requestPortableRecoveryChallenge,
  type PortableRecoveryDeps,
} from '@/lib/backup-recovery-auth';
import { createMemoryRecoveryLockStore } from '@/lib/backup-recovery-lock';
import {
  createPortableDestinationRestore, type PortableRestoreResult,
} from '@/lib/backup-recovery-provenance';
import {
  COMPANY_ID, COMPANY_LEGAL_NAME, OWNER, OWNER_VERIFIED_AT, SOURCE_PASSWORD,
  auditRow, fakeClient, fakeProvenance, makeSnapshot, portableFile, userRow, withEnv,
} from './helpers';
import { auditHistoryDigestOf, computeAuditHash } from '@/lib/journal-hash';
import type { BackupData } from '@/lib/backup';

const NOW = new Date('2026-03-01T09:00:00.000Z');

const passwordHashOf = (password: string) =>
  `$2a$12$hashed-${crypto.createHash('sha256').update(password).digest('hex').slice(0, 8)}`;

interface Flow {
  text: string;
  snapshot: BackupData;
  deps: PortableRecoveryDeps;
  store: ReturnType<typeof createMemoryRecoveryChallengeStore>;
  lock: ReturnType<typeof createMemoryRecoveryLockStore>;
  mail: Array<{ type: string; to: string; token: string }>;
  provenance: ReturnType<typeof fakeProvenance>;
  clock: { now: Date };
  restoreCalls: Array<{ companyId: string; identityMap: Record<string, string> }>;
  dbState: ReturnType<typeof fakeClient>['state'];
  plan: { mode: 'commit' | 'throw' | 'reconcile' | 'drop-history' | 'rewrite-history' | 'reuse-retained' | 'keep-conflict'; closeCalls: number };
  deletedUsers: string[];
}

function flow(seed: Parameters<typeof fakeClient>[0] = {}, snapshot = makeSnapshot()): Flow {
  const { client, state } = fakeClient(seed);
  const store = createMemoryRecoveryChallengeStore();
  const lock = createMemoryRecoveryLockStore();
  const provenance = fakeProvenance();
  const clock = { now: new Date(NOW) };
  const mail: Flow['mail'] = [];
  const restoreCalls: Flow['restoreCalls'] = [];
  const plan = { mode: 'commit' as Flow['plan']['mode'], closeCalls: 0 };
  const deletedUsers: string[] = [];
  const trackedClient = {
    ...client,
    user: {
      ...client.user,
      deleteMany: async (query: { where: Record<string, unknown> }) => {
        deletedUsers.push(String(query.where.id));
        return client.user.deleteMany(query);
      },
    },
  };
  const restore = createPortableDestinationRestore({
    client: trackedClient,
    provenance: provenance.recorder,
    now: () => clock.now,
    hashPassword: async (password: string) => passwordHashOf(String(password)),
    verifyPassword: async (password: string, hash: string) => hash === passwordHashOf(password),
    closeMaintenance: async () => {
      plan.closeCalls += 1;
    },
    coordinatedRestore: async (companyId, text, _mode, identityMap) => {
      restoreCalls.push({ companyId, identityMap });
      if (plan.mode === 'throw') throw new Error('RESTORE_SCHEMA: destination refused the payload');
      if (plan.mode === 'reconcile') {
        return {
          status: 'reconciliation_required' as const, operationId: 'op-reconcile',
          error: 'file generation changed',
        };
      }
      const parsed = JSON.parse(text) as BackupData;
      state.companies = [{ id: companyId, legalName: parsed.manifest.companyInfo.legalName }];
      const audit = (parsed.data.auditLogs ?? []).map((row) => {
        const userId = typeof row.userId === 'string' ? identityMap[row.userId] ?? row.userId : row.userId;
        return { ...row, userId };
      });
      // Same-installation recovery: an id the destination already retains is
      // REUSED as stored (never inserted twice, never rewritten); admission of
      // that reuse is decided by validateRestoreDestination.
      const retainedIds = new Set(state.audits.map((row) => String(row.id)));
      const incoming = plan.mode === 'reuse-retained' || plan.mode === 'keep-conflict'
        ? audit.filter((row) => !retainedIds.has(String(row.id)))
        : audit;
      state.audits = plan.mode === 'drop-history' ? [] : [...state.audits, ...incoming];
      if (plan.mode === 'rewrite-history') {
        const row = state.audits.find((entry) => entry.id === 'audit-1');
        if (row) row.details = 'rewritten during replacement';
      }
      state.journals = [...state.journals, ...(parsed.data.journalEntries ?? [])];
      state.audits.push({
        id: 'op-committed', companyId, userId: null, action: 'COMPANY_RESTORE_COMMITTED',
        entity: 'Backup', entityId: null, details: null, hash: null, previousHash: null,
        createdAt: NOW.toISOString(),
      });
      return {
        status: 'committed' as const, operationId: 'op-committed',
        counts: parsed.manifest.recordCounts,
      };
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
    text: '', snapshot, deps, store, lock, mail, provenance, clock, restoreCalls,
    dbState: state, plan, deletedUsers,
  } as unknown as Flow;
}

async function challenge(f: Flow, password = SOURCE_PASSWORD) {
  f.text = portableFile(f.snapshot);
  const result = await requestPortableRecoveryChallenge(f.deps, {
    fileText: f.text, password, companyLegalName: COMPANY_LEGAL_NAME, ownerEmail: OWNER.email,
  });
  expect(result.status).toBe('challenge_sent');
  return f.mail.at(-1)!.token;
}

function complete(f: Flow, token: string, overrides: Partial<{
  password: string; companyLegalName: string; fileText: string; ownerEmail: string;
}> = {}) {
  return completePortableRecovery(f.deps, {
    fileText: overrides.fileText ?? f.text,
    password: overrides.password ?? SOURCE_PASSWORD,
    companyLegalName: overrides.companyLegalName ?? COMPANY_LEGAL_NAME,
    ownerEmail: overrides.ownerEmail ?? OWNER.email,
    token,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('authorized bootstrap recovery', () => {
  it('restores once with a valid token and records authenticated provenance', async () => {
    const f = flow();
    const token = await challenge(f);
    const result = await complete(f, token);

    expect(result).toMatchObject({ status: 'restored', operationId: 'op-committed', sessionUserId: OWNER.id });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(f.restoreCalls).toHaveLength(1);
    expect(f.dbState.companies).toHaveLength(1);
    expect(f.dbState.users).toHaveLength(1);
    expect(f.dbState.users[0]).toMatchObject({ id: OWNER.id, email: OWNER.email, platformRole: 'super_admin' });
    expect(f.dbState.members).toEqual([
      expect.objectContaining({ userId: OWNER.id, companyId: COMPANY_ID, role: 'company_admin' }),
    ]);
    const record = f.provenance.records[0] as Record<string, any>;
    expect(record.companyId).toBe(COMPANY_ID);
    expect(record.ownerUserId).toBe(OWNER.id);
    expect(record.fileDigest).toBe(crypto.createHash('sha256').update(f.text, 'utf8').digest('hex'));
    expect(record.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(record.historyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(record.identityMap).toEqual({});
    expect(record.trustBoundary).toMatch(/never re-signed/i);
    expect(JSON.stringify(record)).not.toContain(token);
    expect(JSON.stringify(record)).not.toContain(SOURCE_PASSWORD);
    expect(f.store.describe().challenges[0].usedAt).not.toBeNull();
    expect(f.lock.describe()).toBeNull();
    expect(f.plan.closeCalls).toBe(0);
  });

  it('consumes the token before the restore so a failed or uncertain restore cannot replay', async () => {
    const f = flow();
    const token = await challenge(f);
    let consumedAtRestore: Date | null = null;
    const original = f.deps.restore;
    f.deps.restore = async (input) => {
      consumedAtRestore = f.store.describe().challenges[0].usedAt;
      return original(input);
    };
    await complete(f, token);
    expect(consumedAtRestore).not.toBeNull();

    // The installation is no longer empty, so the replay is refused before any
    // token or password work happens again.
    const replay = await complete(f, token);
    expect(replay).toMatchObject({ status: 409, code: 'DB_NOT_EMPTY' });
    expect(f.restoreCalls).toHaveLength(1);
  });

  it('safely reuses a local account with the same email but a different id (S4)', async () => {
    const localId = 'user-local-registered';
    const f = flow({
      users: [{
        ...userRow(localId, OWNER.email),
        platformRole: 'user',
        passwordHash: passwordHashOf(SOURCE_PASSWORD),
        emailVerifiedAt: new Date('2026-02-01T00:00:00.000Z'),
      }],
    }, makeSnapshot({
      auditLogs: [{ ...auditRow('audit-owner', COMPANY_ID, null), userId: OWNER.id }],
    }));
    const token = await challenge(f);
    const result = await complete(f, token, { password: SOURCE_PASSWORD });

    expect(result).toMatchObject({ status: 'restored', sessionUserId: localId });
    expect(f.restoreCalls[0].identityMap).toEqual({ [OWNER.id]: localId });
    // The local account keeps its own credentials, role and verification state.
    const local = f.dbState.users.find((user) => user.id === localId)!;
    expect(local.passwordHash).toBe(passwordHashOf(SOURCE_PASSWORD));
    expect(local.platformRole).toBe('user');
    expect(local.emailVerifiedAt).toEqual(new Date('2026-02-01T00:00:00.000Z'));
    expect(f.dbState.users).toHaveLength(1);
    expect(f.dbState.members[0]).toMatchObject({ userId: localId, companyId: COMPANY_ID });
    // The historical row keeps its stored hash and follows the explicit mapping.
    const archived = f.dbState.audits.find((row) => row.id === 'audit-owner')!;
    expect(archived.userId).toBe(localId);
    expect(archived.hash).toBe(auditRow('audit-owner', COMPANY_ID, null).hash);
    const record = f.provenance.records[0] as Record<string, any>;
    expect(record.identityMap).toEqual({ [OWNER.id]: localId });
    expect(record.auditEvidence).toHaveLength(1);
  });

  it('refuses reuse until the local account password is proven', async () => {
    const f = flow({
      users: [{
        ...userRow('user-local-registered', OWNER.email),
        platformRole: 'user',
        passwordHash: passwordHashOf('local-account-password'),
      }],
    });
    const token = await challenge(f);
    const result = await complete(f, token);
    expect(result).toMatchObject({ status: 409, code: 'RECOVERY_LOCAL_ACCOUNT_LOGIN_REQUIRED' });
    // F7: the refusal is pinned to the truthful guidance — the same password must
    // open the backup AND the local account — instead of the old, false advice to
    // "sign in with that account".
    const message = (result as { message?: string }).message ?? '';
    expect(message).toMatch(/same password/i);
    expect(message).toMatch(/change it to the password that opens the backup/i);
    expect(message).not.toMatch(/sign in with that account/i);
    expect(f.dbState.companies).toHaveLength(0);
    expect(f.dbState.users).toHaveLength(1);
    expect(f.restoreCalls).toHaveLength(0);
    expect(f.provenance.records).toHaveLength(0);
  });

  it('never takes over another identity with the same email and different credentials', async () => {
    const f = flow({
      users: [{
        ...userRow('someone-else', OWNER.email),
        platformRole: 'user',
        passwordHash: passwordHashOf('someone-elses-password'),
      }],
    });
    const token = await challenge(f);
    const result = await complete(f, token);
    expect(result).toMatchObject({ status: 409, code: 'RECOVERY_LOCAL_ACCOUNT_LOGIN_REQUIRED' });
    expect(f.dbState.users[0].id).toBe('someone-else');
    expect(f.restoreCalls).toHaveLength(0);
  });

  it('discards only rows it created when the restore refuses before mutating', async () => {
    const f = flow();
    f.dbState.users.push({ ...userRow(OWNER.id, OWNER.email), passwordHash: '$2a$12$local-kept' });
    f.plan.mode = 'throw';
    const token = await challenge(f);
    const result = await complete(f, token);

    expect(result).toMatchObject({ status: 400, code: 'RECOVERY_RESTORE_REFUSED' });
    expect(f.dbState.companies).toHaveLength(0);
    expect(f.dbState.members).toHaveLength(0);
    expect(f.dbState.users).toHaveLength(1);
    expect(f.dbState.users[0].passwordHash).toBe('$2a$12$local-kept');
    expect(f.deletedUsers).toEqual([]);
    expect(f.provenance.records).toHaveLength(0);
    // The token stays spent: recovery must be re-authorized, never replayed.
    expect(f.store.describe().challenges[0].usedAt).not.toBeNull();
    expect(f.lock.describe()).toBeNull();
  });

  it('never deletes a shell company that already received business data', async () => {
    const f = flow();
    f.plan.mode = 'throw';
    const token = await challenge(f);
    const original = f.deps.restore;
    f.deps.restore = async (input) => {
      const result = await original(input);
      return result;
    };
    const result = await complete(f, token);
    expect(result).toMatchObject({ status: 400, code: 'RECOVERY_RESTORE_REFUSED' });
    expect(f.dbState.companies).toHaveLength(0);
  });

  it('reports reconciliation, keeps the lease and records nothing when the outcome is uncertain', async () => {
    const f = flow();
    f.plan.mode = 'reconcile';
    const token = await challenge(f);
    const result = await complete(f, token);
    expect(result).toMatchObject({ status: 'reconciliation_required', operationId: 'op-reconcile' });
    expect(f.provenance.records).toHaveLength(0);
    // Uncertain outcome: the shell is never deleted (it may be the evidence)
    // and the recovery lease stays held until it expires.
    expect(f.dbState.users).toHaveLength(1);
    expect(f.deletedUsers).toEqual([]);
    expect(f.lock.describe()).not.toBeNull();
  });

  it('rejects lost or rewritten source history and re-closes maintenance', async () => {
    const f = flow({}, makeSnapshot({ auditLogs: [auditRow('audit-1', COMPANY_ID, null)] }));
    f.plan.mode = 'drop-history';
    const token = await challenge(f);
    const result = await complete(f, token);
    expect(result).toMatchObject({ status: 'reconciliation_required', code: 'RECOVERY_HISTORY_LOST' });
    expect(f.provenance.records).toHaveLength(0);
    expect(f.plan.closeCalls).toBe(1);
  });

  it('rejects a rewritten archived row instead of exempting it', async () => {
    const f = flow({}, makeSnapshot({ auditLogs: [auditRow('audit-1', COMPANY_ID, null)] }));
    f.plan.mode = 'rewrite-history';
    const token = await challenge(f);
    const result = await complete(f, token);
    expect(result).toMatchObject({ status: 'reconciliation_required', code: 'RECOVERY_HISTORY_LOST' });
    expect(f.plan.closeCalls).toBe(1);
  });

  it('archives the stored retained digest when an identical audit event is reused', async () => {
    // Same-installation recovery: the destination already holds this very event
    // (its company was deleted, the audit row outlived it).
    const shared = auditRow('audit-shared', COMPANY_ID, null);
    const f = flow(
      { audits: [{ ...shared }] },
      makeSnapshot({ auditLogs: [{ ...shared }] }),
    );
    f.plan.mode = 'reuse-retained';
    const token = await challenge(f);
    const result = await complete(f, token);
    expect(result).toMatchObject({ status: 'restored' });
    // Exactly one copy of the event: reused, not duplicated.
    expect(f.dbState.audits.filter((row) => String(row.id) === 'audit-shared')).toHaveLength(1);
    // The archive evidence is the digest of the STORED (retained) row, which is
    // the authenticated event's canonical content.
    const record = f.provenance.records[0] as Record<string, any>;
    expect(record.auditEvidence).toEqual([
      { id: 'audit-shared', digest: auditHistoryDigestOf(shared as never) },
    ]);
    expect(f.plan.closeCalls).toBe(0);
  });

  it('archives the stored digest plus the explicit source attribution of a nulled reference', async () => {
    // This installation sealed the event with its owner reference. Deleting that
    // account under the LEGACY foreign key (ON DELETE SET NULL) erased the
    // reference; the stored HMAC still covers the ORIGINAL payload.
    const signed = {
      id: 'audit-owner-bound', companyId: COMPANY_ID, userId: OWNER.id, action: 'JOURNAL_POSTED',
      entity: 'JournalEntry', entityId: 'entry-1', details: null, previousHash: null,
    };
    const sealed = { ...signed, createdAt: '2026-01-05T10:00:00.000Z', hash: computeAuditHash(signed) };
    const drifted = { ...sealed, userId: null };
    const f = flow({ audits: [{ ...drifted }] }, makeSnapshot({ auditLogs: [{ ...sealed }] }));
    f.plan.mode = 'reuse-retained';
    const token = await challenge(f);
    const result = await complete(f, token);
    expect(result).toMatchObject({ status: 'restored' });

    // One copy of the event, byte-identical to what the deletion left behind.
    const copies = f.dbState.audits.filter((row) => String(row.id) === 'audit-owner-bound');
    expect(copies).toHaveLength(1);
    expect(copies[0].userId).toBeNull();
    expect(copies[0].hash).toBe(sealed.hash);

    // The archive keeps the ACTUAL stored digest (never the source row rewritten
    // as if the null had been signed) and records the verified attribution.
    const record = f.provenance.records[0] as Record<string, any>;
    expect(record.auditEvidence).toEqual([{
      id: 'audit-owner-bound',
      digest: auditHistoryDigestOf(drifted as never),
      projectedUserId: OWNER.id,
    }]);
    expect(f.plan.closeCalls).toBe(0);
  });

  it('refuses to certify a same-id retained row that is not the authenticated event', async () => {
    const shared = auditRow('audit-shared', COMPANY_ID, null);
    // The retained row keeps the source id but is a DIFFERENT event.
    const f = flow(
      { audits: [{ ...shared, details: 'a different event' }] },
      makeSnapshot({ auditLogs: [{ ...shared }] }),
    );
    f.plan.mode = 'keep-conflict';
    const token = await challenge(f);
    const result = await complete(f, token);
    expect(result).toMatchObject({ status: 'reconciliation_required', code: 'RECOVERY_HISTORY_CONFLICT' });
    expect(f.provenance.records).toHaveLength(0);
    expect(f.plan.closeCalls).toBe(1);
  });

  it('re-closes maintenance when provenance cannot be written', async () => {
    const f = flow();
    const token = await challenge(f);
    f.provenance.recorder.record = async () => { throw new Error('provenance storage unavailable'); };
    const result = await complete(f, token);
    expect(result).toMatchObject({ status: 'reconciliation_required', code: 'RECOVERY_PROVENANCE_MISSING' });
    expect(f.plan.closeCalls).toBe(1);
  });

  it('refuses an expired or foreign token without touching the installation', async () => {
    const f = flow();
    const token = await challenge(f);
    f.clock.now = new Date(NOW.getTime() + RECOVERY_POLICY.tokenMs + 1000);
    expect(await complete(f, token)).toMatchObject({ status: 400, code: 'RECOVERY_TOKEN_EXPIRED' });
    expect(f.restoreCalls).toHaveLength(0);
    expect(f.dbState.companies).toHaveLength(0);

    const other = flow();
    const otherToken = await challenge(other);
    const another = portableFile(makeSnapshot({
      auditLogs: [auditRow('audit-other', COMPANY_ID, null)],
    }));
    expect(await complete(other, otherToken, { fileText: another }))
      .toMatchObject({ status: 400, code: 'RECOVERY_TOKEN_INVALID' });
    expect(other.restoreCalls).toHaveLength(0);
  });

  it('refuses a replayed password guess without consuming the token', async () => {
    const f = flow();
    const token = await challenge(f);
    const wrong = await complete(f, token, { password: 'wrong-password-again' });
    expect(wrong).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
    expect(f.store.describe().challenges[0].usedAt).toBeNull();
    expect(f.restoreCalls).toHaveLength(0);
  });

  it('refuses a wrong owner email at completion without consuming the token', async () => {
    const f = flow();
    const token = await challenge(f);
    // The owner email is an input of the file KDF: a wrong one cannot open it.
    const wrong = await complete(f, token, { ownerEmail: 'otra-persona@example.test' });
    expect(wrong).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
    expect(f.store.describe().challenges[0].usedAt).toBeNull();
    expect(f.restoreCalls).toHaveLength(0);
  });

  it('restores journal history recovered under a different source key', async () => {
    const sourceSnapshot = withEnv({ HMAC_SECRET: 'source-hmac-secret' }, () => makeSnapshot({
      auditLogs: [auditRow('audit-1', COMPANY_ID, null, 'source-hmac-secret')],
      journalEntries: [{
        id: 'entry-1', companyId: COMPANY_ID, date: '2026-01-05T10:00:00.000Z',
        description: 'Asiento de origen', reference: null, status: 'posted',
        hash: crypto.createHmac('sha256', 'source-hmac-secret').update('entry:entry-1').digest('hex'),
        previousHash: null, hashVersion: 'v2', lines: [{ glAccountId: 'gl-1', debit: '100.00', credit: '0.00', description: 'sale' }],
      }],
    }));
    const f = flow({}, sourceSnapshot);
    const token = await challenge(f);
    const result = withEnv({ HMAC_SECRET: 'destination-hmac-secret' }, async () => complete(f, token));
    expect(await result).toMatchObject({ status: 'restored' });
    const stored = f.dbState.audits.find((row) => row.id === 'audit-1')!;
    expect(stored.hash).toBe(sourceSnapshot.data.auditLogs![0].hash);
    expect(stored.previousHash).toBe(null);
    const journal = f.dbState.journals.find((row) => row.id === 'entry-1')!;
    expect(journal.hash).toBe(sourceSnapshot.data.journalEntries![0].hash);
    const record = f.provenance.records[0] as Record<string, any>;
    expect(record.auditEvidence).toHaveLength(1);
    expect(record.journalEvidence).toHaveLength(1);
  });
});

describe('destination preparation failures', () => {
  it('does not delete anything when the preparation transaction rolls back', async () => {
    const { client, state } = fakeClient();
    const deleted: string[] = [];
    // The transaction commits statements and THEN fails: Prisma semantics mean
    // nothing was committed, so the restore must not run any cleanup.
    const failing = {
      ...client,
      $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
        await work(failing);
        throw new Error('could not serialize access due to concurrent update');
      },
      user: {
        ...client.user,
        deleteMany: async (query: { where: Record<string, unknown> }) => {
          deleted.push(String(query.where.id));
          return { count: 0 };
        },
      },
    };
    const restore = createPortableDestinationRestore({
      client: failing,
      provenance: fakeProvenance().recorder,
      now: () => NOW,
      hashPassword: async (password) => passwordHashOf(password),
      verifyPassword: async () => false,
      coordinatedRestore: async () => ({ status: 'committed', operationId: 'never' }),
    });
    const result: PortableRestoreResult = await restore({
      snapshot: makeSnapshot(),
      fileText: 'x',
      fileDigest: 'f'.repeat(64),
      payloadDigest: 'p'.repeat(64),
      ownerUserId: OWNER.id,
      ownerEmail: OWNER.email,
      ownerPassword: SOURCE_PASSWORD,
    });
    expect(result).toMatchObject({ status: 'refused', code: 'RECOVERY_PREPARE_FAILED' });
    // The transaction rolled back, so no cleanup ran. (The in-memory fake keeps
    // the statements, which is exactly why cleanup must NOT trust them.)
    expect(deleted).toEqual([]);
    expect(state.companies).toHaveLength(1);
  });

  it('rechecks emptiness under the advisory lock inside the transaction', async () => {
    const locked: string[] = [];
    const { client } = fakeClient({ companies: [{ id: 'existing-company' }] });
    const extended = {
      ...client,
      $queryRawUnsafe: async <T = unknown>(query: string) => {
        locked.push(query);
        return [] as unknown as T;
      },
    };
    const restore = createPortableDestinationRestore({
      client: {
        ...extended,
        $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(extended),
      },
      provenance: fakeProvenance().recorder,
      now: () => NOW,
      hashPassword: async (password) => passwordHashOf(password),
      verifyPassword: async () => false,
      coordinatedRestore: async () => ({ status: 'committed', operationId: 'never' }),
    });
    const result = await restore({
      snapshot: makeSnapshot(),
      fileText: 'x',
      fileDigest: 'f'.repeat(64),
      payloadDigest: 'p'.repeat(64),
      ownerUserId: OWNER.id,
      ownerEmail: OWNER.email,
      ownerPassword: SOURCE_PASSWORD,
    });
    expect(result).toMatchObject({ status: 'refused', code: 'DB_NOT_EMPTY' });
    expect(locked.join(' ')).toContain('pg_advisory_xact_lock');
  });
});
