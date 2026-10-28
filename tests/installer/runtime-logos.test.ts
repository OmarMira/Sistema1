import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('crypto', () => ({ randomUUID: () => '12345678-1234-4234-8234-123456789abc' }));
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const basename = '1234567890123-12345678-1234-4234-8234-123456789abc.png';
let root: string, program: string, data: string;

function tree(dir = root): string[] {
  return fs.readdirSync(dir).sort().flatMap(name => {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return [file + ':link:' + fs.readlinkSync(file)];
    return stat.isDirectory() ? tree(file) : [file + ':' + fs.readFileSync(file).toString('base64')];
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), 'tests/installer/.runtime-logos-'));
  program = path.join(root, 'Programa é'); data = path.join(root, 'Datos separados');
  fs.mkdirSync(program);
  vi.resetModules(); vi.stubEnv('ACCOUNTEXPRESS_DATA_DIR', '');
  vi.spyOn(process, 'cwd').mockReturnValue(program);
  vi.spyOn(Date, 'now').mockReturnValue(1234567890123);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function get(filename: string) {
  const route = await import('@/app/uploads/logos/[filename]/route');
  expect(route.dynamic).toBe('force-dynamic');
  return route.GET(new Request('http://127.0.0.1/uploads/logos/' + encodeURIComponent(filename)), { params: Promise.resolve({ filename }) });
}

describe('installed logo storage and public image responses', () => {
  it('stores and serves a new installed logo at request time without writing program files', async () => {
    vi.stubEnv('ACCOUNTEXPRESS_DATA_DIR', data);
    expect((await get(basename)).status).toBe(404);
    const { saveLogo, deleteLogo } = await import('@/lib/uploads/logo-service');
    const url = await saveLogo(new File([png], 'misleading.html', { type: 'image/png' }));
    expect(url).toBe('/uploads/logos/' + basename);
    expect(fs.readFileSync(path.join(data, 'uploads/logos', basename))).toEqual(Buffer.from(png));
    expect(fs.readdirSync(program)).toEqual([]);
    const response = await get(basename);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    await deleteLogo(url);
    expect((await get(basename)).status).toBe(404);
    expect(fs.readdirSync(program)).toEqual([]);
  });

  it('rejects escaped names, file links and redirected storage without changing sentinel bytes', async () => {
    vi.stubEnv('ACCOUNTEXPRESS_DATA_DIR', data);
    const logoDir = path.join(data, 'uploads/logos'); fs.mkdirSync(logoDir, { recursive: true });
    const outside = path.join(root, 'Unrelated'); fs.mkdirSync(outside);
    const secret = path.join(outside, 'do-not-read.json'); fs.writeFileSync(secret, 'private sentinel');
    const snapshot = tree();
    for (const filename of ['../do-not-read.json', '%2e%2e%2fdo-not-read.json', 'x.png:stream', 'x.html', '/absolute.png']) {
      expect((await get(filename)).status).toBe(404);
    }
    const { deleteLogo, saveLogo } = await import('@/lib/uploads/logo-service');
    await deleteLogo('/uploads/logos/../../do-not-read.json');
    expect(tree()).toEqual(snapshot);
    // A junction is available on Windows without symbolic-file-link privileges.
    fs.rmdirSync(logoDir);
    fs.symlinkSync(outside, logoDir, process.platform === 'win32' ? 'junction' : 'dir');
    const redirected = tree();
    expect((await get(basename)).status).toBe(503);
    await expect(saveLogo(new File([png], 'logo.png', { type: 'image/png' }))).rejects.toThrow('Logo storage unavailable.');
    await deleteLogo('/uploads/logos/' + basename);
    expect(tree()).toEqual(redirected);
    expect(fs.readFileSync(secret, 'utf8')).toBe('private sentinel');
  });

  it('preserves the previous default save URL, extension, bytes and delete behavior', async () => {
    const { saveLogo, deleteLogo } = await import('@/lib/uploads/logo-service');
    const url = await saveLogo(new File([png], 'original.PNG', { type: 'image/png' }));
    expect(url).toBe('/uploads/logos/' + basename.replace('.png', '.PNG'));
    const target = path.join(program, 'public', url);
    expect(fs.readFileSync(target)).toEqual(Buffer.from(png));
    expect(fs.existsSync(data)).toBe(false);
    // Unconfigured installations keep using Next's existing public-file handling.
    expect((await get(path.basename(url))).status).toBe(404);
    await deleteLogo(url); await deleteLogo(url);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('retains MIME and size errors without writing files in either storage mode', async () => {
    for (const value of ['', data]) {
      vi.resetModules(); vi.stubEnv('ACCOUNTEXPRESS_DATA_DIR', value);
      const { saveLogo } = await import('@/lib/uploads/logo-service');
      const snapshot = tree();
      await expect(saveLogo(new File(['bad'], 'bad.html', { type: 'text/html' }))).rejects.toThrow('Formato de imagen no permitido. Utilice PNG, JPG o SVG.');
      await expect(saveLogo(new File([new Uint8Array(1024 * 1024 + 1)], 'large.png', { type: 'image/png' }))).rejects.toThrow('El archivo de logo excede el límite de 1MB');
      expect(tree()).toEqual(snapshot);
    }
  });
});
