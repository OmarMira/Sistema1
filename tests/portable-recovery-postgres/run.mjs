#!/usr/bin/env node
/**
 * T15 — self-contained disposable PostgreSQL runner for the portable owner
 * verified recovery workflow (tests/portable-recovery-postgres).
 *
 * What it does, in order:
 *  1. refuses anything that is not the LOCAL Docker socket (never a remote
 *     context) and refuses to pull an image: postgres:16-alpine must already be
 *     present locally;
 *  2. starts ONE throwaway container (`accountexpress_bootstraptest-<hex>`) with
 *     a tmpfs data directory, no bind mounts, a random synthetic password and an
 *     ephemeral 127.0.0.1 port;
 *  3. creates the `accountexpress_bootstraptest` database and builds the fixture
 *     FROM THE REPOSITORY MIGRATIONS (`prisma/migrations/<dir>/migration.sql`,
 *     lexical order, applied one by one with ON_ERROR_STOP=1) — never
 *     `prisma db push`, and never against an ambient database;
 *  4. runs the isolated Vitest config with `envDir: false` in a scratch data
 *     directory OUTSIDE the worktree (os.tmpdir());
 *  5. removes exactly the container it created (after proving identity), and
 *     removes the scratch directory only when the run succeeded.
 *
 * Nothing real is read: no .env, no ambient DATABASE_URL (it is overwritten in
 * the child environment), no credentials, no backups, no SMTP/relay.
 *
 * Usage: node tests/portable-recovery-postgres/run.mjs
 * Exit: 0 green, 1 red, 2 unavailable (Docker or the local image is missing).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const IMAGE = 'postgres:16-alpine';
const DATABASE = 'accountexpress_bootstraptest';
const SCOPE = 'portable-recovery-t15';

function localDockerHost(value = process.env.DOCKER_HOST) {
  const host = value || (process.platform === 'win32'
    ? 'npipe:////./pipe/docker_engine'
    : 'unix:///var/run/docker.sock');
  if (!['npipe:////./pipe/docker_engine', 'unix:///var/run/docker.sock'].includes(host)) {
    throw new Error('Only the local Docker socket is allowed');
  }
  return host;
}

const host = localDockerHost();
const dockerEnv = { ...process.env, DOCKER_HOST: host, DOCKER_CONTEXT: '' };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, env: dockerEnv, encoding: 'utf8', timeout: options.timeout ?? 120_000,
    stdio: options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    input: options.input,
    windowsHide: true,
  });
  if (result.error) throw new Error(`${path.basename(command)} could not start: ${result.error.message}`);
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function docker(args, options = {}) {
  const result = run('docker', ['--host', host, ...args], options);
  if (result.code !== 0) {
    throw new Error(`docker ${args[0]} failed (exit ${result.code})`);
  }
  return result.stdout.trim();
}

function migrations() {
  const base = path.join(root, 'prisma', 'migrations');
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return dirs.map((dir) => ({
    dir,
    sql: fs.readFileSync(path.join(base, dir, 'migration.sql'), 'utf8'),
  }));
}

function unavailable(reason) {
  console.error(`PORTABLE_RECOVERY_PG_UNAVAILABLE: ${reason}`);
  process.exit(2);
}

async function main() {
  const probe = run('docker', ['--host', host, 'image', 'inspect', IMAGE]);
  if (probe.code !== 0) unavailable(`${IMAGE} is not available locally (this runner never pulls images)`);

  const owner = `proof-${randomBytes(16).toString('hex')}`;
  const name = `${DATABASE}-${randomBytes(6).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  const user = 'bootstrap_recovery';
  const runId = `${DATABASE}-t15-${randomBytes(4).toString('hex')}`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `${runId}-`));
  const dataDir = path.join(scratch, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  let containerId = '';
  let failure = null;
  const inspect = () => {
    const info = JSON.parse(docker(['inspect', containerId]))[0];
    if (info?.Id !== containerId ||
        info?.Config?.Labels?.['sistema1.scope'] !== SCOPE ||
        info?.Config?.Labels?.['sistema1.owner'] !== owner ||
        info?.State?.Running !== true ||
        (info?.Mounts ?? []).length !== 0 ||
        (info?.HostConfig?.Binds ?? []).length !== 0 ||
        !info?.HostConfig?.Tmpfs?.['/var/lib/postgresql/data']) {
      throw new Error('Disposable container ownership/isolation proof failed');
    }
    const ports = info?.NetworkSettings?.Ports?.['5432/tcp'];
    if (!Array.isArray(ports) || ports.length !== 1 || ports[0].HostIp !== '127.0.0.1' ||
        !/^\d+$/.test(ports[0].HostPort ?? '') || Number(ports[0].HostPort) === 5432) {
      throw new Error('Disposable container loopback port proof failed');
    }
    return ports[0].HostPort;
  };

  try {
    containerId = docker([
      'run', '-d', '--rm', '--pull=never', '--name', name,
      '--label', `sistema1.scope=${SCOPE}`, '--label', `sistema1.owner=${owner}`,
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid',
      '-p', '127.0.0.1::5432',
      '-e', `POSTGRES_USER=${user}`, '-e', `POSTGRES_PASSWORD=${password}`,
      '-e', 'POSTGRES_DB=postgres', IMAGE,
    ]);
    const port = inspect();
    console.log(`PORTABLE_RECOVERY_PG_CONTAINER ${name} loopback-port=${port}`);

    let ready = false;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const check = run('docker', ['--host', host, 'exec', containerId,
        'pg_isready', '-U', user, '-d', 'postgres']);
      if (check.code === 0) { ready = true; break; }
      await delay(500);
    }
    if (!ready) throw new Error('Disposable PostgreSQL container did not become ready');

    const psql = (statement, database = 'postgres', flags = []) => {
      inspect();
      const result = run('docker', ['--host', host, 'exec', '-i', containerId, 'psql', ...flags, '-v', 'ON_ERROR_STOP=1',
        '-U', user, '-d', database], { input: statement, timeout: 180_000 });
      if (result.code !== 0) {
        throw new Error(`psql failed on ${database}: ${result.stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
      }
      return result.stdout;
    };

    psql(`CREATE DATABASE ${DATABASE} OWNER ${user}`);
    psql(`GRANT ALL ON SCHEMA public TO ${user}`, DATABASE);

    const applied = migrations();
    if (applied.length === 0) throw new Error('No migrations found: refusing to build an unfaithful fixture');
    for (const migration of applied) {
      psql(`-- ${migration.dir}\n${migration.sql}\n`, DATABASE);
    }
    const tables = psql(
      `SELECT count(*) FROM pg_tables WHERE schemaname = 'public'`, DATABASE, ['-t', '-A'],
    ).trim();
    if (!/^\d+$/.test(tables) || Number(tables) < 20) {
      throw new Error(`Unexpected migrated table count (${tables}): the fixture is not the installed schema`);
    }
    console.log(`PORTABLE_RECOVERY_PG_MIGRATIONS ${applied.length} public_tables=${tables}`);

    const env = {
      ...process.env,
      DOCKER_HOST: host,
      NODE_ENV: 'test',
      DATABASE_URL: `postgresql://${user}:${password}@127.0.0.1:${port}/${DATABASE}`,
      ACCOUNTEXPRESS_DATA_DIR: dataDir,
      HMAC_SECRET: randomBytes(32).toString('hex'),
      SESSION_SECRET: randomBytes(32).toString('hex'),
      PORTABLE_RECOVERY_PG_CONTAINER: containerId,
      PORTABLE_RECOVERY_PG_SCRATCH: scratch,
      TMPDIR: os.tmpdir(),
    };
    console.log(`PORTABLE_RECOVERY_PG_DATA_DIR ${dataDir}`);

    const child = spawn(process.execPath, [
      path.join(root, 'node_modules', 'vitest', 'vitest.mjs'),
      'run', '--config', path.join(here, 'vitest.config.mts'),
    ], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (value, signal) => resolve(signal ? 1 : value ?? 1));
    });
    if (code !== 0) failure = `vitest exited ${code}`;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (containerId) {
      try {
        inspect();
        run('docker', ['--host', host, 'rm', '-f', containerId], { timeout: 60_000 });
        console.log(`PORTABLE_RECOVERY_PG_CONTAINER_REMOVED ${containerId.slice(0, 12)}`);
      } catch (error) {
        console.error(`PORTABLE_RECOVERY_PG_CONTAINER_KEPT ${containerId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failure) {
      console.error(`PORTABLE_RECOVERY_PG_SCRATCH_KEPT ${scratch}`);
    } else {
      fs.rmSync(scratch, { recursive: true, force: true });
      console.log('PORTABLE_RECOVERY_PG_SCRATCH_REMOVED');
    }
  }

  if (failure) {
    console.error(`PORTABLE_RECOVERY_PG_FAILED: ${failure}`);
    process.exit(1);
  }
  console.log('PORTABLE_RECOVERY_PG_GREEN');
}

await main();
