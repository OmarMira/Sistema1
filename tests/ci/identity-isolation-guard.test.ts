import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
