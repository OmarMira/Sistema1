#!/usr/bin/env node
'use strict';
// Development proof only. Owns a new disposable PostgreSQL container; never accepts an existing DB URL.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const localSocket = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
const prerequisite = '20261019000301_identity_transition_action_prerequisite';
const oldTransition = '20261019000400_legacy_user_transition';
const help = `AccountExpress isolated fresh-migration proof
node installer/windows/check-migrations.cjs --run | --help

--run creates a NEW owned disposable PostgreSQL container from the already cached
postgres:16-alpine image (--pull=never), on an ephemeral 127.0.0.1 port, with tmpfs
storage and new test-only credentials. No existing database URL is accepted.
It runs actual prisma migrate deploy (never db push), then a historical upgrade
simulation. The simulation applies the documented historical CHECK repair only
inside its new empty test database; no migration history is faked or resolved.
Only the owned container and private generated workspace may be removed.
No image pull, SMTP, app startup, registry/service change or production DB access.
Exit 0=proof passed, 1=proof failed/unavailable, 2=invalid command options.
`;
function proveOwned(info, id, owner) {
  const ports = info?.NetworkSettings?.Ports?.['5432/tcp'];
  if (!/^[a-f0-9]{64}$/.test(id) || info?.Id !== id || !info.State?.Running || info.Config?.Labels?.['accountexpress.proof.owner'] !== owner
    || info.Config?.Labels?.['accountexpress.proof.scope'] !== 'windows-migrations'
    || (info.HostConfig?.Binds || []).length || !info.HostConfig?.Tmpfs?.['/var/lib/postgresql/data']
    || (info.Mounts || []).some(m => m.Type !== 'tmpfs' || m.Destination !== '/var/lib/postgresql/data')
    || ports?.length !== 1 || ports[0].HostIp !== '127.0.0.1' || !/^\d+$/.test(ports[0].HostPort)
    || Number(ports[0].HostPort) < 1 || Number(ports[0].HostPort) > 65535 || ports[0].HostPort === '5432') throw Error('Disposable resource ownership/isolation check failed');
  return ports[0].HostPort;
}
function isolatedEnvironment() {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, DOCKER_HOST: localSocket, DOCKER_CONTEXT: '', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', NODE_ENV: 'test' };
}
async function run() {
  const owner = 'proof-' + randomBytes(16).toString('hex');
  const name = 'ae-migration-proof-' + randomBytes(12).toString('hex');
  const password = randomBytes(32).toString('hex');
  const checks = path.join(__dirname, '.checks');
  if (fs.existsSync(checks) && fs.lstatSync(checks).isSymbolicLink()) throw Error('Unsafe proof workspace');
  fs.mkdirSync(checks, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(checks, 'migration-'));
  const env = isolatedEnvironment(); env.DOCKER_CONFIG = path.join(workspace, '.docker');
  fs.mkdirSync(env.DOCKER_CONFIG); fs.writeFileSync(path.join(env.DOCKER_CONFIG, 'config.json'), '{}', { flag: 'wx' });
  let id, port, failure;
  const clean = text => String(text || '').split(password).join('[test-credential-redacted]');
  const exec = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: workspace, env, encoding: 'utf8', windowsHide: true, timeout: 60000, ...options });
    if (result.error) throw Error('Could not run ' + path.basename(command) + ': ' + result.error.code);
    return { code: result.status ?? 1, stdout: clean(result.stdout), stderr: clean(result.stderr) };
  };
  const docker = args => {
    const result = exec('docker', ['--host', localSocket, ...args]);
    if (result.code) throw Error('Local Docker ' + args[0] + ' failed: ' + result.stderr.trim());
    return result.stdout.trim();
  };
  const owned = () => proveOwned(JSON.parse(docker(['inspect', id]))[0], id, owner);
  const sql = (database, statement) => {
    owned();
    return docker(['exec', id, 'psql', '-U', 'migration_test', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement]);
  };
  const stage = (directory, names) => {
    fs.mkdirSync(path.join(directory, 'prisma', 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), '{"private":true}', { flag: 'wx' });
    fs.copyFileSync(path.join(root, 'prisma/schema.prisma'), path.join(directory, 'prisma/schema.prisma'));
    fs.copyFileSync(path.join(root, 'prisma/migrations/migration_lock.toml'), path.join(directory, 'prisma/migrations/migration_lock.toml'));
    for (const name of names) {
      fs.mkdirSync(path.join(directory, 'prisma/migrations', name));
      fs.copyFileSync(path.join(root, 'prisma/migrations', name, 'migration.sql'), path.join(directory, 'prisma/migrations', name, 'migration.sql'));
    }
  };
  try {
    const prismaCli = require.resolve('prisma/build/index.js', { paths: [root] });
    const engines = path.dirname(require.resolve('@prisma/engines/package.json', { paths: [path.dirname(prismaCli)] }));
    const engine = path.join(engines, process.platform === 'win32' ? 'schema-engine-windows.exe' : 'schema-engine-debian-openssl-3.0.x');
    if (!fs.existsSync(engine)) throw Error('Local Prisma schema engine unavailable; automatic downloads disabled');
    env.PRISMA_SCHEMA_ENGINE_BINARY = engine;
    docker(['image', 'inspect', 'postgres:16-alpine', '--format', '{{.Id}}']);
    id = docker(['run', '-d', '--rm', '--pull=never', '--name', name,
      '--label', 'accountexpress.proof.owner=' + owner, '--label', 'accountexpress.proof.scope=windows-migrations',
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_DB=fresh_install', '-e', 'POSTGRES_USER=migration_test', '-e', 'POSTGRES_PASSWORD=' + password, 'postgres:16-alpine']);
    port = owned(); console.log('Created new owned disposable PostgreSQL resource on loopback port ' + port);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      owned();
      if (exec('docker', ['--host', localSocket, 'exec', id, 'pg_isready', '-U', 'migration_test', '-d', 'fresh_install']).code === 0) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw Error('Owned PostgreSQL readiness deadline exceeded');
    const deploy = (directory, database, label) => {
      owned();
      const result = exec(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', path.join(directory, 'prisma/schema.prisma')], { cwd: directory, env: { ...env, DATABASE_URL: 'postgresql://migration_test:' + password + '@127.0.0.1:' + port + '/' + database } });
      console.log(label + ': exit ' + result.code);
      process.stdout.write(result.stdout); process.stderr.write(result.stderr);
      if (result.code) throw Error(label + ' failed');
    };
    const migrationRoot = path.join(root, 'prisma/migrations');
    const all = fs.readdirSync(migrationRoot).filter(name => fs.statSync(path.join(migrationRoot, name)).isDirectory()).sort();
    const fresh = path.join(workspace, 'fresh'); stage(fresh, all);
    deploy(fresh, 'fresh_install', 'Fresh migration replay');
    if (sql('fresh_install', 'SELECT (SELECT count(*) FROM "User") || \'|\' || (SELECT count(*) FROM "Company");') !== '0|0') throw Error('Fresh database unexpectedly contains users or companies');
    // Model the historical manual CHECK repair in a NEW empty database only.
    sql('fresh_install', 'CREATE DATABASE legacy_install OWNER migration_test;');
    const baseline = all.filter(name => name !== prerequisite), beforeTransition = baseline.filter(name => name < oldTransition);
    const legacy = path.join(workspace, 'legacy'); stage(legacy, beforeTransition);
    deploy(legacy, 'legacy_install', 'Historical pre-transition replay');
    sql('legacy_install', fs.readFileSync(path.join(migrationRoot, '20261019000401_legacy_transition_audit_fix/migration.sql'), 'utf8'));
    for (const name of baseline.filter(name => !beforeTransition.includes(name))) {
      fs.mkdirSync(path.join(legacy, 'prisma/migrations', name));
      fs.copyFileSync(path.join(migrationRoot, name, 'migration.sql'), path.join(legacy, 'prisma/migrations', name, 'migration.sql'));
    }
    deploy(legacy, 'legacy_install', 'Historical repaired baseline replay');
    const historySql = 'SELECT migration_name || \':\' || checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name;';
    const before = sql('legacy_install', historySql);
    fs.mkdirSync(path.join(legacy, 'prisma/migrations', prerequisite));
    fs.copyFileSync(path.join(migrationRoot, prerequisite, 'migration.sql'), path.join(legacy, 'prisma/migrations', prerequisite, 'migration.sql'));
    deploy(legacy, 'legacy_install', 'Additive prerequisite upgrade');
    const after = sql('legacy_install', historySql).split('\n').filter(line => !line.startsWith(prerequisite + ':')).join('\n');
    if (after !== before) throw Error('Existing applied migration names/checksums changed');
    if (sql('legacy_install', 'SELECT (SELECT count(*) FROM "User") || \'|\' || (SELECT count(*) FROM "Company");') !== '0|0') throw Error('Upgrade unexpectedly changed users or companies');
    console.log('PASS: fresh deploy and additive historical upgrade; existing applied checksums unchanged; no preseeded users/companies.');
  } catch (error) { failure = error; }
  finally {
    if (id) {
      try { owned(); docker(['rm', '-f', id]); console.log('Removed only the proven-owned disposable PostgreSQL resource.'); }
      catch { failure = failure || Error('Owned container cleanup failed: ' + name); console.error('Cleanup could not be proven/completed for ' + name + '; no other resource was removed.'); }
    }
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  if (failure) throw failure;
}
module.exports = { proveOwned };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') process.stdout.write(help);
  else if (args.length === 1 && args[0] === '--run') run().catch(error => { console.error('Isolated migration proof: ' + error.message); process.exitCode = 1; });
  else { process.stderr.write('Invalid options; use --help.\n'); process.exitCode = 2; }
}
