import { describe, expect, it } from 'vitest';
import {
  createPortableDestinationRestore,
  type PortableDestinationTarget,
  type PortableRestoreRequest,
} from '@/lib/backup-recovery-provenance';
import {
  COMPANY_ID, COMPANY_LEGAL_NAME, OWNER, SOURCE_PASSWORD,
  companyRow, fakeClient, fakeProvenance, makeSnapshot, memberRow, userRow,
} from './helpers';
import type { BackupData } from '@/lib/backup';
import { auditHistoryDigestOf, computeAuditHash } from '@/lib/journal-hash';
import {
  RESTORE_MODELS, validateRestoreDestination, type Row, type Tables,
} from '@/lib/backup-validation';

/**
 * Destination mode of the portable engine (S23 / S24).
 *
 * `createPortableDestinationRestore` used to describe ONE shape: an empty
 * installation that receives the backup's own company. The two session-scoped
 * doors need the SAME prepare, admission and post-commit proof around a
 * company-scoped destination:
 *  - S23 (Administración de Empresas): the backup's company is created when it
 *    is absent, and refused when the installation already has it (that case
 *    belongs to the settings door, which replaces instead of adding);
 *  - S24 (Configuración → Respaldos): the ACTIVE company is the target and its
 *    data is replaced.
 * The zero-installation contract stays byte-identical when no target is given.
 */

const NOW = new Date('2026-03-02T09:00:00.000Z');
const passwordHashOf = (password: string) => `hashed:${password}`;

type Client = Parameters<typeof createPortableDestinationRestore>[0]['client'];

interface Case {
  restore: (request: PortableRestoreRequest) => ReturnType<ReturnType<typeof createPortableDestinationRestore>>;
  request: PortableRestoreRequest;
  state: ReturnType<typeof fakeClient>['state'];
  records: Array<Record<string, unknown>>;
  restoreCalls: Array<{ companyId: string; text: string; mode: unknown; identityMap: Record<string, string> }>;
}

function setup(
  seed: Parameters<typeof fakeClient>[0],
  snapshot: BackupData,
  target?: PortableDestinationTarget,
): Case {
  const { client, state } = fakeClient(seed);
  const provenance = fakeProvenance();
  const restoreCalls: Case['restoreCalls'] = [];
  const restore = createPortableDestinationRestore({
    client: client as unknown as Client,
    provenance: provenance.recorder,
    now: () => NOW,
    hashPassword: async (password: string) => passwordHashOf(String(password)),
    verifyPassword: async (password: string, hash: string) => hash === passwordHashOf(password),
    ...(target ? { target } : {}),
    coordinatedRestore: async (companyId, text, mode, identityMap) => {
      restoreCalls.push({ companyId, text, mode, identityMap });
      const parsed = JSON.parse(text) as BackupData;
      // The coordinated replacement owns company-scoped DATA. `AuditLog` is not
      // company-scoped data: no `auditLog.deleteMany` exists anywhere in the
      // application, so a target-company audit row survives the replacement and a
      // reused id is skipped instead of re-inserted (T42).
      state.companies = state.companies.map((company) =>
        company.id === companyId ? { ...company, legalName: parsed.manifest.companyInfo.legalName } : company);
      state.journals = [...state.journals.filter((row) => row.companyId !== companyId), ...(parsed.data.journalEntries ?? [])];
      state.audits.push({
        id: 'op-committed', companyId, userId: null, action: 'COMPANY_RESTORE_COMMITTED',
        entity: 'Backup', entityId: null, details: null, hash: null, previousHash: null,
        createdAt: NOW.toISOString(),
      });
      return {
        status: 'committed' as const,
        operationId: 'op-committed',
        counts: parsed.manifest.recordCounts,
      };
    },
  });
  return {
    restore: restore as unknown as Case['restore'],
    state,
    records: provenance.records,
    restoreCalls,
    request: {
      snapshot,
      fileText: 'portable-container-text',
      fileDigest: 'file-digest-1',
      payloadDigest: 'payload-digest-1',
      ownerUserId: OWNER.id,
      ownerEmail: OWNER.email,
      ownerPassword: SOURCE_PASSWORD,
    },
  };
}

/** The owner already exists locally: both new doors are session-authenticated. */
const existingOwner = () => [userRow(OWNER.id, OWNER.email) as unknown as Record<string, unknown>];

describe('portable destination mode — S23 adds the backup company', () => {
  it('creates the backup company when the installation has none', async () => {
    const test = setup({ users: existingOwner() }, makeSnapshot(), { mode: 'company', createIfAbsent: true });

    const result = await test.restore(test.request);

    expect(result).toMatchObject({ status: 'committed', operationId: 'op-committed' });
    expect(test.state.companies).toHaveLength(1);
    expect(test.state.companies[0]).toMatchObject({
      id: COMPANY_ID, legalName: COMPANY_LEGAL_NAME, entityType: 'BUSINESS',
    });
    expect(test.state.members).toEqual([
      expect.objectContaining({ userId: OWNER.id, companyId: COMPANY_ID, role: 'company_admin' }),
    ]);
    // The owner account already exists (the session user), so nothing is created
    // or hashed again for it.
    expect(test.state.users).toHaveLength(1);
    expect(test.restoreCalls).toHaveLength(1);
    expect(test.restoreCalls[0].companyId).toBe(COMPANY_ID);
    expect(test.restoreCalls[0].mode).toMatchObject({ recovery: 'portable' });
    expect(test.records).toHaveLength(1);
    expect(test.records[0]).toMatchObject({ companyId: COMPANY_ID, ownerUserId: OWNER.id });
  });

  it('refuses to add a company this installation already has', async () => {
    const test = setup(
      { users: existingOwner(), companies: [companyRow(COMPANY_ID, 'OTRA EMPRESA S.A.')] },
      makeSnapshot(),
      { mode: 'company', createIfAbsent: true },
    );

    const result = await test.restore(test.request);

    expect(result).toMatchObject({ status: 'refused', httpStatus: 409, code: 'RECOVERY_COMPANY_EXISTS' });
    // Nothing was touched: no overwrite, no replacement, no evidence record.
    expect(test.state.companies).toHaveLength(1);
    expect(test.state.companies[0].legalName).toBe('OTRA EMPRESA S.A.');
    expect(test.state.audits).toHaveLength(0);
    expect(test.restoreCalls).toHaveLength(0);
    expect(test.records).toHaveLength(0);
  });
});

describe('portable destination mode — S24 replaces the active company', () => {
  it('replaces the target company data instead of creating a company', async () => {
    const test = setup(
      {
        users: existingOwner(),
        companies: [companyRow(COMPANY_ID, COMPANY_LEGAL_NAME)],
        members: [memberRow('member-1', OWNER.id, COMPANY_ID, 'company_admin') as unknown as Record<string, unknown>],
      },
      makeSnapshot(),
      { mode: 'company', companyId: COMPANY_ID },
    );

    const result = await test.restore(test.request);

    expect(result).toMatchObject({ status: 'committed', operationId: 'op-committed' });
    expect(test.state.companies).toHaveLength(1);
    expect(test.restoreCalls).toHaveLength(1);
    expect(test.restoreCalls[0].companyId).toBe(COMPANY_ID);
    // No shell is created for an installation that already owns the company.
    expect(test.state.members).toHaveLength(1);
    expect(test.records[0]).toMatchObject({ companyId: COMPANY_ID, identityMap: {} });
  });

  it('captures the target company own rows as payload-absent evidence, never as replaced history', async () => {
    // S24 / T42 — the exclusion pin, RE-PINNED with a stated reason.
    // It used to demand that a target-company audit row be ABSENT from the recorded
    // evidence ("the replacement's scope"). That reflected the T38 filter applied to
    // the WHOLE post-commit read-set, which is exactly the asymmetry L88 hit: the
    // admission validator certifies over EVERY retained row, so the post-commit proof
    // must do the same or an attested row loses its evidence. `AuditLog` rows are
    // never deleted by any restore, so the target's own row is not replaced at all:
    // it is RETAINED history, captured with the digest of its stored bytes and the
    // explicit `outsidePayload` marker (what `assertDestinationAuditPreserved` checks
    // is still only the rows OUTSIDE the target company).
    const test = setup(
      {
        users: existingOwner(),
        companies: [companyRow(COMPANY_ID, COMPANY_LEGAL_NAME)],
        members: [memberRow('member-1', OWNER.id, COMPANY_ID, 'company_admin') as unknown as Record<string, unknown>],
        // Its own previous audit rows are payload-absent (a company-scoped export
        // never carried them); another company's rows are history too.
        audits: [
          { id: 'audit-propia-vieja', companyId: COMPANY_ID, userId: null, action: 'JOURNAL_POSTED',
            entity: 'JournalEntry', entityId: 'e-1', details: null, hash: null, previousHash: null, createdAt: NOW.toISOString() },
          { id: 'audit-otra-empresa', companyId: 'company-otra', userId: null, action: 'JOURNAL_POSTED',
            entity: 'JournalEntry', entityId: 'e-2', details: null, hash: null, previousHash: null, createdAt: NOW.toISOString() },
        ],
      },
      makeSnapshot(),
      { mode: 'company', companyId: COMPANY_ID },
    );

    const result = await test.restore(test.request);

    expect(result).toMatchObject({ status: 'committed' });
    // Both rows survive byte-identically: replacing company DATA never deletes
    // audit evidence, and the archive freezes exactly those stored bytes.
    expect(test.state.audits.map((row) => row.id)).toEqual([
      'audit-propia-vieja', 'audit-otra-empresa', 'op-committed',
    ]);
    const evidence = (test.records[0] as { auditEvidence: Array<Record<string, unknown>> }).auditEvidence;
    expect(evidence.find((entry) => entry.id === 'audit-propia-vieja')).toEqual({
      id: 'audit-propia-vieja',
      digest: auditHistoryDigestOf(test.state.audits[0] as never),
      outsidePayload: true, sealLess: true,
    });
  });

  it('refuses a target company that does not exist here', async () => {
    const test = setup(      { users: existingOwner(), companies: [companyRow('company-otra', 'Otra S.A.')] },
      makeSnapshot(),
      { mode: 'company', companyId: COMPANY_ID },
    );

    const result = await test.restore(test.request);

    expect(result).toMatchObject({ status: 'refused', httpStatus: 409, code: 'RECOVERY_COMPANY_NOT_FOUND' });
    expect(test.restoreCalls).toHaveLength(0);
    expect(test.state.companies).toHaveLength(1);
  });

  it('refuses a target that is not the company inside the opened backup', async () => {
    const test = setup(
      {
        users: existingOwner(),
        companies: [companyRow('company-otra', 'Otra S.A.'), companyRow(COMPANY_ID, COMPANY_LEGAL_NAME)],
      },
      makeSnapshot(),
      { mode: 'company', companyId: 'company-otra' },
    );

    const result = await test.restore(test.request);

    expect(result).toMatchObject({
      status: 'refused', httpStatus: 400, code: 'RECOVERY_ACTIVE_COMPANY_MISMATCH',
    });
    expect(test.restoreCalls).toHaveLength(0);
  });
});

describe('portable destination mode — the zero-installation contract is preserved', () => {
  it('still refuses an installation that already has companies when no target is given', async () => {
    const test = setup(
      { users: existingOwner(), companies: [companyRow('company-otra', 'Otra S.A.')] },
      makeSnapshot(),
    );

    const result = await test.restore(test.request);

    expect(result).toMatchObject({ status: 'refused', httpStatus: 409, code: 'DB_NOT_EMPTY' });
    expect(test.restoreCalls).toHaveLength(0);
    expect(test.records).toHaveLength(0);
  });

  it('still imports the backup company into an empty installation when no target is given', async () => {
    const test = setup({ users: existingOwner() }, makeSnapshot());

    const result = await test.restore(test.request);

    expect(result).toMatchObject({ status: 'committed' });
    expect(test.state.companies).toHaveLength(1);
    expect(test.restoreCalls[0].companyId).toBe(COMPANY_ID);
  });
});

/**
 * T42 / L88 — THE OWNER'S COMPANY-MODE FAILURE.
 *
 * The real installation restored from the Administración de Empresas door and the
 * completion ended in `RECOVERY_HISTORY_LOST` after 21.5s. The traced mechanism:
 * the prepare read-set was filtered (target-company rows removed) and that FILTERED
 * set fed the overlap planner and the payload-absent classification, while the
 * admission validator certified over EVERY retained row. A target-scoped retained
 * row whose actor the legacy `ON DELETE SET NULL` erased therefore lost its attested
 * evidence, `buildRecoveryProvenance` fell back to the payload-derived digest and
 * `assertStoredEvidence` reported the untouched stored row as "rewritten".
 *
 * These cases drive the REAL admission decision and the REAL post-commit proof over
 * the same synthetic installation, so admission and the post-commit proof must agree
 * about the retained set (T36): the target's own rows are CAPTURED with the digest of
 * their stored bytes, and a payload-absent target-scoped row is captured (and
 * asserted) as `outsidePayload` instead of vanishing from the evidence.
 */
const T42_RECEIPT = 'op-t42-committed';

/** A sealed audit row: its HMAC covers the references it was signed over. */
function sealedAuditRow(input: {
  id: string;
  userId: string | null;
  companyId?: string | null;
  action?: string;
  createdAt?: string;
}): Row {
  const content = {
    id: input.id,
    companyId: input.companyId === undefined ? COMPANY_ID : input.companyId,
    userId: input.userId,
    action: input.action ?? 'JOURNAL_POSTED',
    entity: 'JournalEntry',
    entityId: 'entry-1',
    details: null,
    previousHash: null,
  };
  return { ...content, createdAt: input.createdAt ?? NOW.toISOString(), hash: computeAuditHash(content) };
}

function emptyRestoreTables(): Tables {
  return Object.fromEntries(
    Object.values(RESTORE_MODELS).map((model) => [model, [] as Row[]])) as Tables;
}

/**
 * The company door over the fake client: the SAME pipeline production runs
 * (admission inside the replacement, then the post-commit proof).
 */
function companyDoor(
  seed: Parameters<typeof fakeClient>[0],
  snapshot: BackupData,
  target: PortableDestinationTarget,
  afterCommit?: (state: ReturnType<typeof fakeClient>['state']) => void,
) {
  const { client, state } = fakeClient(seed);
  const provenance = fakeProvenance();
  const admission: Array<{ reused: string[]; projected: string[] }> = [];

  const destinationTables = (): Tables => {
    const tables = emptyRestoreTables();
    tables.Company = state.companies.map((row) => ({ entityType: 'BUSINESS', taxId: null, ...row }));
    tables.User = state.users.map((row) => ({ ...row }));
    tables.CompanyMember = state.members.map((row) => ({ ...row }));
    tables.AuditLog = state.audits.map((row) => ({ ...row }));
    tables.JournalEntry = state.journals.map((row) => ({ ...row }));
    return tables;
  };

  const restore = createPortableDestinationRestore({
    client: client as unknown as Client,
    provenance: provenance.recorder,
    now: () => NOW,
    hashPassword: async (password: string) => passwordHashOf(String(password)),
    verifyPassword: async (password: string, hash: string) => hash === passwordHashOf(password),
    target,
    coordinatedRestore: async (companyId, text, _mode, identityMap) => {
      const parsed = JSON.parse(text) as BackupData;
      // The REAL admission decision, taken BEFORE anything is written: the production
      // coordinator refuses here, and the engine reports it as a 400 refusal.
      const sourceTables = emptyRestoreTables();
      sourceTables.Company = (parsed.data.company ?? []) as Row[];
      sourceTables.User = (parsed.data.users ?? []) as Row[];
      sourceTables.CompanyMember = (parsed.data.companyMembers ?? []) as Row[];
      sourceTables.AuditLog = ((parsed.data.auditLogs ?? []) as Row[]).map((row) => ({ ...row }));
      const decision = validateRestoreDestination(
        sourceTables, destinationTables(), companyId, true, identityMap);
      admission.push({
        reused: [...decision.auditReuse.keys()],
        projected: [...decision.auditProjections.keys()],
      });
      const mapped = ((parsed.data.auditLogs ?? []) as Row[]).map((row) => {
        const destination = typeof row.userId === 'string' ? identityMap[row.userId] : undefined;
        return destination && destination !== row.userId ? { ...row, userId: destination } : { ...row };
      });
      // Company-scoped DATA is replaced. `AuditLog` is never deleted (the application
      // has no audit delete path at all) and a reused id is skipped instead of
      // re-inserted, exactly like the production replacement.
      state.companies = state.companies.map((company) => company.id === companyId
        ? { ...company, legalName: parsed.manifest.companyInfo.legalName }
        : company);
      state.journals = [
        ...state.journals.filter((row) => row.companyId !== companyId),
        ...(parsed.data.journalEntries ?? []),
      ];
      state.audits.push(...mapped.filter((row) => !decision.auditReuse.has(String(row.id))));
      state.audits.push({
        id: T42_RECEIPT, companyId, userId: null, action: 'COMPANY_RESTORE_COMMITTED',
        entity: 'Backup', entityId: null, details: null, hash: null, previousHash: null,
        createdAt: NOW.toISOString(),
      });
      afterCommit?.(state);
      return { status: 'committed' as const, operationId: T42_RECEIPT, counts: parsed.manifest.recordCounts };
    },
  });

  return {
    state,
    records: provenance.records,
    admission,
    restore: () => restore({
      snapshot,
      fileText: 'portable-container-text',
      fileDigest: 'file-digest-t42',
      payloadDigest: 'payload-digest-t42',
      ownerUserId: OWNER.id,
      ownerEmail: OWNER.email,
      ownerPassword: SOURCE_PASSWORD,
    }),
  };
}

describe('T42 — the company door proves the SAME retained set admission certified', () => {
  it('certifies a target-scoped retained row whose actor reference the legacy FK erased', async () => {
    // The owner's shape: the backup carries the authenticated event WITH its actor,
    // while the row stored here kept the seal and lost the actor reference when the
    // legacy foreign key ran. Its id carries the TARGET company.
    const source = sealedAuditRow({ id: 'audit-target-scoped-erased-actor', userId: OWNER.id });
    const retained = { ...source, userId: null };
    const door = companyDoor(
      {
        users: existingOwner(),
        companies: [companyRow(COMPANY_ID, COMPANY_LEGAL_NAME)],
        members: [memberRow('member-t42', OWNER.id, COMPANY_ID, 'company_admin') as unknown as Record<string, unknown>],
        audits: [{ ...retained }],
      },
      makeSnapshot({ auditLogs: [{ ...source }] }),
      { mode: 'company', companyId: COMPANY_ID },
    );
    const before = JSON.stringify(door.state.audits);

    const result = await door.restore();

    // Admission certified this exact row (as a projection of the erased actor)...
    expect(door.admission).toEqual([{
      reused: ['audit-target-scoped-erased-actor'],
      projected: ['audit-target-scoped-erased-actor'],
    }]);
    // ...so the completion must certify it too, instead of reporting the untouched
    // stored row as "rewritten" (the L88 failure).
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'committed', operationId: T42_RECEIPT,
    });
    // The stored row is never rewritten: byte-identical, one copy, no re-sign.
    const copies = door.state.audits.filter((row) => row.id === 'audit-target-scoped-erased-actor');
    expect(copies).toHaveLength(1);
    expect(JSON.stringify(copies[0])).toBe(JSON.stringify(JSON.parse(before)[0]));
    // Evidence describes the STORED bytes (not the payload-derived digest) and keeps
    // the proven original attribution as a record-only label.
    const evidence = (door.records[0] as { auditEvidence: Array<Record<string, unknown>> }).auditEvidence;
    expect(evidence.find((entry) => entry.id === 'audit-target-scoped-erased-actor')).toEqual({
      id: 'audit-target-scoped-erased-actor',
      digest: auditHistoryDigestOf(copies[0] as never),
      projectedUserId: OWNER.id,
    });
  });

  it('captures a payload-absent target-scoped receipt row as outsidePayload evidence', async () => {
    // The silent gap: a target-scoped row the company-scoped export never carried
    // (a previous attempt's receipt, for instance) used to be invisible to both the
    // evidence and the post-commit assertion.
    const receipt = {
      id: 'audit-target-receipt-earlier', companyId: COMPANY_ID, userId: null,
      action: 'COMPANY_RESTORE_COMMITTED', entity: 'Backup', entityId: null, details: null,
      hash: null, previousHash: null, createdAt: NOW.toISOString(),
    };
    const door = companyDoor(
      {
        users: existingOwner(),
        companies: [companyRow(COMPANY_ID, COMPANY_LEGAL_NAME)],
        members: [memberRow('member-t42', OWNER.id, COMPANY_ID, 'company_admin') as unknown as Record<string, unknown>],
        audits: [{ ...receipt }],
      },
      makeSnapshot(),
      { mode: 'company', companyId: COMPANY_ID },
    );

    const result = await door.restore();

    expect(result, JSON.stringify(result)).toMatchObject({ status: 'committed' });
    expect(door.state.audits.find((row) => row.id === receipt.id)).toEqual(receipt);
    const evidence = (door.records[0] as { auditEvidence: Array<Record<string, unknown>> }).auditEvidence;
    expect(evidence.find((entry) => entry.id === receipt.id)).toEqual({
      id: receipt.id,
      digest: auditHistoryDigestOf(receipt as never),
      outsidePayload: true, sealLess: true,
    });
  });

  it('reports a lost payload-absent target-scoped row instead of completing silently', async () => {
    const receipt = {
      id: 'audit-target-receipt-lost', companyId: COMPANY_ID, userId: null,
      action: 'COMPANY_RESTORE_COMMITTED', entity: 'Backup', entityId: null, details: null,
      hash: null, previousHash: null, createdAt: NOW.toISOString(),
    };
    const door = companyDoor(
      {
        users: existingOwner(),
        companies: [companyRow(COMPANY_ID, COMPANY_LEGAL_NAME)],
        members: [memberRow('member-t42', OWNER.id, COMPANY_ID, 'company_admin') as unknown as Record<string, unknown>],
        audits: [{ ...receipt }],
      },
      makeSnapshot(),
      { mode: 'company', companyId: COMPANY_ID },
      (state) => { state.audits = state.audits.filter((row) => row.id !== receipt.id); },
    );

    const result = await door.restore();

    // Fail closed: the archived row is gone, so the outcome needs reconciliation and
    // the installation stays fenced. Evidence is recorded only after the proof.
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'reconciliation_required', code: 'RECOVERY_HISTORY_LOST',
    });
    expect(door.records).toHaveLength(0);
  });

  it('still refuses a target-scoped row that is not the authenticated event', async () => {
    // Fail-closed is unchanged: the widened read-set is not a weaker certification.
    // Admission proves the row before any mutation, and the completion never runs.
    const source = sealedAuditRow({ id: 'audit-target-scoped-conflict', userId: OWNER.id });
    const tampered = { ...source, userId: null, action: 'JOURNAL_REVERSED' };
    const door = companyDoor(
      {
        users: existingOwner(),
        companies: [companyRow(COMPANY_ID, COMPANY_LEGAL_NAME)],
        members: [memberRow('member-t42', OWNER.id, COMPANY_ID, 'company_admin') as unknown as Record<string, unknown>],
        audits: [{ ...tampered }],
      },
      makeSnapshot({ auditLogs: [{ ...source }] }),
      { mode: 'company', companyId: COMPANY_ID },
    );

    const result = await door.restore();

    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'refused', httpStatus: 400, code: 'RECOVERY_RESTORE_REFUSED',
    });
    expect((result as { message: string }).message).toMatch(/RESTORE_ID_CONFLICT/);
    expect(door.records).toHaveLength(0);
    expect(door.state.audits.find((row) => row.id === tampered.id)).toEqual(tampered);
  });

  it('still reports a lost row OUTSIDE the target company (previous behavior preserved)', async () => {
    const retained = {
      id: 'audit-otra-empresa', companyId: 'company-otra', userId: null,
      action: 'JOURNAL_POSTED', entity: 'JournalEntry', entityId: 'e-2', details: null,
      hash: null, previousHash: null, createdAt: NOW.toISOString(),
    };
    const door = companyDoor(
      {
        users: existingOwner(),
        companies: [companyRow(COMPANY_ID, COMPANY_LEGAL_NAME)],
        members: [memberRow('member-t42', OWNER.id, COMPANY_ID, 'company_admin') as unknown as Record<string, unknown>],
        audits: [{ ...retained }],
      },
      makeSnapshot(),
      { mode: 'company', companyId: COMPANY_ID },
      (state) => { state.audits = state.audits.filter((row) => row.id !== retained.id); },
    );

    const result = await door.restore();

    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'reconciliation_required', code: 'RECOVERY_DESTINATION_AUDIT_LOST',
    });
  });
});
