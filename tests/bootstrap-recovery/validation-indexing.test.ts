import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import { checkReferences, ownedRows, RESTORE_MODELS, type Tables } from '@/lib/backup-validation';

function fixture() {
  let idReads = 0;
  const tables: Tables = Object.fromEntries(Object.values(RESTORE_MODELS).map(model => [model, []]));
  tables.Company = [{ id: 'tenant' }];
  tables.GlAccount = [{ id: 'account', companyId: 'tenant', parentId: null }];
  tables.JournalEntry = Array.from({ length: 256 }, (_, index) => ({
    get id() { idReads++; return `entry-${index}`; }, companyId: 'tenant',
  }));
  tables.JournalLine = Array.from({ length: 512 }, (_, index) => ({
    id: `line-${index}`, entryId: `entry-${index % 256}`, glAccountId: 'account',
  }));
  return { tables, reads: () => idReads };
}

describe('indexed restore admission retains reference and ownership rules', () => {
  it('checks valid references without rescanning every journal entry for every line', () => {
    const { tables, reads } = fixture();
    expect(() => checkReferences(tables)).not.toThrow();
    expect(reads()).toBeLessThan(2048);
    tables.JournalLine[0].entryId = 'missing-entry';
    expect(() => checkReferences(tables)).toThrow('RESTORE_REFERENCE: JournalLine.entryId');
    expect(tables.JournalLine).toHaveLength(512);
  });

  it('selects only owned descendants without repeated parent scans', () => {
    const { tables, reads } = fixture();
    tables.JournalLine.push({ id: 'foreign-line', entryId: 'foreign-entry', glAccountId: 'account' });
    const selected = ownedRows('tenant', tables);
    expect(selected.JournalLine).toHaveLength(512);
    expect(selected.JournalLine[0]).toBe(tables.JournalLine[0]);
    expect(selected.JournalLine.some(row => row.id === 'foreign-line')).toBe(false);
    expect(reads()).toBeLessThan(2048);
    expect(tables.JournalLine).toHaveLength(513);
  });
});
