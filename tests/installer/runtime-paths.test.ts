import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/ai-config', () => ({ checkAiConfigIntegrity: async () => ({ code: 'AI_CONFIG_MISSING' }) }));

let root: string, program: string, data: string;
const defaults = '{"companies":{}}';
const legacy = '{"companies":{"existing":{"currency":"ARS"}}}';

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(__dirname, '.runtime-paths-'));
  program = path.join(root, 'Programas José'); data = path.join(root, 'Datos contables');
  fs.mkdirSync(path.join(program, 'rules/defaults'), { recursive: true });
  fs.writeFileSync(path.join(program, 'rules/defaults/company-config.default.json'), defaults);
  fs.writeFileSync(path.join(program, 'rules/company-config.json'), legacy);
  vi.spyOn(process, 'cwd').mockReturnValue(program);
  vi.stubEnv('ACCOUNTEXPRESS_DATA_DIR', '');
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('installed-instance durable data paths', () => {
  it('places runtime config and backups under the explicit separate data root', async () => {
    vi.stubEnv('ACCOUNTEXPRESS_DATA_DIR', data);
    const paths = await import('@/lib/config/paths');
    expect(paths.RUNTIME_DIR).toBe(path.join(data, 'config'));
    expect(paths.RUNTIME_FILES.companyConfig).toBe(path.join(data, 'config/company-config.json'));
    expect(paths.BACKUP_DIR).toBe(path.join(data, 'backups'));
    expect(paths.DEFAULT_TEMPLATES.companyConfig).toBe(path.join(program, 'rules/defaults/company-config.default.json'));
    expect(fs.existsSync(data)).toBe(false);
  });

  it('preserves existing development paths when the optional root is unset', async () => {
    const paths = await import('@/lib/config/paths');
    expect(paths.RUNTIME_DIR).toBe(path.join(program, '.data'));
    expect(paths.RUNTIME_FILES.companyConfig).toBe(path.join(program, '.data/company-config.json'));
    expect(paths.BACKUP_DIR).toBe(path.join(program, 'db/backups'));
    expect(paths.LEGACY_FILES.companyConfig).toBe(path.join(program, 'rules/company-config.json'));
    expect(fs.existsSync(path.join(program, '.data'))).toBe(false);
  });

  it('rejects invalid or overlapping roots before any filesystem write', async () => {
    const windowsPaths = process.platform === 'win32' ? ['\\\\server\\share\\AccountExpress', '\\\\?\\C:\\AccountExpress'] : [];
    for (const value of ['relative', path.parse(program).root, program, path.join(program, 'data'), root, ...windowsPaths]) {
      vi.resetModules(); vi.stubEnv('ACCOUNTEXPRESS_DATA_DIR', value);
      await expect(import('@/lib/config/paths')).rejects.toThrow('ACCOUNTEXPRESS_DATA_DIR must be an absolute directory separate from program files.');
      expect(fs.readFileSync(path.join(program, 'rules/company-config.json'), 'utf8')).toBe(legacy);
      expect(fs.readdirSync(program)).toEqual(['rules']);
      expect(fs.existsSync(data)).toBe(false);
    }
  });

  it('initializes packaged config only from curated defaults, never developer legacy data', async () => {
    vi.stubEnv('ACCOUNTEXPRESS_DATA_DIR', data);
    const { initRuntimeData } = await import('@/lib/init-runtime');
    initRuntimeData();
    expect(fs.readFileSync(path.join(data, 'config/company-config.json'), 'utf8')).toBe(defaults);
    expect(fs.readFileSync(path.join(program, 'rules/company-config.json'), 'utf8')).toBe(legacy);
    expect(fs.existsSync(path.join(program, '.data'))).toBe(false);
  });

  it('retains installed bytes without moving previous development data', async () => {
    const previous = path.join(program, '.data/company-config.json');
    fs.mkdirSync(path.dirname(previous), { recursive: true });
    fs.writeFileSync(previous, legacy);
    vi.stubEnv('ACCOUNTEXPRESS_DATA_DIR', data);
    const paths = await import('@/lib/config/paths');
    const { initRuntimeData } = await import('@/lib/init-runtime');
    initRuntimeData();
    expect(fs.readFileSync(paths.RUNTIME_FILES.companyConfig, 'utf8')).toBe(defaults);
    const retained = Buffer.from('{"retained":true}\r\n');
    fs.writeFileSync(paths.RUNTIME_FILES.companyConfig, retained);
    initRuntimeData();
    expect(fs.readFileSync(paths.RUNTIME_FILES.companyConfig)).toEqual(retained);
    expect(fs.readFileSync(previous, 'utf8')).toBe(legacy);
  });

  it('rejects canonical program aliases without changing program data', async () => {
    const alias = path.join(root, 'program-alias');
    fs.symlinkSync(program, alias, process.platform === 'win32' ? 'junction' : 'dir');
    for (const value of [alias, path.join(alias, 'future-data')]) {
      vi.resetModules(); vi.stubEnv('ACCOUNTEXPRESS_DATA_DIR', value);
      await expect(import('@/lib/config/paths')).rejects.toThrow('ACCOUNTEXPRESS_DATA_DIR must be an absolute directory separate from program files.');
      expect(fs.readFileSync(path.join(program, 'rules/company-config.json'), 'utf8')).toBe(legacy);
      expect(fs.readdirSync(program)).toEqual(['rules']);
      expect(fs.existsSync(data)).toBe(false);
    }
  });

  it('preserves the original paths when the optional variable is genuinely unset', async () => {
    vi.stubEnv('ACCOUNTEXPRESS_DATA_DIR', undefined);
    const paths = await import('@/lib/config/paths');
    expect(paths.DATA_ROOT).toBeUndefined();
    expect(paths.RUNTIME_DIR).toBe(path.join(program, '.data'));
    expect(paths.BACKUP_DIR).toBe(path.join(program, 'db/backups'));
    expect(fs.readdirSync(program)).toEqual(['rules']);
  });

  it('retains legacy migration and never overwrites existing runtime config on restart', async () => {
    const { initRuntimeData } = await import('@/lib/init-runtime');
    initRuntimeData();
    const runtime = path.join(program, '.data/company-config.json');
    expect(fs.readFileSync(runtime, 'utf8')).toBe(legacy);
    const existing = '{"companies":{"existing":{"currency":"MXN","reviewRequired":true}}}';
    fs.writeFileSync(runtime, existing);
    fs.writeFileSync(path.join(program, 'rules/company-config.json'), defaults);
    initRuntimeData();
    expect(fs.readFileSync(runtime, 'utf8')).toBe(existing);
  });
});
