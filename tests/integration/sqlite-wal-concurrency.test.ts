import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { generateTestUser } from '../helpers/test-data-factory';

describe('SQLite WAL Concurrency', () => {
  beforeAll(() => {
    expect(process.env.DATABASE_URL).toContain('test.db');
  });

  it('debe soportar escrituras concurrentes sin bloqueos', async () => {
    const writes = Array.from({ length: 5 }, () =>
      db.user.create({ data: generateTestUser() })
    );

    const results = await Promise.allSettled(writes);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(4);
  });

  afterAll(async () => {
    await db.user.deleteMany({});
  });
});
