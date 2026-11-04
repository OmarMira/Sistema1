'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const source = path.join(root, 'installer/windows/check-migrations.cjs');
const digest = () => createHash('sha256').update(fs.readFileSync(source)).digest('hex');
test('S1/S4: prerequisite is transactional, ordered, and matches existing repair', () => {
  const name = '20261019000301_identity_transition_action_prerequisite';
  const read = n => fs.readFileSync(path.join(root, 'prisma/migrations', n, 'migration.sql'), 'utf8');
  const sql = read(name), repair = read('20261019000401_legacy_transition_audit_fix');
  assert.ok('20261019000300_identity_bootstrap' < name && name < '20261019000400_legacy_user_transition');
  assert.match(sql, /BEGIN;\s*ALTER TABLE/);
  assert.match(sql, /COMMIT;\s*$/);
  const actions = s => s.match(/CHECK \(action IN \(([^)]+)\)\)/)[1];
  assert.equal(actions(sql), actions(repair));
  assert.match(actions(sql), /'transition_started'/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\s/i);
});
test('S1: invalid public options reject exactly without generated state or byte changes', () => {
  const directory = path.dirname(source);
  const snapshot = () => JSON.stringify(fs.readdirSync(directory).sort());
  for (const args of [[], ['--run', '--help'], ['--help', '--help'], ['--unknown'],
    ['--run', '--database-url=postgresql://invalid.invalid/never-connect'], ['--run', '']]) {
    const before = digest(), entries = snapshot();
    const result = spawnSync(process.execPath, [source, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Invalid options; use --help.\n');
    assert.equal(digest(), before);
    assert.equal(snapshot(), entries);
  }
});
