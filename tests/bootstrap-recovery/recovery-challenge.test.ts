import { describe, expect, it } from 'vitest';
import {
  RECOVERY_POLICY, createMemoryRecoveryChallengeStore, recoveryTokenDigest,
  requestPortableRecoveryChallenge, type PortableRecoveryDeps,
} from '@/lib/backup-recovery-auth';
import { createMemoryRecoveryLockStore } from '@/lib/backup-recovery-lock';
import {
  COMPANY_LEGAL_NAME, OWNER, SOURCE_PASSWORD, makeSnapshot, portableFile,
} from './helpers';

const BASE_NOW = new Date('2026-02-01T12:00:00.000Z');

interface Harness {
  deps: PortableRecoveryDeps;
  store: ReturnType<typeof createMemoryRecoveryChallengeStore>;
  lock: ReturnType<typeof createMemoryRecoveryLockStore>;
  mail: Array<{ type: string; to: string; token: string }>;
  restores: unknown[];
  clock: { now: Date };
  installation: { companies: number; audits: number };
  mailBehaviour: { mode: 'deliver' | 'throw' };
}

function harness(): Harness {
  const store = createMemoryRecoveryChallengeStore();
  const lock = createMemoryRecoveryLockStore();
  const state = {
    clock: { now: new Date(BASE_NOW) },
    mail: [] as Harness['mail'],
    restores: [] as unknown[],
    installation: { companies: 0, audits: 0 },
    mailBehaviour: { mode: 'deliver' as 'deliver' | 'throw' },
  };
  const deps: PortableRecoveryDeps = {
    now: () => state.clock.now,
    challenges: store,
    lock,
    mail: {
      async send(message) {
        if (state.mailBehaviour.mode === 'throw') throw new Error('provider exploded: ' + (message as { token?: string }).token);
        state.mail.push(message as unknown as Harness['mail'][number]);
      },
    },
    installationState: async () => ({ ...state.installation }),
    restore: async (input) => {
      state.restores.push(input);
      return { status: 'committed', operationId: 'op-test', sessionUserId: OWNER.id, counts: { company: 1 } };
    },
  };
  return Object.assign(state, { deps, store, lock }) as Harness;
}

function request(h: Harness, overrides: Partial<{
  fileText: string; password: string; companyLegalName: string; ownerEmail: string;
}> = {}) {
  return requestPortableRecoveryChallenge(h.deps, {
    fileText: overrides.fileText ?? portableFile(makeSnapshot()),
    password: overrides.password ?? SOURCE_PASSWORD,
    companyLegalName: overrides.companyLegalName ?? COMPANY_LEGAL_NAME,
    ownerEmail: overrides.ownerEmail ?? OWNER.email,
  });
}

describe('recovery challenge request', () => {
  it('mails a single-use token to the authenticated owner email only', async () => {
    const h = harness();
    const result = await request(h);
    expect(result).toEqual({ status: 'challenge_sent', expiresAt: '2026-02-01T12:15:00.000Z' });
    expect(h.mail).toHaveLength(1);
    expect(h.mail[0].to).toBe(OWNER.email);
    expect(h.mail[0].type).toBe('recovery');
    expect(h.mail[0].token).toMatch(/^[a-f0-9]{64}$/);
    // The token is delivered out of band and never returned by the API surface.
    expect(JSON.stringify(result)).not.toContain(h.mail[0].token);
    const stored = h.store.describe();
    expect(stored.challenges).toHaveLength(1);
    expect(stored.challenges[0].tokenDigest).toBe(recoveryTokenDigest(h.mail[0].token));
    expect(stored.challenges[0].tokenDigest).not.toBe(h.mail[0].token);
    expect(stored.challenges[0].ownerUserId).toBe(OWNER.id);
    // The lease is always released at the end of the request stage.
    expect(h.lock.describe()).toBeNull();
  });

  it('stops a wrong password before any mail or draft, counting the attempt', async () => {
    const h = harness();
    const result = await request(h, { password: 'not-the-source-password' });
    expect(result).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
    expect(h.mail).toHaveLength(0);
    expect(h.store.describe().challenges).toHaveLength(0);
    // Only the bounded auth budget and a rejection event are recorded: no
    // challenge draft, no token, no mail, no business data.
    expect(h.store.describe().events.map((event) => event.action)).toEqual(['challenge_rejected']);
    expect(JSON.stringify(h.store.describe().events)).not.toContain('not-the-source-password');
    expect(h.store.describe().attemptsUsed).toBe(1);
  });

  it('stops a wrong company name before any mail or draft', async () => {
    const h = harness();
    const result = await request(h, { companyLegalName: 'Otra Empresa S.A.' });
    // The company name is a key-derivation input, so a wrong one cannot open the
    // file at all: one sanitized failure, no mail, no draft, no data.
    expect(result).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
    expect(JSON.stringify(result)).not.toContain('Otra Empresa S.A.');
    expect(h.mail).toHaveLength(0);
    expect(h.store.describe().challenges).toHaveLength(0);
  });

  it('accepts the company name in a different case/whitespace form (documented normalization)', async () => {
    const h = harness();
    const result = await request(h, { companyLegalName: '  compania   origen s.a. ' });
    expect(result).toEqual({ status: 'challenge_sent', expiresAt: '2026-02-01T12:15:00.000Z' });
    expect(h.mail).toHaveLength(1);
  });

  it('refuses the password alone: the owner email is a key input, not a lookup', async () => {
    const h = harness();
    const result = await request(h, { ownerEmail: '   ' });
    expect(result).toMatchObject({ status: 400, code: 'RECOVERY_IDENTITY_REQUIRED' });
    // A structurally incomplete request is refused before any attempt is charged.
    expect(h.store.describe().attemptsUsed).toBe(0);
    expect(h.mail).toHaveLength(0);
    expect(h.store.describe().challenges).toHaveLength(0);
  });

  it('stops a wrong owner email before any mail or draft, counting the attempt', async () => {
    const h = harness();
    const result = await request(h, { ownerEmail: 'otra-persona@example.test' });
    expect(result).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
    // Wrong email is indistinguishable from a wrong password (one sanitized answer).
    expect(JSON.stringify(result)).not.toContain('otra-persona@example.test');
    expect(h.store.describe().attemptsUsed).toBe(1);
    expect(h.mail).toHaveLength(0);
    expect(h.store.describe().challenges).toHaveLength(0);
  });

  it('fails closed when mail delivery is unavailable instead of reporting success', async () => {
    const h = harness();
    const noTransport = { ...h.deps, mail: null };
    const result = await requestPortableRecoveryChallenge(noTransport, {
      fileText: portableFile(makeSnapshot()), password: SOURCE_PASSWORD, companyLegalName: COMPANY_LEGAL_NAME,
      ownerEmail: OWNER.email,
    });
    expect(result).toMatchObject({ status: 503, code: 'RECOVERY_MAIL_UNAVAILABLE' });
    // The draft is consumed so an undelivered token can never be used.
    expect(h.store.describe().challenges).toHaveLength(1);
    expect(h.store.describe().challenges[0].usedAt).not.toBeNull();
  });

  it('fails closed when the provider rejects the message and leaks no token', async () => {
    const h = harness();
    h.mailBehaviour.mode = 'throw';
    const result = await request(h);
    expect(result).toMatchObject({ status: 503, code: 'RECOVERY_MAIL_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toMatch(/[a-f0-9]{64}/);
    expect(h.store.describe().challenges[0].usedAt).not.toBeNull();
  });

  it('bounds password attempts per uploaded file before any mail', async () => {
    const h = harness();
    const text = portableFile(makeSnapshot());
    for (let attempt = 0; attempt < RECOVERY_POLICY.attempts; attempt += 1) {
      const wrong = await request(h, { fileText: text, password: `wrong-password-${attempt}` });
      expect(wrong).toMatchObject({ status: 400, code: 'RECOVERY_PASSWORD_MISMATCH' });
    }
    const blocked = await request(h, { fileText: text, password: SOURCE_PASSWORD });
    expect(blocked).toMatchObject({ status: 429, code: 'RECOVERY_TOO_MANY_ATTEMPTS' });
    expect(h.mail).toHaveLength(0);
    expect(h.store.describe().challenges).toHaveLength(0);
  });

  it('accepts a zero-company installation that retains audit history', async () => {
    // The reported incident: no companies left, but the deleted company's audit
    // rows remain as evidence. They no longer block recovery; the restore
    // preserves them byte-identical (proved by the PostgreSQL suite).
    const h = harness();
    h.installation.companies = 0;
    h.installation.audits = 2;
    const result = await request(h);
    expect(result).toMatchObject({ status: 'challenge_sent' });
    expect(h.mail).toHaveLength(1);
    expect(h.mail[0].to).toBe(OWNER.email);
  });

  it('refuses a plaintext/internal snapshot instead of the encrypted file', async () => {
    const h = harness();
    const result = await request(h, { fileText: JSON.stringify(makeSnapshot()) });
    expect(result).toMatchObject({ status: 400, code: 'RECOVERY_FILE_UNSUPPORTED' });
    expect(h.mail).toHaveLength(0);
  });

  it('refuses an older portable version instead of opening it with a weaker key', async () => {
    const h = harness();
    const current = JSON.parse(portableFile(makeSnapshot())) as Record<string, unknown>;
    const legacy = {
      ...current,
      version: 1,
      kdf: {
        algorithm: 'pbkdf2-sha256',
        iterations: 210_000,
        salt: (current.kdf as Record<string, unknown>).salt,
      },
    };
    delete (legacy as Record<string, unknown>).binding;
    const result = await request(h, { fileText: JSON.stringify(legacy) });
    expect(result).toMatchObject({ status: 400, code: 'RECOVERY_FORMAT_UNSUPPORTED' });
    expect((result as { message: string }).message).toMatch(/export a new encrypted backup/i);
    expect(h.mail).toHaveLength(0);
    // Refused structurally: no password attempt is charged and no draft exists.
    expect(h.store.describe().attemptsUsed).toBe(0);
    expect(h.store.describe().challenges).toHaveLength(0);
  });

  it('refuses a backup whose sealed owner was never verified', async () => {
    const h = harness();
    const result = await request(h, {
      fileText: portableFile(makeSnapshot(), SOURCE_PASSWORD, OWNER, { emailVerifiedAt: null }),
    });
    expect(result).toMatchObject({ status: 403, code: 'RECOVERY_OWNER_UNAVAILABLE' });
    expect(h.mail).toHaveLength(0);
  });

  it('refuses concurrently while another recovery holds the lease', async () => {
    const h = harness();
    await h.lock.acquire({ holder: 'other-request', now: BASE_NOW, ttlMs: 60_000 });
    const result = await request(h);
    expect(result).toMatchObject({ status: 429, code: 'RECOVERY_IN_PROGRESS' });
    expect(h.mail).toHaveLength(0);
    expect(h.store.describe().challenges).toHaveLength(0);
  });

  it('never reports a delivered token that a concurrent request already rotated', async () => {
    const h = harness();
    const originalSend = h.deps.mail!.send.bind(h.deps.mail);
    const originalIssue = h.store.issue.bind(h.store);
    h.store.issue = async (input) => {
      await originalIssue(input);
      // A second request rotates the draft while this message is in flight.
      await originalIssue({ ...input, tokenDigest: recoveryTokenDigest('rotated-by-another-request') });
    };
    h.deps.mail = {
      async send(message) {
        await originalSend(message);
      },
    };
    const result = await request(h);
    expect(result).toMatchObject({ status: 409, code: 'RECOVERY_CHALLENGE_ROTATED' });
  });
});

describe('challenge store semantics', () => {
  const issue = (
    store: ReturnType<typeof createMemoryRecoveryChallengeStore>,
    now: Date,
    expiresIn = 60_000,
    digest = recoveryTokenDigest('t1'),
  ) => store.issue({
    fileDigest: 'a'.repeat(64), ownerUserId: OWNER.id, companyId: 'c1',
    tokenDigest: digest, expiresAt: new Date(now.getTime() + expiresIn), now,
  });

  it('rotates the draft token so an older token stops working', async () => {
    const store = createMemoryRecoveryChallengeStore();
    const now = new Date(BASE_NOW);
    await issue(store, now);
    await issue(store, now, 60_000, recoveryTokenDigest('t2'));
    expect(await store.consume({
      fileDigest: 'a'.repeat(64), ownerUserId: OWNER.id, tokenDigest: recoveryTokenDigest('t1'), now,
    })).toBe('mismatch');
    expect(await store.isCurrent({
      fileDigest: 'a'.repeat(64), tokenDigest: recoveryTokenDigest('t1'), now,
    })).toBe(false);
    expect(await store.isCurrent({
      fileDigest: 'a'.repeat(64), tokenDigest: recoveryTokenDigest('t2'), now,
    })).toBe(true);
    expect(await store.consume({
      fileDigest: 'a'.repeat(64), ownerUserId: OWNER.id, tokenDigest: recoveryTokenDigest('t2'), now,
    })).toBe('ok');
  });

  it('is single use and exact-file bound', async () => {
    const store = createMemoryRecoveryChallengeStore();
    const now = new Date(BASE_NOW);
    await issue(store, now);
    expect(await store.consume({
      fileDigest: 'b'.repeat(64), ownerUserId: OWNER.id, tokenDigest: recoveryTokenDigest('t1'), now,
    })).toBe('absent');
    expect(await store.consume({
      fileDigest: 'a'.repeat(64), ownerUserId: 'other-owner', tokenDigest: recoveryTokenDigest('t1'), now,
    })).toBe('mismatch');
    expect(await store.consume({
      fileDigest: 'a'.repeat(64), ownerUserId: OWNER.id, tokenDigest: recoveryTokenDigest('t1'), now,
    })).toBe('ok');
    expect(await store.consume({
      fileDigest: 'a'.repeat(64), ownerUserId: OWNER.id, tokenDigest: recoveryTokenDigest('t1'), now,
    })).toBe('used');
  });

  it('expires the token', async () => {
    const store = createMemoryRecoveryChallengeStore();
    const now = new Date(BASE_NOW);
    await issue(store, now, 1000);
    const later = new Date(now.getTime() + 2000);
    expect(await store.consume({
      fileDigest: 'a'.repeat(64), ownerUserId: OWNER.id, tokenDigest: recoveryTokenDigest('t1'), now: later,
    })).toBe('expired');
  });

  it('reopens the password budget in a later window', async () => {
    const store = createMemoryRecoveryChallengeStore();
    const now = new Date(BASE_NOW);
    for (let attempt = 0; attempt < RECOVERY_POLICY.attempts; attempt += 1) {
      expect(await store.admitPasswordAttempt({ fileDigest: 'a'.repeat(64), now })).toBe(true);
    }
    expect(await store.admitPasswordAttempt({ fileDigest: 'a'.repeat(64), now })).toBe(false);
    const later = new Date(now.getTime() + RECOVERY_POLICY.windowMs);
    expect(await store.admitPasswordAttempt({ fileDigest: 'a'.repeat(64), now: later })).toBe(true);
  });
});

describe('recovery lease semantics', () => {
  it('is exclusive, expires and only releases its own holder', async () => {
    const lock = createMemoryRecoveryLockStore();
    const now = new Date(BASE_NOW);
    expect(await lock.acquire({ holder: 'a', now, ttlMs: 1000 })).toBe(true);
    expect(await lock.acquire({ holder: 'b', now, ttlMs: 1000 })).toBe(false);
    expect(await lock.acquire({ holder: 'a', now, ttlMs: 1000 })).toBe(true);
    expect(await lock.release({ holder: 'b', now })).toBe(false);
    expect(lock.describe()?.holder).toBe('a');
    const later = new Date(now.getTime() + 5000);
    expect(await lock.acquire({ holder: 'b', now: later, ttlMs: 1000 })).toBe(true);
    expect(await lock.release({ holder: 'b', now: later })).toBe(true);
    expect(lock.describe()).toBeNull();
  });
});
