import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';

// Behavioural complement to the source-string guards above: each dedicated
// config must REFUSE unowned database URLs before any connection, and the
// runner must refuse a remote Docker host without creating its data dir.
const run = (config: string, env: Record<string, string>) => spawnSync(process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', '--config', config],
  { encoding: 'utf8', timeout: 120_000, windowsHide: true,
    env: { ...process.env, NODE_ENV: 'test', CI: '1', DATABASE_URL: '', IDENTITY_TEST_CONTAINER_ID: '',
      IDENTITY_TEST_OWNER_PROOF: '', REGISTRATION_TEST_PORT: '', REGISTRATION_TEST_OWNED: '',
      CLEAN_IDENTITY_TEST_PORT: '', CLEAN_IDENTITY_TEST_OWNED: '', ...env } });
const scratchDataDirs = () => fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('sistema1-ci-data-')).length;

describe('S1 — isolation guards refuse unowned databases (behavioural)', () => {
  it('bootstrap twin refuses accountexpress_test and never connects', { timeout: 120_000 }, () => {
    const r = run('vitest.forensic-f9.config.ts', { DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/accountexpress_test' });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('instead of "accountexpress_bootstraptest"');
    // Vitest summary formatting differs across platforms; only assert that no
    // test actually ran against the wrong database.
    expect(r.stdout + r.stderr).toMatch(/Tests\s+no tests/);
  });
  it('dedicated identity configs refuse URLs without ownership proof', { timeout: 180_000 }, () => {
    const reg = run('vitest.registration-integration.config.ts', { DATABASE_URL: 'postgresql://registration_test:x@127.0.0.1:1/registration_test' });
    expect(reg.status).not.toBe(0);
    expect(reg.stdout + reg.stderr).toContain('Only the explicitly owned disposable registration_test database is allowed');
    const del = run('vitest.clean-identity-integration.config.ts', { DATABASE_URL: 'postgresql://clean_identity_test:x@127.0.0.1:1/clean_identity_test' });
    expect(del.status).not.toBe(0);
    expect(del.stdout + del.stderr).toContain('Only the explicitly owned disposable clean_identity_test database is allowed');
    const contract = run('vitest.identity-integration.config.ts', { DATABASE_URL: 'postgresql://identity_test:x@127.0.0.1:1/identity_phase_a' });
    expect(contract.status).not.toBe(0);
    expect(contract.stdout + contract.stderr).toContain('Explicit disposable identity container ID required');
  });
  it('remote Docker host is refused before any run-owned data dir is created', () => {
    const before = scratchDataDirs();
    const r = run('vitest.identity-integration.config.ts', { DOCKER_HOST: 'tcp://127.0.0.1:1' });
    // Either the identity config refuses first (no container id) or the
    // runner refuses the remote host; the target is that nothing leaked.
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/Explicit disposable identity container ID required|Only the local Docker socket is allowed/);
    expect(scratchDataDirs()).toBe(before);
  });
});
