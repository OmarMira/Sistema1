import { describe, it, expect } from 'vitest';
import { Evidence } from '../../src/internal/operation-controller/evidence';

describe('Evidence', () => {
  it('records entries in order', () => {
    const log = new Evidence();
    log.write('requested', 'int-1', 'Intent received');
    log.write('denied', 'int-1', 'Policy rejected');

    const entries = log.read();
    expect(entries).toHaveLength(2);
    expect(entries[0].state).toBe('requested');
    expect(entries[1].state).toBe('denied');
  });

  

  it('modifying snapshot after write() does not alter stored evidence', () => {
    const log = new Evidence();
    const originalSnapshot = { file: 'a.txt', hash: 'abc' };

    log.write('authorized', 'int-1', 'Contract created', originalSnapshot);
    originalSnapshot.hash = 'mutated';

    const entries = log.read();
    expect(entries[0].snapshot?.hash).toBe('abc');
  });

  it('modifying snapshot from read() does not alter stored evidence', () => {
    const log = new Evidence();
    log.write('authorized', 'int-1', 'Contract created', { file: 'a.txt', hash: 'abc' });

    const entries = log.read();
    if (entries[0].snapshot) {
      entries[0].snapshot.hash = 'mutated';
    }

    const entriesAgain = log.read();
    expect(entriesAgain[0].snapshot?.hash).toBe('abc');
  });
});