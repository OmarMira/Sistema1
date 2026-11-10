import { describe, expect, it } from 'vitest';

/**
 * Regression (T14 follow-up): IdentitySecurityEvent.id is a uuid column; the
 * recovery store must cast the randomUUID text parameter explicitly, exactly
 * like src/lib/identity/repository.ts does, or PostgreSQL answers 42804 and
 * the recovery challenge is never issued (token email never sent).
 * Pinned through the public store API with a capturing raw client.
 */
import { createPostgresRecoveryChallengeStore } from '@/lib/backup-recovery-auth';

describe('recovery security event insert', () => {
  it('casts the event id to uuid like the identity repository', async () => {
    const captured: Array<{ query: string }> = [];
    const client = {
      $queryRawUnsafe: async () => [],
      $executeRawUnsafe: async (query: string) => {
        captured.push({ query });
        return 1;
      },
    };
    const store = createPostgresRecoveryChallengeStore(client as never);
    await store.recordEvent(
      'challenge_issued',
      'bootstrap-recovery:'.concat('a'.repeat(64)),
      new Date('2026-01-01T00:00:00Z'),
    );
    const event = captured.find((entry) => entry.query.includes('IdentitySecurityEvent'));
    expect(event).toBeDefined();
    expect(event!.query).toContain('$1::uuid');
  });
});
