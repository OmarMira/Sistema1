'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { copyPostgres } = require('../../installer/windows/payload.cjs');
const base = path.resolve('installer/windows/.checks');
fs.mkdirSync(base, { recursive: true });
const invoke = (file, args, cwd) => spawnSync(process.execPath, [path.resolve('installer/windows', file), ...args], { cwd, encoding: 'utf8', timeout: 15000 });
test('packaging rejects unknown options without reporting a successful build', () => {
  const r = invoke('build.cjs', ['--invented']);
  assert.equal(r.status, 2); assert.equal(r.stdout, ''); assert.match(r.stderr, /Invalid options/);
});
test('PostgreSQL staging retains runtime and notices without pgAdmin or auxiliary installers', () => {
  const scratch=fs.mkdtempSync(path.join(base,'postgres-package-'));
  try {
    const source=path.join(scratch,'pgsql'),destination=path.join(scratch,'runtime');
    for(const name of ['bin/postgres.exe','lib/pgcrypto.dll','share/extension/pgcrypto.control','server_license.txt','commandlinetools_3rd_party_licenses.txt','pgAdmin 4/web/unneeded.py','StackBuilder/setup.exe','include/server/unneeded.h']) {
      const file=path.join(source,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,name);
    }
    copyPostgres(source,destination);
    for(const name of ['bin/postgres.exe','lib/pgcrypto.dll','share/extension/pgcrypto.control','server_license.txt','commandlinetools_3rd_party_licenses.txt']) assert.equal(fs.readFileSync(path.join(destination,name),'utf8'),name);
    for(const name of ['pgAdmin 4','StackBuilder','include']) assert.equal(fs.existsSync(path.join(destination,name)),false);
  } finally {fs.rmSync(scratch,{recursive:true,force:true});}
});
test('payload CLI copies production output and assets, excludes all credentials and developer data', () => {
  const scratch = fs.mkdtempSync(path.join(base, 'package-test-'));
  try {
    const source = path.join(scratch, 'source'), destination = path.join(scratch, 'payload');
    fs.mkdirSync(path.join(source, '.next/standalone'), { recursive: true });
    fs.writeFileSync(path.join(source, '.next/standalone/server.js'), '/* fixture */');
    fs.writeFileSync(path.join(source, '.next/standalone/.env'), 'DO_NOT_SHIP=secret');
    const modules = path.join(source, '.next/standalone/node_modules');
    fs.mkdirSync(path.join(modules, '.cache/old'), { recursive: true });
    fs.symlinkSync(modules, path.join(modules, '.cache/old/node_modules'), 'junction');
    fs.mkdirSync(path.join(source, '.next/static'), { recursive: true });
    fs.writeFileSync(path.join(source, '.next/static/a.js'), 'static');
    fs.mkdirSync(path.join(source, 'public/uploads/logos'), { recursive: true });
    fs.writeFileSync(path.join(source, 'public/uploads/logos/private.png'), 'private');
    fs.writeFileSync(path.join(source, 'public/hero-dashboard.png'), 'background');
    fs.mkdirSync(path.join(source, 'rules/defaults'), { recursive: true });
    fs.writeFileSync(path.join(source, 'rules/defaults/company-config.default.json'), '{}');
    const r = invoke('payload.cjs', ['--source', source, '--destination', destination]);
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, '');
    assert.equal(fs.readFileSync(path.join(destination, 'server.js'), 'utf8'), '/* fixture */');
    assert.equal(fs.readFileSync(path.join(destination, '.next/static/a.js'), 'utf8'), 'static');
    assert.equal(fs.readFileSync(path.join(destination, 'public/hero-dashboard.png'), 'utf8'), 'background');
    assert.equal(fs.existsSync(path.join(destination, '.env')), false);
    assert.equal(fs.existsSync(path.join(destination, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(destination, 'public/uploads')), false);
    const before = fs.readFileSync(path.join(destination, 'server.js'));
    const rejected = invoke('payload.cjs', ['--source', source, '--destination', destination]);
    assert.equal(rejected.status, 1); assert.equal(rejected.stdout, '');
    assert.deepEqual(fs.readFileSync(path.join(destination, 'server.js')), before);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
