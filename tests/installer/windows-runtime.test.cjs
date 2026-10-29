'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const base = path.resolve('installer/windows/.checks');
fs.mkdirSync(base, { recursive: true });
const launcher = path.resolve('installer/windows/launcher.cjs');
function call(args, cwd) { return spawnSync(process.execPath, [launcher, ...args], { cwd, encoding: 'utf8', timeout: 15000 }); }
test('status and invalid options never create data or installation configuration', () => {
  const root = fs.mkdtempSync(path.join(base, 'runtime-test-'));
  try {
    const before = fs.readdirSync(root);
    const status = call(['--status', '--app-dir', root], root);
    assert.equal(status.status, 0, status.stderr); assert.equal(status.stderr, '');
    assert.equal(JSON.parse(status.stdout).configured, false);
    assert.deepEqual(fs.readdirSync(root), before);
    const invalid = call(['--invented', '--app-dir', root], root);
    assert.equal(invalid.status, 2); assert.equal(invalid.stdout, ''); assert.match(invalid.stderr, /Invalid options/);
    assert.deepEqual(fs.readdirSync(root), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('configure separates data, generates independent secrets and refuses replacement without mutation', () => {
  const root = fs.mkdtempSync(path.join(base, 'configure-test-'));
  try {
    const app = path.join(root, 'app'), data = path.join(root, 'data'); fs.mkdirSync(app);
    const configured = call(['--configure', '--app-dir', app, '--data-dir', data], root);
    assert.equal(configured.status, 0, configured.stderr); assert.equal(configured.stderr, '');
    const file = path.join(data, 'instance.json'); const original = fs.readFileSync(file);
    const config = JSON.parse(original);
    assert.equal(config.dataDir.toLowerCase(), data.toLowerCase());
    assert.notEqual(config.sessionSecret, config.hmacSecret);
    assert.notEqual(config.identityKey, config.sessionSecret);
    assert.ok(Buffer.from(config.identityKey, 'base64').length >= 32);
    assert.equal(configured.stdout.includes(config.sessionSecret), false);
    const rejected = call(['--configure', '--app-dir', app, '--data-dir', data], root);
    assert.equal(rejected.status, 1); assert.equal(rejected.stdout, '');
    assert.deepEqual(fs.readFileSync(file), original);
    const status = call(['--status', '--app-dir', app], root);
    assert.equal(status.status, 0); assert.equal(status.stderr, '');
    const output = JSON.parse(status.stdout); assert.equal(output.configured, true); assert.equal(output.running, false);
    assert.equal(status.stdout.includes(config.sessionSecret), false);
    const overlap = call(['--configure', '--app-dir', app, '--data-dir', path.join(app, 'unsafe')], root);
    assert.equal(overlap.status, 1); assert.equal(fs.existsSync(path.join(app, 'unsafe')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
