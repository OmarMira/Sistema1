#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

export const identitySuites = [
  'tests/identity/challenge-concurrency.integration.test.ts',
  'tests/identity/independent-contract.integration.test.ts',
  'tests/identity/s7-acceptance.integration.test.ts',
  'tests/identity/clean-deletion.integration.test.ts',
  'tests/identity/registration-atomic.integration.test.ts',
];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = 'Usage: node scripts/ci-test-isolated.mjs --help | --plan | --run [--focus] [--checks]\n';
const focusedFiles = [
  'tests/api/restore-known-password.test.ts',
  'tests/wave6/bootstrap-restore.test.ts',
];
export function localDockerHost(value = process.env.DOCKER_HOST) {
  const host = value || (process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock');
  if (!['npipe:////./pipe/docker_engine', 'unix:///var/run/docker.sock'].includes(host)) {
    throw new Error('Only the local Docker socket is allowed');
  }
  return host;
}
export function proveOwned(info, id, owner) {
  const ports = info?.NetworkSettings?.Ports?.['5432/tcp'];
  if (!/^[a-f0-9]{64}$/.test(id) || !/^proof-[a-f0-9]{32}$/.test(owner)
    || info?.Id !== id || info?.Config?.Labels?.['sistema1.scope'] !== 'identity-phase-a'
    || info?.Config?.Labels?.['sistema1.owner'] !== owner
    || !info?.State?.Running || info?.Mounts?.length !== 0
    || (info?.HostConfig?.Binds || []).length || !info?.HostConfig?.Tmpfs?.['/var/lib/postgresql/data']
    || ports?.length !== 1 || ports[0].HostIp !== '127.0.0.1'
    || !/^\d+$/.test(ports[0].HostPort) || Number(ports[0].HostPort) <= 0
    || Number(ports[0].HostPort) > 65535 || ports[0].HostPort === '5432') {
    throw new Error('Disposable container ownership/isolation proof failed');
  }
  return ports[0].HostPort;
}
export async function cleanupOwned(inspect, remove, id, owner) {
  proveOwned(await inspect(), id, owner);
  await remove(id);
}
function exec(command, args, env, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true,
      timeout: capture ? 30_000 : 900_000,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    if (capture) {
      child.stdout.on('data', chunk => { stdout += chunk; });
      // Docker inspection/credential errors must not print environment values.
      child.stderr.resume();
    }
    child.on('error', () => reject(new Error(`Could not start ${path.basename(command)}`)));
    child.on('exit', (code, signal) => resolve({ code: signal ? 1 : code ?? 1, stdout }));
  });
}
async function run(args) {
  const host = localDockerHost(); // Refuse remote contexts before any Docker invocation.
  const owner = `proof-${randomBytes(16).toString('hex')}`;
  const name = `sistema1-ci-${randomBytes(12).toString('hex')}`;
  const password = randomBytes(32).toString('hex');
  const env = { ...process.env, DOCKER_HOST: host, DOCKER_CONTEXT: '',
    NODE_ENV: 'test', HMAC_SECRET: 'ci-isolated-hmac-not-production', SESSION_SECRET: 'ci-isolated-session-not-production' };
  const docker = async (params, capture = true) => {
    const result = await exec('docker', ['--host', host, ...params], env, capture);
    if (result.code !== 0) throw new Error(`Docker ${params[0]} failed (exit ${result.code})`);
    return result.stdout.trim();
  };
  const tool = async (file, params, stageEnv = env) => exec(process.execPath, [path.join(root, 'node_modules', file), ...params], stageEnv);
  const vitest = (config, stageEnv, files = []) => tool('vitest/vitest.mjs', ['run', '--config', config, ...files], stageEnv);
  const backupDir = os.tmpdir();
  const dataDir = fs.mkdtempSync(path.join(backupDir, 'sistema1-ci-data-'));
  const bootstrapTemp = path.join(dataDir, 'tmp');
  fs.mkdirSync(bootstrapTemp);
  let id;
  let failure = 0;
  try {
    id = await docker(['run', '-d', '--rm', '--pull=never', '--name', name,
      '--label', 'sistema1.scope=identity-phase-a', '--label', `sistema1.owner=${owner}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid', '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_DB=identity_phase_a', '-e', 'POSTGRES_USER=identity_test',
      '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:16-alpine']);
    const inspect = async () => JSON.parse(await docker(['inspect', id]))[0];
    const port = proveOwned(await inspect(), id, owner);
    console.log(`Created isolated test resource ${name} on loopback port ${port}`);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      const check = await exec('docker', ['--host', host, 'exec', id, 'pg_isready', '-U', 'identity_test', '-d', 'identity_phase_a'], env, true);
      if (check.code === 0) { ready = true; break; }
      await delay(500);
    }
    // First-boot race: pg_isready can answer while initdb's temporary server
    // is still shutting down, so require two consecutive accepting checks.
    if (ready) {
      await delay(1000);
      const confirm = await exec('docker', ['--host', host, 'exec', id, 'pg_isready', '-U', 'identity_test', '-d', 'identity_phase_a'], env, true);
      ready = confirm.code === 0;
    }
    if (!ready) throw new Error('New PostgreSQL container did not become ready');
    const sql = async (statement, database = 'identity_phase_a', user = 'identity_test') => {
      proveOwned(await inspect(), id, owner);
      // Transient first-boot connection refusals surface as psql exit 2; retry
      // briefly and surface the tool's own stderr in the final failure.
      let lastCode = 0;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) await delay(1000 * attempt);
        const result = await exec('docker', ['--host', host, 'exec', id, 'psql', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', statement], env, true);
        lastCode = result.code;
        if (result.code === 0) return;
      }
      throw new Error(`psql exited ${lastCode} while preparing ${database} (see runner stderr for the statement's own error output)`);
    };
    for (const database of ['accountexpress_test', 'registration_test', 'clean_identity_test', 'accountexpress_bootstraptest']) {
      if (database !== 'accountexpress_test') await sql(`CREATE ROLE ${database} LOGIN PASSWORD '${password}'`);
      if (database === 'accountexpress_test') await sql(`CREATE DATABASE ${database} OWNER identity_test`); else await sql(`CREATE DATABASE ${database} OWNER identity_test`);
      // PostgreSQL 15+: CREATE TYPE requires ownership of the public schema.
      // Each database connects as its own role (identity_test for the main DB,
      // same-name role for the rest), so ownership must transfer to that role.
      const dbUser = database === 'accountexpress_test' ? 'identity_test' : database;
      await sql(`GRANT ALL ON SCHEMA public TO ${dbUser}; ALTER SCHEMA public OWNER TO ${dbUser}`, database);
      await sql('CREATE EXTENSION IF NOT EXISTS pg_trgm', database);
    }
    const url = (database, user = database) => `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
    const common = { ...env, ACCOUNTEXPRESS_DATA_DIR: dataDir, IDENTITY_TEST_CONTAINER_ID: id, IDENTITY_TEST_OWNER_PROOF: owner };
    const mainEnv = { ...common, DATABASE_URL: url('accountexpress_test', 'identity_test') };
    const bootstrapEnv = { ...common, DATABASE_URL: url('accountexpress_bootstraptest'), TMPDIR: backupDir, TMPNAME: bootstrapTemp };
    const stages = [
      ['application suite', () => vitest('vitest.config.ts', mainEnv, args.includes('--focus') ? focusedFiles : [])],
      // The installer node:test suites assert Windows-only behaviour (ACL,
      // drive paths, packaging); they never executed in CI before and cannot
      // pass on a Linux runner. They run in full on the authoring platform.
      ...(process.platform === 'win32' ? [['Node installer tests', () => exec(process.execPath, ['--test', ...fs.readdirSync(path.join(root, 'tests', 'installer')).filter(file => file.endsWith('.test.cjs')).map(file => path.join('tests', 'installer', file))], mainEnv)]] : []),
      ['identity contracts/concurrency', () => vitest('vitest.identity-integration.config.ts', { ...common, DATABASE_URL: url('identity_phase_a', 'identity_test') })],
      ['bootstrap security/recovery/memory', async () => {
        const schema = await tool('prisma/build/index.js', ['db', 'push', '--skip-generate'], bootstrapEnv);
        return schema.code === 0 ? vitest('vitest.forensic-f9.config.ts', bootstrapEnv) : schema;
      }],
      // The portable/bootstrap recovery suite used to be invisible to CI: nothing
      // invoked its runner and the root suite excludes it by design. It builds its
      // OWN disposable PostgreSQL from the repository migrations (not db push) and
      // proves the portable entry doors against that schema. It therefore gets an
      // environment without the shared application DATABASE_URL or the shared
      // runtime directory, which would otherwise aim it at this runner's database.
      ['portable recovery (migrations-built PostgreSQL)', () => {
        const portableEnv = { ...common };
        delete portableEnv.ACCOUNTEXPRESS_DATA_DIR;
        delete portableEnv.IDENTITY_TEST_CONTAINER_ID;
        delete portableEnv.IDENTITY_TEST_OWNER_PROOF;
        return exec(process.execPath, ['tests/portable-recovery-postgres/run.mjs'], portableEnv);
      }],
      // The startup self-migration contract was the other suite nothing invoked.
      // A real boot must find an EMPTY schema and apply every migration itself, so
      // the disposable database is recreated here: the bootstrap stage left it with
      // `db push`, which would make the contract a vacuous no-op. WITH (FORCE)
      // closes Prisma's pooled connections so the drop cannot be blocked.
      ['startup self-migrations (applies every migration)', async () => {
        await sql('DROP DATABASE IF EXISTS accountexpress_bootstraptest WITH (FORCE)', 'accountexpress_test', 'identity_test');
        await sql('CREATE DATABASE accountexpress_bootstraptest OWNER accountexpress_bootstraptest', 'accountexpress_test', 'identity_test');
        return vitest('tests/startup-migrations/vitest.config.mts', { ...common, DATABASE_URL: url('accountexpress_bootstraptest') });
      }],
    ];
    for (const [database, config, prefix] of [
      ['registration_test', 'vitest.registration-integration.config.ts', 'REGISTRATION'],
      ['clean_identity_test', 'vitest.clean-identity-integration.config.ts', 'CLEAN_IDENTITY'],
    ]) {
      const stageEnv = { ...common, DATABASE_URL: url(database), [`${prefix}_TEST_PORT`]: port, [`${prefix}_TEST_OWNED`]: owner };
      stages.push([database, async () => {
        const schema = await tool('prisma/build/index.js', ['db', 'push', '--skip-generate'], stageEnv);
        return schema.code === 0 ? vitest(config, stageEnv) : schema;
      }]);
    }
    if (args.includes('--checks')) {
      stages.push(['Prisma validate', () => tool('prisma/build/index.js', ['validate'], mainEnv)],
        ['TypeScript', () => tool('typescript/lib/tsc.js', ['--noEmit'], mainEnv)],
        ['ESLint', () => tool('eslint/bin/eslint.js', ['.'], mainEnv)],
        ['Next build', () => tool('next/dist/bin/next', ['build'], { ...mainEnv, NODE_ENV: 'production' })],
        ['secret scan', () => exec('gitleaks', ['detect', '--source', '.', '--no-git', '--config', '.gitleaks.toml', '--redact', '--exit-code', '1', '--no-banner'], mainEnv)]);
    }
    for (const [label, action] of stages) {
      console.log(`CHECK: ${label}`);
      const result = await action();
      console.log(`RESULT: ${label}: exit ${result.code}`);
      if (result.code !== 0 && !failure) failure = result.code;
    }
  } catch (error) {
    console.error(`Isolated runner failed: ${String(error.message).replaceAll(password, '[redacted]')}`);
    failure ||= 1;
  } finally {
    if (id) {
      try {
        await cleanupOwned(async () => JSON.parse(await docker(['inspect', id]))[0],
          ownedId => docker(['rm', '-f', ownedId]), id, owner);
        console.log('Owned test resource removed');
        const leftoverBackups = (fs.existsSync(path.join(dataDir, 'backups')) ? fs.readdirSync(path.join(dataDir, 'backups')).filter(f => /^(hdr1c-|f9-)/.test(f)) : []);
        const leftoverTemp = (fs.existsSync(bootstrapTemp) ? fs.readdirSync(bootstrapTemp) : []);
        if (leftoverBackups.length > 0 || leftoverTemp.length > 0) { console.error('Cleanup verification failed: leftover backups: ' + leftoverBackups.join(', ') + '; leftover temp: ' + leftoverTemp.join(', ')); failure ||= 2; } else { console.log('Cleanup verification passed'); }
      } catch {
        console.error(`Cleanup refused/failed; inspect the run-owned resource ${name}. No other resource was removed.`);
        failure ||= 1;
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return failure;
}
export async function main(args) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(help); return 0; }
  if (args.length === 1 && args[0] === '--plan') {
    console.log(JSON.stringify({ root: 'vitest.config.ts', dedicated: identitySuites })); return 0;
  }
  if (!args.includes('--run') || new Set(args).size !== args.length || args.some(arg => !['--run', '--focus', '--checks'].includes(arg))) {
    process.stderr.write('Invalid arguments.\n' + help); return 2;
  }
  try { return await run(args); }
  catch (error) { console.error(error.message); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
