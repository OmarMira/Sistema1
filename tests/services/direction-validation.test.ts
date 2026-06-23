import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: { glAccount: { findUnique: vi.fn() } },
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

import { db } from '@/lib/db';
import { validateDirectionProfile } from '@/lib/services/direction-validation';

const mockFindUnique = db.glAccount.findUnique as unknown as Mock;

function account(overrides: Record<string, any> = {}): any {
  return { id: 'acct-1', name: 'Caja', code: '1010', companyId: 'c1', accountType: 'asset', ...overrides };
}

describe('validateDirectionProfile', () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
  });

  it('returns true when account matches its normal balance', async () => {
    mockFindUnique.mockResolvedValue(account({ code: '1010' }));
    await expect(validateDirectionProfile('c1', 'acct-1', null)).resolves.toBe(true);
  });

  it('returns true when account class has no profile', async () => {
    mockFindUnique.mockResolvedValue(account({ code: '9000', accountType: 'other' }));
    await expect(validateDirectionProfile('c1', 'acct-1', null)).resolves.toBe(true);
  });

  it('throws when debit account has normalBalance=credit and allowOpposite=false', async () => {
    mockFindUnique.mockResolvedValue(account({ code: '4010', accountType: 'revenue' }));
    await expect(validateDirectionProfile('c1', 'acct-1', null)).rejects.toThrow(
      'normal balance of crédito but is being used for débito transactions',
    );
  });

  it('throws when credit account has normalBalance=debit and allowOpposite=false', async () => {
    mockFindUnique.mockResolvedValue(account({ code: '5010', accountType: 'expense' }));
    await expect(validateDirectionProfile('c1', null, 'acct-1')).rejects.toThrow(
      'normal balance of débito but is being used for crédito transactions',
    );
  });

  it('allows opposite when profile has allowOpposite=true', async () => {
    mockFindUnique.mockResolvedValue(account({ code: '1010' }));
    await expect(validateDirectionProfile('c1', 'acct-1', null)).resolves.toBe(true);
  });

  it('throws when account does not belong to company', async () => {
    mockFindUnique.mockResolvedValue(null);
    await expect(validateDirectionProfile('c1', 'acct-1', null)).rejects.toThrow(
      'GL account not found or does not belong to this company',
    );
  });

  it('throws when account has no accountType', async () => {
    mockFindUnique.mockResolvedValue(account({ accountType: null }));
    await expect(validateDirectionProfile('c1', 'acct-1', null)).rejects.toThrow(
      'has no accountType defined',
    );
  });

  it('validates both debit and credit accounts together', async () => {
    mockFindUnique.mockResolvedValue(account({ code: '1010' }));
    await expect(validateDirectionProfile('c1', 'acct-1', 'acct-2')).resolves.toBe(true);
  });

  it('throws on first account when both are invalid', async () => {
    mockFindUnique.mockResolvedValue(null);
    await expect(validateDirectionProfile('c1', 'bad-1', 'bad-2')).rejects.toThrow(
      'GL account not found',
    );
  });

  it('no-ops when both account ids are null', async () => {
    await expect(validateDirectionProfile('c1', null, null)).resolves.toBe(true);
  });
});
