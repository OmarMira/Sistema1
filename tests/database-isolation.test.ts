import { describe, it, expect } from 'vitest';
import { db } from '@/lib/db';

describe('Database isolation', () => {
  it('should connect to accountexpress_test, never to production', async () => {
    const [{ current_database }] = await db.$queryRaw<Array<{ current_database: string }>>`
      SELECT current_database()
    `;

    expect(current_database).toBe('accountexpress_test');
  });

  it('should have NODE_ENV=test', () => {
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('should have DATABASE_URL pointing to test database', () => {
    const dbName = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, '');
    expect(dbName).toBe('accountexpress_test');
  });
});
