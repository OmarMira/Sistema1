import { describe, expect, it } from 'vitest';
import {
  completePortableRecovery, createMemoryRecoveryChallengeStore,
  requestPortableRecoveryChallenge,
  type PortableRecoveryDeps,
} from '@/lib/backup-recovery-auth';
import { createMemoryRecoveryLockStore } from '@/lib/backup-recovery-lock';
import {
  COMPANY_ID, COMPANY_LEGAL_NAME, OWNER, SOURCE_PASSWORD, makeSnapshot, portableFile,
} from './helpers';

/**
 * Session-scoped entry points (S23 / S24) reuse the anonymous portable engine,
 * so the identity rule and the destination rule must live IN the engine:
 *
 *  - the authenticated session user's email must be the backup's authenticated
 *    owner email, verified again on completion (S23/S25);
 *  - the settings door only accepts the backup whose company is the ACTIVE
 *    company, and says so BEFORE any token exists (S24).
 *
 * Both are checked after the file is opened (only then are the owner email and
 * the company known) and strictly before `challenges.issue`, so a refused caller
 * never receives a code, never consumes one and never reaches the restore.
 */

const NOW = new Date('2026-03-03T10:00:00.000Z');

function engine(options: { companies?: number } = {}) {
  const store = createMemoryRecoveryChallengeStore();
  const mail: Array<{ to: string; token: string }> = [];
  const restoreCalls: Array<Record<string, unknown>> = [];
  const deps: PortableRecoveryDeps = {
    now: () => NOW,
    challenges: store,
    lock: createMemoryRecoveryLockStore(),
    mail: { send: async (message) => { mail.push(message as unknown as { to: string; token: string }); } },
    installationState: async () => ({ companies: options.companies ?? 0, audits: 0 }),
    restore: async (request) => {
      restoreCalls.push(request as unknown as Record<string, unknown>);
      return { status: 'committed', operationId: 'op-1', sessionUserId: OWNER.id, counts: { company: 1 } };
    },
  };
  return { deps, store, mail, restoreCalls };
}

function challengeInput(overrides: Record<string, unknown> = {}) {
  return {
    fileText: portableFile(makeSnapshot()),
    password: SOURCE_PASSWORD,
    companyLegalName: COMPANY_LEGAL_NAME,
    ownerEmail: OWNER.email,
    ...overrides,
  };
}

describe('portable engine — session identity rule (S23/S25)', () => {
  it('keeps the anonymous bootstrap path working without a session', async () => {
    const test = engine();
    const result = await requestPortableRecoveryChallenge(test.deps, challengeInput());
    expect(result.status).toBe('challenge_sent');
    expect(test.mail).toHaveLength(1);
    expect(test.mail[0].to).toBe(OWNER.email);
  });

  it('refuses the owner door for a session that is not the backup owner', async () => {
    const test = engine();
    const result = await requestPortableRecoveryChallenge(test.deps, challengeInput({
      destination: { mode: 'owner-admin' },
      sessionEmail: 'otra-persona@example.test',
    }));

    expect(result).toMatchObject({ status: 403, code: 'RECOVERY_SESSION_IDENTITY_MISMATCH' });
    // Fail closed: no token was issued, nothing was mailed, nothing was restored.
    expect(test.store.describe().challenges).toHaveLength(0);
    expect(test.mail).toHaveLength(0);
    expect(test.restoreCalls).toHaveLength(0);
    // The refusal must not leak the sealed owner identity.
    expect(JSON.stringify(result)).not.toContain(OWNER.email);
  });

  it('refuses a session email that is missing entirely', async () => {
    const test = engine();
    const result = await requestPortableRecoveryChallenge(test.deps, challengeInput({
      destination: { mode: 'owner-admin' },
    }));
    expect(result).toMatchObject({ status: 403, code: 'RECOVERY_SESSION_IDENTITY_MISMATCH' });
    expect(test.mail).toHaveLength(0);
  });

  it('accepts the owner door when the session email is the owner email, normalized', async () => {
    const test = engine({ companies: 1 });
    const result = await requestPortableRecoveryChallenge(test.deps, challengeInput({
      destination: { mode: 'owner-admin' },
      sessionEmail: `  ${OWNER.email.toUpperCase()}  `,
    }));

    expect(result.status).toBe('challenge_sent');
    expect(test.mail).toHaveLength(1);
    // The session door bypasses the zero-installation gate only: the destination
    // restore owns the company gate (S23 adds the backup's company).
    expect(test.store.describe().challenges).toHaveLength(1);
  });

  it('re-verifies the identity on completion and never consumes the token first', async () => {
    const test = engine();
    const ownerDoor = challengeInput({ destination: { mode: 'owner-admin' }, sessionEmail: OWNER.email });
    expect((await requestPortableRecoveryChallenge(test.deps, ownerDoor)).status).toBe('challenge_sent');
    const token = test.mail[0].token;

    const refused = await completePortableRecovery(test.deps, {
      ...ownerDoor, token, sessionEmail: 'intruso@example.test',
    });
    expect(refused).toMatchObject({ status: 403, code: 'RECOVERY_SESSION_IDENTITY_MISMATCH' });
    expect(test.restoreCalls).toHaveLength(0);
    // The issued code is still the current, unused draft: a refusal must not burn it.
    expect(test.store.describe().challenges[0]).toMatchObject({ usedAt: null });

    const completed = await completePortableRecovery(test.deps, { ...ownerDoor, token });
    expect(completed).toMatchObject({ status: 'restored', operationId: 'op-1' });
    expect(test.restoreCalls).toHaveLength(1);
  });
});

describe('portable engine — active-company rule (S24)', () => {
  const activeCompany = COMPANY_ID;

  it('accepts a backup of the ACTIVE company', async () => {
    const test = engine({ companies: 1 });
    const result = await requestPortableRecoveryChallenge(test.deps, challengeInput({
      destination: { mode: 'active-company', companyId: activeCompany },
      sessionEmail: OWNER.email,
    }));

    expect(result.status).toBe('challenge_sent');
    expect(test.mail).toHaveLength(1);
  });

  it('refuses a backup of another company before issuing any token', async () => {
    const test = engine({ companies: 2 });
    const result = await requestPortableRecoveryChallenge(test.deps, challengeInput({
      destination: { mode: 'active-company', companyId: 'company-otra' },
      sessionEmail: OWNER.email,
    }));

    expect(result).toMatchObject({ status: 409, code: 'RECOVERY_ACTIVE_COMPANY_MISMATCH' });
    expect(test.store.describe().challenges).toHaveLength(0);
    expect(test.mail).toHaveLength(0);
    expect(test.restoreCalls).toHaveLength(0);
  });

  it('re-verifies the active company on completion', async () => {
    const test = engine({ companies: 2 });
    const door = challengeInput({
      destination: { mode: 'active-company', companyId: activeCompany },
      sessionEmail: OWNER.email,
    });
    expect((await requestPortableRecoveryChallenge(test.deps, door)).status).toBe('challenge_sent');
    const token = test.mail[0].token;

    const refused = await completePortableRecovery(test.deps, {
      ...door, token, destination: { mode: 'active-company', companyId: 'company-otra' },
    });
    expect(refused).toMatchObject({ status: 409, code: 'RECOVERY_ACTIVE_COMPANY_MISMATCH' });
    expect(test.restoreCalls).toHaveLength(0);
  });
});

describe('portable engine — the anonymous bootstrap contract is unchanged', () => {
  it('still refuses an installation that already has companies', async () => {
    const test = engine({ companies: 1 });
    const result = await requestPortableRecoveryChallenge(test.deps, challengeInput());
    expect(result).toMatchObject({ status: 409, code: 'DB_NOT_EMPTY' });
    expect(test.store.describe().challenges).toHaveLength(0);
    expect(test.mail).toHaveLength(0);
  });

  it('still refuses an installation with companies on completion', async () => {
    const test = engine();
    expect((await requestPortableRecoveryChallenge(test.deps, challengeInput())).status).toBe('challenge_sent');
    const token = test.mail[0].token;
    const busy = engine({ companies: 1 });
    busy.deps.challenges = test.deps.challenges;
    const result = await completePortableRecovery(busy.deps, { ...challengeInput(), token });
    expect(result).toMatchObject({ status: 409, code: 'DB_NOT_EMPTY' });
    expect(busy.restoreCalls).toHaveLength(0);
  });
});
