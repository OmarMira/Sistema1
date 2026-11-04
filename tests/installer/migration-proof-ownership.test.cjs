'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const source = path.resolve(__dirname, '../../installer/windows/check-migrations.cjs');
const { proveOwned } = require(source);
const id = 'a'.repeat(64), owner = 'proof-' + 'b'.repeat(32);
function fixture() { return { Id: id, State: { Running: true }, Config: { Labels: { 'accountexpress.proof.owner': owner, 'accountexpress.proof.scope': 'windows-migrations' } }, HostConfig: { Binds: [], Tmpfs: { '/var/lib/postgresql/data': 'rw,nosuid' } }, Mounts: [], NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '51234' }] } } }; }

test('permits only its running owned tmpfs resource on an ephemeral loopback port', () => {
  const info = fixture(), before = JSON.stringify(info);
  assert.equal(proveOwned(info, id, owner), '51234');
  assert.equal(JSON.stringify(info), before);
  for (const change of [
    x => { x.Id = 'c'.repeat(64); }, x => { x.State.Running = false; },
    x => { x.Config.Labels['accountexpress.proof.owner'] = 'another-owner'; },
    x => { x.Config.Labels['accountexpress.proof.scope'] = 'another-scope'; },
    x => { x.HostConfig.Binds = ['some-existing-data:/var/lib/postgresql/data']; },
    x => { x.HostConfig.Tmpfs = {}; }, x => { x.Mounts = [{ Type: 'volume', Destination: '/var/lib/postgresql/data' }]; },
    x => { x.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0'; },
    x => { x.NetworkSettings.Ports['5432/tcp'][0].HostPort = '5432'; },
    x => { x.NetworkSettings.Ports['5432/tcp'][0].HostPort = '65536'; },
  ]) {
    const rejected = fixture(); change(rejected); const snapshot = JSON.stringify(rejected);
    assert.throws(() => proveOwned(rejected, id, owner), /ownership\/isolation/);
    assert.equal(JSON.stringify(rejected), snapshot);
  }
});

test('public proof CLI rejects supplied database destinations without connecting to anything', () => {
  const result = spawnSync(process.execPath, [source, '--run', '--database-url', 'postgresql://invalid.invalid/never-connect'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 2); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Invalid options; use --help.\n');
});
