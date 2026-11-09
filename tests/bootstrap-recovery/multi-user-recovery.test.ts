/**
 * F1 / S2, S4, S15, S17 — a MULTI-USER backup must be recoverable on a fresh
 * machine.
 *
 * `validateRestoreDestination` (correctly, for a local replacement) requires every
 * source `User` row to exist here with its own id+email. Portable recovery only
 * recreated the OWNER, so a backup that also carried a member account was refused
 * with `RESTORE_MISSING_IDENTITY` on a brand-new installation — the reported
 * blocker: the operator could never recover the accounting of their own company
 * because somebody else's account happened to be in it.
 *
 * The fix belongs to the PREPARE transaction, not to the validator: every source
 * user that is absent from the destination is recreated there, inside the same
 * locked transaction that creates the owner shell, so the destination read-set a
 * moment later already contains them and the strict id+email contract is honored.
 *
 * Pinned here (every case through the real workflow and the real validator):
 *  (a) owner + member recovered on a truly empty installation: BOTH accounts exist
 *      afterwards, the member keeps a non-elevated platform role, and its tenant
 *      role comes from the restored membership row;
 *  (b) a pre-existing LOCAL account with the member's email is reused through the
 *      explicit identity map — byte-identical, never re-hashed, never elevated;
 *  (c) a second source super administrator does NOT come back as super_admin (the
 *      backup alone never grants global authority);
 *  (d) an identity that cannot be resolved (the source id already belongs to a
 *      DIFFERENT person here, and no account holds the source email) is refused
 *      with nothing created, nothing restored and no provenance recorded;
 *  (e) retained audit attribution follows the mapping and is never re-signed.
 *
 * Synthetic identities only (`@example.test`); in-memory storage; no database.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryRecoveryChallengeStore, completePortableRecovery, requestPortableRecoveryChallenge,
  type PortableRecoveryDeps,
} from '@/lib/backup-recovery-auth';
import { createMemoryRecoveryLockStore } from '@/lib/backup-recovery-lock';
import { createPortableDestinationRestore } from '@/lib/backup-recovery-provenance';
import { RESTORE_MODELS, validateRestoreDestination, type Row, type Tables } from '@/lib/backup-validation';
import {
  COMPANY_ID, COMPANY_LEGAL_NAME, OWNER, SOURCE_PASSWORD,
  auditRow, fakeClient, fakeProvenance, makeSnapshot, memberRow, portableFile, userRow,
} from './helpers';
import type { BackupData } from '@/lib/backup';
import type { RecoveryArchive } from '@/lib/journal-hash';

const NOW = new Date('2026-06-01T08:00:00.000Z');
const MEMBER = { id: 'user-member-origin', email: 'member@example.test' };
const LOCAL_MEMBER_ID = 'user-local-member';
const RECEIPT_ID = 'op-recovery-committed';

const hashPassword = async (password: string) => `synthetic-hash:${password}`;
const verifyPassword = async (password: string, hash: string) =>
  hash === `synthetic-hash:${password}`;

function emptyTables(): Tables {
  return Object.fromEntries(Object.values(RESTORE_MODELS).map((model) => [model, [] as Row[]]));
}

function sourceTables(snapshot: BackupData): Tables {
  const tables = emptyTables();
  tables.Company = (snapshot.data.company ?? []) as Row[];
  tables.User = (snapshot.data.users ?? []) as Row[];
  tables.CompanyMember = (snapshot.data.companyMembers ?? []) as Row[];
  tables.AuditLog = ((snapshot.data.auditLogs ?? []) as Row[]).map((row) => ({ ...row }));
  tables.JournalEntry = (snapshot.data.journalEntries ?? []) as Row[];
  return tables;
}

function destinationTables(state: {
  users: Row[]; companies: Row[]; members: Row[]; audits: Row[];
}): Tables {
  const tables = emptyTables();
  tables.Company = state.companies.map((row) => ({ entityType: 'BUSINESS', taxId: null, ...row }));
  tables.User = state.users.map((row) => ({ ...row }));
  tables.CompanyMember = state.members.map((row) => ({ ...row }));
  tables.AuditLog = state.audits.map((row) => ({ ...row }));
  return tables;
}

interface Flow {
  deps: PortableRecoveryDeps;
  provenance: ReturnType<typeof fakeProvenance>;
  mail: Array<{ to: string; token: string }>;
  state: ReturnType<typeof fakeClient>['state'];
  restoreCalls: Array<{ identityMap: Record<string, string> }>;
  snapshot: BackupData;
  text: string;
}

/**
 * Real prepare + real admission decision. The in-memory client emulates a
 * transaction ROLLBACK, so "nothing was created" is an observable claim.
 */
function flow(options: {
  seed?: Parameters<typeof fakeClient>[0];
  snapshot?: BackupData;
  archive?: () => Promise<RecoveryArchive | undefined>;
} = {}): Flow {
  const snapshot = options.snapshot ?? makeSnapshot();
  const { client, state } = fakeClient(options.seed ?? {});
  const provenance = fakeProvenance();
  const mail: Flow['mail'] = [];
  const restoreCalls: Flow['restoreCalls'] = [];

  const clone = () => JSON.parse(JSON.stringify({
    users: state.users, companies: state.companies, members: state.members,
    audits: state.audits, journals: state.journals,
  })) as { users: Row[]; companies: Row[]; members: Row[]; audits: Row[]; journals: Row[] };

  const transactional = {
    ...client,
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      const before = clone();
      try {
        return await work(transactional);
      } catch (error) {
        state.users = before.users;
        state.companies = before.companies;
        state.members = before.members;
        state.audits = before.audits;
        state.journals = before.journals;
        throw error;
      }
    },
  };

  const restore = createPortableDestinationRestore({
    client: transactional as unknown as Parameters<typeof createPortableDestinationRestore>[0]['client'],
    provenance: provenance.recorder,
    now: () => NOW,
    hashPassword,
    verifyPassword,
    readAuditArchive: options.archive,
    coordinatedRestore: async (companyId, text, settings, identityMap) => {
      restoreCalls.push({ identityMap });
      const parsed = JSON.parse(text) as BackupData;
      // The REAL admission decision, exactly as the production coordinator runs it.
      const decision = validateRestoreDestination(
        sourceTables(parsed), destinationTables(state), companyId, true, identityMap,
        settings.auditArchive ? { auditArchive: settings.auditArchive } : {},
      );
      const map = <T extends Row>(rows: T[]): T[] => rows.map((row) => {
        const mapped = typeof row.userId === 'string' ? identityMap[row.userId] : undefined;
        return mapped && mapped !== row.userId ? { ...row, userId: mapped } : { ...row };
      });
      state.companies = [{ id: companyId, legalName: parsed.manifest.companyInfo.legalName }];
      state.members = map((parsed.data.companyMembers ?? []) as Row[]);
      state.audits = [
        ...state.audits,
        ...map(((parsed.data.auditLogs ?? []) as Row[])).filter((row) => !decision.auditReuse.has(String(row.id))),
        {
          id: RECEIPT_ID, companyId, userId: null, action: 'COMPANY_RESTORE_COMMITTED',
          entity: 'Backup', entityId: null, details: null, hash: null, previousHash: null,
          createdAt: NOW.toISOString(),
        },
      ];
      return { status: 'committed' as const, operationId: RECEIPT_ID, counts: parsed.manifest.recordCounts };
    },
  });

  const deps: PortableRecoveryDeps = {
    now: () => NOW,
    challenges: createMemoryRecoveryChallengeStore(),
    lock: createMemoryRecoveryLockStore(),
    mail: { send: async (message) => { mail.push(message as unknown as Flow['mail'][number]); } },
    installationState: async () => ({ companies: state.companies.length, audits: state.audits.length }),
    restore,
  };

  return { deps, provenance, mail, state, restoreCalls, snapshot, text: portableFile(snapshot) };
}

async function recover(f: Flow) {
  const requested = await requestPortableRecoveryChallenge(f.deps, {
    fileText: f.text,
    password: SOURCE_PASSWORD,
    companyLegalName: COMPANY_LEGAL_NAME,
    ownerEmail: OWNER.email,
  });
  expect(requested.status, JSON.stringify(requested)).toBe('challenge_sent');
  return completePortableRecovery(f.deps, {
    fileText: f.text,
    password: SOURCE_PASSWORD,
    companyLegalName: COMPANY_LEGAL_NAME,
    ownerEmail: OWNER.email,
    token: f.mail.at(-1)!.token,
  });
}

/** owner + member backup: two accounts, two memberships, one attributed row. */
function multiUserSnapshot(extra: { memberRole?: string } = {}) {
  const memberAudit = { ...auditRow('audit-member', COMPANY_ID, null), userId: MEMBER.id };
  return makeSnapshot({
    users: [
      userRow(OWNER.id, OWNER.email, 'super_admin'),
      userRow(MEMBER.id, MEMBER.email, 'user'),
    ],
    companyMembers: [
      memberRow('member-owner', OWNER.id, COMPANY_ID, 'company_admin'),
      memberRow('member-staff', MEMBER.id, COMPANY_ID, extra.memberRole ?? 'employee'),
    ],
    auditLogs: [memberAudit],
  });
}

describe('a multi-user backup is recoverable on a fresh machine (F1)', () => {
  it('recreates the owner AND the member account, then admits the replacement', async () => {
    const f = flow({ snapshot: multiUserSnapshot() });
    expect(f.state.users).toHaveLength(0);

    const result = await recover(f);
    expect(result.status, JSON.stringify(result)).toBe('restored');

    // BOTH accounts exist, with the expected (non-elevated) global roles.
    const owner = f.state.users.find((user) => user.id === OWNER.id);
    const member = f.state.users.find((user) => user.id === MEMBER.id);
    expect(owner).toMatchObject({ email: OWNER.email, platformRole: 'super_admin' });
    expect(member).toMatchObject({ email: MEMBER.email, platformRole: 'user' });
    expect(f.state.users).toHaveLength(2);

    // The recreated account carries NO usable credential from the backup.
    expect(String(member!.passwordHash)).not.toContain(SOURCE_PASSWORD);
    expect(member!.emailVerifiedAt).toBeNull();

    // Same source ids ⇒ no identity remapping was needed for the member.
    expect(f.restoreCalls[0].identityMap).toEqual({});

    // The tenant role comes from the restored membership row, not from the user.
    expect(f.state.members).toHaveLength(2);
    expect(f.state.members.find((row) => row.userId === MEMBER.id))
      .toMatchObject({ companyId: COMPANY_ID, role: 'employee' });

    // Audit attribution is preserved verbatim (same id, same stored hash).
    const archived = f.state.audits.find((row) => row.id === 'audit-member')!;
    expect(archived.userId).toBe(MEMBER.id);
    expect(archived.hash).toBe(auditRow('audit-member', COMPANY_ID, null).hash);

    const record = f.provenance.records[0] as Record<string, unknown>;
    expect(record).toMatchObject({ ownerUserId: OWNER.id, identityMap: {} });
  });

  it('never grants global authority to a second source super administrator', async () => {
    const snapshot = makeSnapshot({
      users: [
        userRow(OWNER.id, OWNER.email, 'super_admin'),
        userRow(MEMBER.id, MEMBER.email, 'super_admin'),
      ],
      companyMembers: [
        memberRow('member-owner', OWNER.id, COMPANY_ID, 'company_admin'),
        memberRow('member-staff', MEMBER.id, COMPANY_ID, 'employee'),
      ],
    });
    const f = flow({ snapshot });
    expect((await recover(f)).status).toBe('restored');

    expect(f.state.users.find((user) => user.id === MEMBER.id)?.platformRole).toBe('user');
    // The owner role is authorized by password + email token, so it is kept.
    expect(f.state.users.find((user) => user.id === OWNER.id)?.platformRole).toBe('super_admin');
  });

  it('reuses a pre-existing local account with the member email byte-identically', async () => {
    const local = {
      ...userRow(LOCAL_MEMBER_ID, MEMBER.email, 'user'),
      passwordHash: 'synthetic-hash:local-account-password',
      emailVerifiedAt: new Date('2026-02-01T00:00:00.000Z'),
      legacyUser: false,
    };
    const f = flow({ seed: { users: [{ ...local }] }, snapshot: multiUserSnapshot() });
    const before = JSON.stringify(local);

    const result = await recover(f);
    expect(result.status, JSON.stringify(result)).toBe('restored');

    // The explicit mapping is recorded for the member identity…
    expect(f.restoreCalls[0].identityMap).toEqual({ [MEMBER.id]: LOCAL_MEMBER_ID });
    const record = f.provenance.records[0] as Record<string, unknown>;
    expect(record.identityMap).toEqual({ [MEMBER.id]: LOCAL_MEMBER_ID });

    // …the local account is byte-identical (no re-hash, no promotion)…
    const stored = f.state.users.find((user) => user.id === LOCAL_MEMBER_ID)!;
    expect(JSON.stringify(stored)).toBe(before);
    expect(f.state.users.some((user) => user.id === MEMBER.id)).toBe(false);

    // …and every reference follows the mapping, including the stored audit row.
    expect(f.state.members.find((row) => row.userId === LOCAL_MEMBER_ID))
      .toMatchObject({ companyId: COMPANY_ID, role: 'employee' });
    const archived = f.state.audits.find((row) => row.id === 'audit-member')!;
    expect(archived.userId).toBe(LOCAL_MEMBER_ID);
    // Never re-signed: the stored hash stays the SOURCE one.
    expect(archived.hash).toBe(auditRow('audit-member', COMPANY_ID, null).hash);
  });

  it('refuses an unresolvable identity and creates nothing at all', async () => {
    // The source member id already belongs to a DIFFERENT person here, and no
    // local account holds the member email: no honest answer is possible.
    const squatter = {
      ...userRow(MEMBER.id, 'someone-else@example.test', 'user'),
      passwordHash: 'synthetic-hash:someone-elses-password',
    };
    const f = flow({ seed: { users: [{ ...squatter }] }, snapshot: multiUserSnapshot() });
    const usersBefore = JSON.stringify(f.state.users);

    const result = await recover(f);
    expect(result).toMatchObject({ status: 409, code: 'RECOVERY_IDENTITY_CONFLICT' });

    // Rolled back, nothing invented, no restore attempted, nothing certified.
    expect(JSON.stringify(f.state.users)).toBe(usersBefore);
    expect(f.state.users).toHaveLength(1);
    expect(f.state.companies).toHaveLength(0);
    expect(f.state.members).toHaveLength(0);
    expect(f.state.audits).toHaveLength(0);
    expect(f.restoreCalls).toHaveLength(0);
    expect(f.provenance.records).toHaveLength(0);
  });
});
