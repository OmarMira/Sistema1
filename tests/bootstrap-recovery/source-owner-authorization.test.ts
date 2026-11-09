/**
 * T15 — source-owner authorization must not depend on an existing destination
 * account (S2/S3/S15), and a zero-company installation that still retains audit
 * history must be recoverable (S2) without deleting or re-signing that history.
 *
 * These are the two reported blockers, expressed as behavior contracts on the
 * workflow entry points. The destination client below is a minimal fake: the
 * PostgreSQL adapters and the real coordinated replacement are exercised by
 * tests/portable-recovery-postgres.
 */
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_POLICY, createMemoryRecoveryChallengeStore,
  completePortableRecovery, requestPortableRecoveryChallenge,
  type PortableRecoveryDeps,
} from '@/lib/backup-recovery-auth';
import { createMemoryRecoveryLockStore } from '@/lib/backup-recovery-lock';
import { createPortableDestinationRestore } from '@/lib/backup-recovery-provenance';
import {
  COMPANY_LEGAL_NAME, OWNER, SOURCE_PASSWORD,
  auditRow, fakeClient, fakeProvenance, makeSnapshot, portableFile, userRow,
} from './helpers';
import type { BackupData } from '@/lib/backup';

const NOW = new Date('2026-03-01T09:00:00.000Z');

function harness(options: {
  seed?: Parameters<typeof fakeClient>[0];
  snapshot?: BackupData;
  fileText?: string;
} = {}) {
  const { client, state } = fakeClient(options.seed ?? {});
  const store = createMemoryRecoveryChallengeStore();
  const lock = createMemoryRecoveryLockStore();
  const provenance = fakeProvenance();
  const mail: Array<{ to: string; token: string }> = [];
  const restoreInputs: unknown[] = [];
  const restore = createPortableDestinationRestore({
    client,
    provenance: provenance.recorder,
    now: () => NOW,
    hashPassword: async () => '$2a$12$hashed-by-destination',
    verifyPassword: async () => false,
    coordinatedRestore: async (companyId, text) => {
      const parsed = JSON.parse(text) as BackupData;
      state.companies = [{ id: companyId, legalName: parsed.manifest.companyInfo.legalName }];
      state.audits = [
        ...state.audits,
        ...(parsed.data.auditLogs ?? []),
        { id: 'receipt-op', companyId, hash: null, previousHash: null, createdAt: NOW.toISOString() },
      ];
      return { status: 'committed' as const, operationId: 'receipt-op', counts: parsed.manifest.recordCounts };
    },
  });
  const deps: PortableRecoveryDeps = {
    now: () => NOW,
    challenges: store,
    lock,
    mail: { send: async (message) => { mail.push(message as unknown as { to: string; token: string }); } },
    // There is deliberately no local-owner lookup: the source owner is proven by
    // the authenticated backup credential, never by an account that must exist.
    installationState: async () => ({ companies: state.companies.length, audits: state.audits.length }),
    restore: async (input) => {
      restoreInputs.push(input);
      return restore(input);
    },
  };
  const snapshot = options.snapshot ?? makeSnapshot();
  return {
    deps, store, lock, mail, state, provenance, restoreInputs, snapshot,
    fileText: options.fileText ?? portableFile(snapshot),
  };
}

function request(h: ReturnType<typeof harness>, overrides: Partial<{
  password: string; companyLegalName: string; ownerEmail: string; fileText: string;
}> = {}) {
  return requestPortableRecoveryChallenge(h.deps, {
    fileText: overrides.fileText ?? h.fileText,
    password: overrides.password ?? SOURCE_PASSWORD,
    companyLegalName: overrides.companyLegalName ?? COMPANY_LEGAL_NAME,
    ownerEmail: overrides.ownerEmail ?? OWNER.email,
  });
}

function complete(h: ReturnType<typeof harness>, token: string, overrides: Partial<{
  password: string; companyLegalName: string; ownerEmail: string; fileText: string;
}> = {}) {
  return completePortableRecovery(h.deps, {
    fileText: overrides.fileText ?? h.fileText,
    password: overrides.password ?? SOURCE_PASSWORD,
    companyLegalName: overrides.companyLegalName ?? COMPANY_LEGAL_NAME,
    ownerEmail: overrides.ownerEmail ?? OWNER.email,
    token,
  });
}

describe('source-owner authorization without a destination account', () => {
  it('recoveries a zero installation that has NO local owner account', async () => {
    const h = harness();
    expect(h.state.users).toHaveLength(0);
    const requested = await request(h);
    expect(requested.status).toBe('challenge_sent');
    const token = h.mail.at(-1)!.token;
    const completed = await complete(h, token);
    expect(completed).toMatchObject({ status: 'restored', sessionUserId: OWNER.id });
    expect(JSON.stringify(completed)).not.toContain(token);
    expect(h.state.companies).toHaveLength(1);
    // The account is CREATED by the recovery; none had to exist beforehand.
    expect(h.state.users).toHaveLength(1);
    expect(h.state.users[0]).toMatchObject({ id: OWNER.id, email: OWNER.email });
    expect(h.restoreInputs).toHaveLength(1);
    expect(h.provenance.records).toHaveLength(1);
  });

  it('sends the token to the owner email sealed in the authenticated backup', async () => {
    const h = harness({
      seed: { users: [{ ...userRow('someone-else', 'other@example.test'), passwordHash: '$2a$12$x' }] },
    });
    const requested = await request(h);
    expect(requested.status).toBe('challenge_sent');
    expect(h.mail).toHaveLength(1);
    expect(h.mail[0].to).toBe(OWNER.email);
    expect(h.mail[0].token).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(requested)).not.toContain(h.mail[0].token);
  });

  it('accepts a zero-company installation that retains audit history', async () => {
    const retained = [
      { ...auditRow('retained-1', 'company-deleted', null), userId: null },
      {
        ...auditRow('retained-2', 'company-deleted', auditRow('retained-1', 'company-deleted', null).hash),
        userId: null,
      },
    ];
    const h = harness({ seed: { audits: retained.map((row) => ({ ...row })) } });
    const requested = await request(h);
    expect(requested.status).toBe('challenge_sent');
    const completed = await complete(h, h.mail.at(-1)!.token);
    expect(completed).toMatchObject({ status: 'restored' });
    // Every retained row is still present and byte-identical.
    for (const row of retained) {
      expect(h.state.audits.find((entry) => entry.id === row.id)).toEqual(row);
    }
  });

  it('still refuses an installation that already has a company', async () => {
    const h = harness({ seed: { companies: [{ id: 'existing-company' }] } });
    const result = await request(h);
    expect(result).toMatchObject({ status: 409, code: 'DB_NOT_EMPTY' });
    expect(h.mail).toHaveLength(0);
    expect(h.store.describe().challenges).toHaveLength(0);
    expect(h.state.companies).toHaveLength(1);
  });

  it('refuses a backup whose sealed owner was never verified', async () => {
    const snapshot = makeSnapshot();
    const h = harness({
      snapshot,
      fileText: portableFile(snapshot, SOURCE_PASSWORD, OWNER, {
        emailVerifiedAt: null, legacyUser: false,
      }),
    });
    const result = await request(h);
    expect(result).toMatchObject({ status: 403, code: 'RECOVERY_OWNER_UNAVAILABLE' });
    expect(h.mail).toHaveLength(0);
    expect(h.restoreInputs).toHaveLength(0);
  });

  it('refuses when the sealed owner disagrees with the backup user record', async () => {
    const snapshot = makeSnapshot({ users: [userRow(OWNER.id, OWNER.email, 'user')] });
    const h = harness({ snapshot });
    const result = await request(h);
    expect(result).toMatchObject({ status: 403, code: 'RECOVERY_OWNER_UNAVAILABLE' });
    expect(h.mail).toHaveLength(0);
  });
});

describe('unchanged recovery controls', () => {
  it('keeps the bounded attempt budget per file', async () => {
    const h = harness();
    for (let attempt = 0; attempt < RECOVERY_POLICY.attempts; attempt += 1) {
      const wrong = await request(h, { password: `wrong-password-${attempt}` });
      expect(wrong).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
    }
    const blocked = await request(h);
    expect(blocked).toMatchObject({ status: 429, code: 'RECOVERY_TOO_MANY_ATTEMPTS' });
    expect(h.mail).toHaveLength(0);
    expect(h.store.describe().challenges).toHaveLength(0);
  });

  it('keeps the token single use and bound to file, owner and expiry', async () => {
    const h = harness();
    await request(h);
    const token = h.mail.at(-1)!.token;
    expect(await complete(h, token)).toMatchObject({ status: 'restored' });
    const replay = await complete(h, token);
    // Second attempt: the installation now has a company, so the replay is
    // refused before any token work; the token itself is already consumed.
    expect(replay).toMatchObject({ status: 409, code: 'DB_NOT_EMPTY' });
    expect(h.store.describe().challenges[0].usedAt).not.toBeNull();
    expect(h.restoreInputs).toHaveLength(1);
  });

  it('keeps the owner email and company name as required KDF inputs', async () => {
    const h = harness();
    const wrongEmail = await request(h, { ownerEmail: 'otra@example.test' });
    expect(wrongEmail).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
    const wrongCompany = await request(h, { companyLegalName: 'Otra Empresa S.A.' });
    expect(wrongCompany).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
    expect(h.restoreInputs).toHaveLength(0);
    expect(h.mail).toHaveLength(0);
  });
});
