'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '../../installer/windows/preflight.cjs');
function fixture() {
  const root = fs.mkdtempSync(path.join(__dirname, '.windows-preflight-'));
  return { root, config: { programDir: path.join(root, 'Programas José', 'AccountExpress'), dataDir: path.join(root, 'Datos contables'), requiredProgramBytes: 1024, requiredDataBytes: 1024 }, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
function run(config, services) { return require(source).preflight(config, services); }

test('accepts writable local paths with spaces/Unicode without creating destination folders', () => {
  const f = fixture();
  try {
    const result = run(f.config);
    assert.equal(result.ok, true); assert.equal(result.code, 'ready');
    assert.equal(result.programDir, path.win32.normalize(f.config.programDir));
    assert.equal(result.dataDir, path.win32.normalize(f.config.dataDir));
    assert.equal(result.requiredBytes, '2048'); assert.ok(BigInt(result.availableBytes) >= 2048n);
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally { f.close(); }
});

test('rejects relative, drive-root, device, UNC, reserved and traversal paths without writes', () => {
  const f = fixture();
  try {
    for (const programDir of ['relative/path', 'C:relative', 'C:\\', '\\\\server\\share\\AccountExpress', '\\\\?\\C:\\AccountExpress', path.join(f.root, 'CON'), path.join(f.root, 'AUX.txt'), path.join(f.root, 'folder.'), path.join(f.root, 'folder '), f.root + '\\..\\escape', 'C:\\Windows\\AccountExpress', path.join(f.root, 'bad\nname')]) {
      const result = run({ ...f.config, programDir });
      assert.deepEqual(result, { ok: false, code: 'invalid_path' }, programDir);
      assert.deepEqual(fs.readdirSync(f.root), []);
    }
  } finally { f.close(); }
});

test('keeps program binaries and durable data in separate non-overlapping destinations', () => {
  const f = fixture();
  try {
    for (const dataDir of [f.config.programDir, path.join(f.config.programDir, 'data'), path.dirname(f.config.programDir)]) {
      assert.deepEqual(run({ ...f.config, dataDir }), { ok: false, code: 'overlapping_paths' });
      assert.deepEqual(fs.readdirSync(f.root), []);
    }
  } finally { f.close(); }
});

test('existing files, installations and data are rejected without altering stored bytes', () => {
  for (const target of ['programDir', 'dataDir']) {
    const f = fixture();
    try {
      fs.mkdirSync(f.config[target], { recursive: true });
      const sentinel = path.join(f.config[target], 'keep-me.txt'); fs.writeFileSync(sentinel, 'existing accounting data');
      const result = run(f.config);
      assert.deepEqual(result, { ok: false, code: target === 'programDir' ? 'destination_not_empty' : 'existing_data' });
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'existing accounting data');
      assert.deepEqual(fs.readdirSync(f.config[target]), ['keep-me.txt']);
    } finally { f.close(); }
  }
  const f = fixture();
  try {
    fs.mkdirSync(f.config.programDir, { recursive: true });
    fs.writeFileSync(path.join(f.config.programDir, '.accountexpress-install.json'), '{"version":1}');
    assert.deepEqual(run(f.config), { ok: false, code: 'already_installed' });
    assert.equal(fs.readFileSync(path.join(f.config.programDir, '.accountexpress-install.json'), 'utf8'), '{"version":1}');
  } finally { f.close(); }
  const file = fixture();
  try {
    fs.mkdirSync(path.dirname(file.config.programDir), { recursive: true });
    fs.writeFileSync(file.config.programDir, 'an existing file, not a directory');
    assert.deepEqual(run(file.config), { ok: false, code: 'not_directory' });
    assert.equal(fs.readFileSync(file.config.programDir, 'utf8'), 'an existing file, not a directory');
  } finally { file.close(); }
});

test('junction/reparse paths are rejected and their target remains unchanged', () => {
  const f = fixture();
  try {
    const outside = path.join(f.root, 'unrelated'), link = path.join(f.root, 'junction');
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'untouched');
    fs.symlinkSync(outside, link, 'junction');
    assert.deepEqual(run({ ...f.config, programDir: path.join(link, 'AccountExpress') }), { ok: false, code: 'unsafe_link' });
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'untouched');
    assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
  } finally { f.close(); }
});

test('insufficient disk space and denied write permission never report success', () => {
  const f = fixture();
  try {
    let probes = 0;
    assert.deepEqual(run(f.config, { availableBytes: () => 1n, probeWrite: () => { probes++; } }), { ok: false, code: 'insufficient_space' });
    assert.equal(probes, 0);
    assert.deepEqual(run(f.config, { availableBytes: () => 999999n, probeWrite: () => { const error = Error('private OS detail'); error.code = 'EACCES'; throw error; } }), { ok: false, code: 'permission_denied' });
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally { f.close(); }
});

test('invalid size estimates fail closed instead of skipping free-space verification', () => {
  const f = fixture();
  try {
    for (const requiredProgramBytes of [0, -1, NaN, Infinity, '1024', Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(run({ ...f.config, requiredProgramBytes }), { ok: false, code: 'invalid_size' });
      assert.deepEqual(fs.readdirSync(f.root), []);
    }
  } finally { f.close(); }
});

test('public CLI returns exact sanitized rejection with failure exit and no stderr', () => {
  const f = fixture();
  try {
    const result = spawnSync(process.execPath, [source, '--program-dir', 'relative', '--data-dir', f.config.dataDir, '--program-bytes', '1024', '--data-bytes', '1024'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, '{"ok":false,"code":"invalid_path"}\n'); assert.equal(result.stderr, '');
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally { f.close(); }
});
