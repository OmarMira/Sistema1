import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cleanupOwned, identitySuites, proveOwned } from '../../scripts/ci-test-isolated.mjs';
import rootConfig from '../../vitest.config';
import contractConfig from '../../vitest.identity-integration.config';
import registrationConfig from '../../vitest.registration-integration.config';
import deletionConfig from '../../vitest.clean-identity-integration.config';

const id = 'a'.repeat(64);
const owner = `proof-${'b'.repeat(32)}`;
const proof = () => ({ Id: id, State: { Running: true },
  Config: { Labels: { 'sistema1.scope': 'identity-phase-a', 'sistema1.owner': owner } },
  Mounts: [], HostConfig: { Binds: [], Tmpfs: { '/var/lib/postgresql/data': 'rw,nosuid' } },
  NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '59999' }] } },
});
const cli = (args: string[], env = {}) => spawnSync(process.execPath,
  ['scripts/ci-test-isolated.mjs', ...args], { encoding: 'utf8', timeout: 5000, env: { ...process.env, ...env }, windowsHide: true });

describe('isolated CI public interface', () => {
  it('documents the executable options without starting Docker', () => {
    const result = cli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('Usage: node scripts/ci-test-isolated.mjs --help | --plan | --run [--focus] [--checks]\n');
    expect(result.stderr).toBe('');
  });
  it.each([[], ['--unknown'], ['--run', '--unknown'], ['--run', '--run']])('rejects invalid arguments %j before resource creation', (...args) => {
    const result = cli(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Invalid arguments.\nUsage: node scripts/ci-test-isolated.mjs --help | --plan | --run [--focus] [--checks]\n');
  });
  it('rejects remote Docker before starting or connecting to anything', () => {
    const result = cli(['--run'], { DOCKER_HOST: 'tcp://127.0.0.1:1' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Only the local Docker socket is allowed\n');
  });
  it('preloads the PostgreSQL image required by the no-pull runner in CI', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const runner = readFileSync('scripts/ci-test-isolated.mjs', 'utf8');
    const requiredImage = runner.match(/['"](postgres:[^'"]+)['"]/)?.[1];
    const serviceImage = workflow.match(/^\s+postgres:\s*\r?\n\s+image:\s*(\S+)/m)?.[1];
    expect(requiredImage).toBeDefined();
    expect(runner).toContain("'--pull=never'");
    expect(serviceImage).toBe(requiredImage);
  });
  it('assigns every separate identity suite to exactly one mandatory dedicated config', () => {
    const result = cli(['--plan']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ root: 'vitest.config.ts', dedicated: identitySuites });
    const dedicated = [...contractConfig.test!.include!, ...registrationConfig.test!.include!, ...deletionConfig.test!.include!];
    expect(dedicated.toSorted()).toEqual(identitySuites.toSorted());
    expect(identitySuites.every(file => rootConfig.test!.exclude!.includes(file))).toBe(true);
    expect(rootConfig.test!.environment ?? 'node').toBe('node');
  });
  it('uses existing bootstrap tests, a dedicated config, and prepares their schema', () => {
    const runner = readFileSync('scripts/ci-test-isolated.mjs', 'utf8');
    const files = [...runner.matchAll(/['"](tests\/[^'"]+\.test\.ts)['"]/g)].map(match => match[1]);
    expect(files.every(file => existsSync(file))).toBe(true);
    expect(runner).toContain("vitest('vitest.forensic-f9.config.ts'");
    expect(runner).toContain('const bootstrapEnv');
    expect(runner).toContain("['db', 'push', '--skip-generate'], bootstrapEnv");
    const config = readFileSync('vitest.forensic-f9.config.ts', 'utf8');
    expect(config).not.toContain('postgresql://');
    expect(config).toContain("include: ['tests/forensic/hdr1c-memory-backup.test.ts']");
    expect(runner.indexOf('const bootstrapTemp')).toBeLessThan(runner.indexOf('try {\n    id ='));
  });
  it('shares cross-platform ownership proof and creates the complete synthetic user fixture', () => {
    const setup = readFileSync('tests/identity/setup.integration.ts', 'utf8');
    expect(setup).toContain('localDockerHost()');
    expect(setup).toContain('proveOwned(info, id,');
    expect(setup).not.toContain('01a1519b');
    expect(setup).toContain('"emailVerifiedAt" timestamptz');
    expect(setup).toContain('"legacyUser" boolean');
    for (const file of ['clean-deletion', 'registration-atomic']) {
      const source = readFileSync(`tests/identity/${file}.integration.test.ts`, 'utf8');
      expect(source).toContain('IDENTITY_TEST_OWNER_PROOF');
      expect(source).not.toContain('01a1602d');
      expect(source).not.toContain("url.port !== '59521'");
    }
  });
  it('isolates backup storage and routes Node tests to their own runner without dropping them', () => {
    const runner = readFileSync('scripts/ci-test-isolated.mjs', 'utf8');
    expect(runner).toContain('ACCOUNTEXPRESS_DATA_DIR: dataDir');
    expect(runner).toContain("fs.mkdtempSync(path.join(backupDir, 'sistema1-ci-data-'))");
    expect(runner).toContain("path.join(dataDir, 'backups')");
    expect(runner).toContain("file.endsWith('.test.cjs')");
    expect(runner).toContain("['--test',");
    expect(rootConfig.test!.exclude).toContain('tests/installer/*.test.cjs');
    expect(rootConfig).toMatchObject({ envDir: false });
    const setup = readFileSync('tests/setup.ts', 'utf8');
    expect(setup).not.toContain("import { db } from '@/lib/db'");
    const globalSetup = readFileSync('tests/global-setup.ts', 'utf8');
    expect(globalSetup).toContain('db.bankProfile');
    expect(globalSetup.indexOf("databaseName !== 'accountexpress_test'")).toBeLessThan(globalSetup.indexOf('new PrismaClient'));
  });
  it('removes only the exact freshly proven container ID', async () => {
    const removed: string[] = [];
    await cleanupOwned(async () => proof(), async (target: string) => { removed.push(target); }, id, owner);
    expect(removed).toEqual([id]);
  });
  it.each(['owner', 'id', 'mount', 'port', 'binding', 'stopped', 'inspection'])('refuses cleanup on invalid %s proof with no removal', async (rule) => {
    const removed: string[] = [];
    const info = proof();
    if (rule === 'owner') info.Config.Labels['sistema1.owner'] = 'someone-else';
    if (rule === 'id') info.Id = 'c'.repeat(64);
    if (rule === 'mount') (info.Mounts as unknown[]).push({ Type: 'volume' });
    if (rule === 'port') info.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0';
    if (rule === 'binding') (info.HostConfig.Binds as string[]).push('/real:/data');
    if (rule === 'stopped') info.State.Running = false;
    await expect(cleanupOwned(async () => { if (rule === 'inspection') throw new Error('inspection unavailable'); return info; },
      async (target: string) => { removed.push(target); }, id, owner)).rejects.toThrow();
    expect(removed).toEqual([]);
  });
  it('refuses the operative PostgreSQL port even with matching labels', () => {
    const info = proof();
    info.NetworkSettings.Ports['5432/tcp'][0].HostPort = '5432';
    expect(() => proveOwned(info, id, owner)).toThrow('Disposable container ownership/isolation proof failed');
  });
});
