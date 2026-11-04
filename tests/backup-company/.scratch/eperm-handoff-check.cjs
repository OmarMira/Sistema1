const fs = require('node:fs'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const before = JSON.parse(fs.readFileSync('tests/backup-company/.scratch/eperm-before-binding.json', 'utf8'));
const changed = Object.keys(before).filter(file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== before[file]);
assert.deepEqual(changed, ['src/lib/backup-storage.ts']);
console.log('PASS: only backup-storage.ts changed among 6 product files, 2 configs and the byte-bound PG artifact');
console.log('STORAGE_SHA256', crypto.createHash('sha256').update(fs.readFileSync(changed[0])).digest('hex'));
let additions = 0, deletions = 0;
for (const file of ['src/lib/backup-storage.ts', 'docs/company-backup-format.md', 'docs/company-backup-recovery.md']) {
  const original = 'tests/backup-company/.scratch/eperm-before-' + file.split('/').pop();
  const result = spawnSync('git', ['diff', '--no-index', '--numstat', '--', original, file], { encoding: 'utf8' });
  assert([0,1].includes(result.status), result.stderr);
  const [add, del] = result.stdout.trim().split('\t').slice(0,2).map(Number);
  additions += add; deletions += del; console.log(`+${add}/-${del}`, file);
}
const file = 'tests/backup-company/catalog-publication.test.ts';
const count = fs.readFileSync(file, 'utf8').split('\n').length - 1;
additions += count; console.log(`+${count}/-0`, file);
for (const file of ['src/lib/backup-storage.ts', 'tests/backup-company/catalog-publication.test.ts', 'docs/company-backup-format.md', 'docs/company-backup-recovery.md']) {
  const text = fs.readFileSync(file, 'utf8');
  assert(!/[^\S\r\n]+$/m.test(text), 'trailing whitespace: ' + file);
  assert(!/^(<<<<<<<|=======|>>>>>>>)/m.test(text), 'conflict marker: ' + file);
}
console.log(`TASK_DELTA +${additions}/-${deletions}; authored=${additions+deletions}`);
console.log('PASS scoped tracked/untracked whitespace and conflict checks');
