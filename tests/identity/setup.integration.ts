import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll } from 'vitest';

// No DATABASE_URL assignment, dotenv, shared application db or global setup.
const id = process.env.IDENTITY_TEST_CONTAINER_ID;
if (!id || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Explicit disposable identity container ID required');
const result = spawnSync('docker', ['--host', 'npipe:////./pipe/docker_engine', 'inspect', id], {
  encoding: 'utf8', timeout: 8000, windowsHide: true,
  env: { ...process.env, DOCKER_CONTEXT: '', DOCKER_HOST: 'npipe:////./pipe/docker_engine' },
});
if (result.error || result.status !== 0) throw new Error('Disposable container inspection failed');
const info = JSON.parse(result.stdout)[0];
const port = info.NetworkSettings.Ports['5432/tcp'];
if (info.Id !== id || !info.State.Running || info.Config.Labels['sistema1.scope'] !== 'identity-phase-a'
  || info.Config.Labels['sistema1.owner'] !== '01a1519b' || info.Mounts.length !== 0
  || (info.HostConfig.Binds || []).length || !info.HostConfig.Tmpfs?.['/var/lib/postgresql/data']
  || port?.length !== 1 || port[0].HostIp !== '127.0.0.1' || !/^\d+$/.test(port[0].HostPort)
  || port[0].HostPort === '5432') throw new Error('Disposable identity isolation proof failed');
const entries = Object.fromEntries(info.Config.Env.map((s: string) => {
  const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)];
}));
if (entries.POSTGRES_DB !== 'identity_phase_a' || entries.POSTGRES_USER !== 'identity_test'
  || !/^[a-f0-9]{64}$/.test(entries.POSTGRES_PASSWORD)) throw new Error('Test-only credentials required');
export const testUrl = `postgresql://identity_test:${entries.POSTGRES_PASSWORD}@127.0.0.1:${port[0].HostPort}/identity_phase_a`;
export const db = new PrismaClient({ datasources: { db: { url: testUrl } }, log: [] });

beforeAll(async () => {
  const identity = await db.$queryRaw<Array<{ database: string; username: string }>>`SELECT current_database() AS database, current_user AS username`;
  if (identity[0]?.database !== 'identity_phase_a' || identity[0]?.username !== 'identity_test') throw new Error('Wrong test database');
  // Minimal synthetic existing-account fixtures, not application seeds or operative data.
  await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "User" (id text PRIMARY KEY, email text UNIQUE NOT NULL, "isActive" boolean NOT NULL, "passwordHash" text NOT NULL)');
  await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "Company" (id text PRIMARY KEY, marker text NOT NULL)');
  await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "CompanyMember" ("userId" text REFERENCES "User"(id), "companyId" text REFERENCES "Company"(id), PRIMARY KEY ("userId", "companyId"))');
  await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "Session" (id text PRIMARY KEY, "userId" text REFERENCES "User"(id))');
  const exists = await db.$queryRaw<Array<{ present: string | null }>>`SELECT to_regclass('public."IdentityChallenge"')::text AS present`;
  if (!exists[0].present) {
    const sql = readFileSync('prisma/migrations/20261019000100_identity_infrastructure/migration.sql', 'utf8');
    await db.$transaction(async tx => {
      for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement);
    });
  }
});
afterAll(async () => { await db.$disconnect(); });
