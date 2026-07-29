import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileResource } from '../../src/internal/operation-controller/resources/file-resource';
import type { ExecutionContract, VerificationScope } from '../../src/internal/operation-controller/types';

let tempDir: string;
let ws: FileResource;

const canSymlink = (() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sym-check-'));
  const target = path.join(tmp, 'target.txt');
  const link = path.join(tmp, 'link.txt');

  try {
    fs.writeFileSync(target, 'test', 'utf-8');
    fs.symlinkSync(target, link, 'file');
    return fs.readFileSync(link, 'utf-8') === 'test';
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

function makeContract(overrides: Partial<ExecutionContract> & { target: string }): ExecutionContract {
  return {
    intentId: 'test-intent',
    resourceType: 'file',
    operation: 'modify',
    allowedEffects: ['modify'],
    forbiddenEffects: [],
    budget: { maxChanges: 1 },
    expectedState: {},
    verificationScope: 'scoped' as VerificationScope,
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-'));
  fs.writeFileSync(path.join(tempDir, 'existing.txt'), 'original', 'utf-8');
  ws = new FileResource(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('FileResource', () => {
  it('read autorizado', () => {
    const result = ws.execute(makeContract({
      target: 'existing.txt',
      operation: 'read',
      allowedEffects: ['read'],
    }));
    expect(result.success).toBe(true);
    expect(result.detail).toBe('original');
  });

  it('modify autorizado', () => {
    const result = ws.execute(makeContract({
      target: 'existing.txt',
      operation: 'modify',
      expectedState: { 'existing.txt': 'modificado' },
    }));
    expect(result.success).toBe(true);
    expect(ws.readFile('existing.txt')).toBe('modificado');
  });

  it('create autorizado', () => {
    const result = ws.execute(makeContract({
      target: 'nuevo.txt',
      operation: 'create',
      allowedEffects: ['create'],
      expectedState: { 'nuevo.txt': 'contenido nuevo' },
    }));
    expect(result.success).toBe(true);
    expect(ws.readFile('nuevo.txt')).toBe('contenido nuevo');
  });

  it('delete autorizado', () => {
    fs.writeFileSync(path.join(tempDir, 'to-delete.txt'), 'borrame', 'utf-8');
    const result = ws.execute(makeContract({
      target: 'to-delete.txt',
      operation: 'delete',
      allowedEffects: ['delete'],
    }));
    expect(result.success).toBe(true);
    expect(ws.exists('to-delete.txt')).toBe(false);
  });

  it('modify con forbiddenEffects: [modify] falla', () => {
    const result = ws.execute(makeContract({
      target: 'existing.txt',
      operation: 'modify',
      forbiddenEffects: ['modify'],
      expectedState: { 'existing.txt': 'nuevo' },
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('forbidden');
  });

  it('delete con forbiddenEffects: [delete] falla', () => {
    const result = ws.execute(makeContract({
      target: 'existing.txt',
      operation: 'delete',
      allowedEffects: ['delete'],
      forbiddenEffects: ['delete'],
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('forbidden');
  });

  it('modify sin efecto en allowedEffects falla', () => {
    const result = ws.execute(makeContract({
      target: 'existing.txt',
      operation: 'modify',
      allowedEffects: [],
      expectedState: { 'existing.txt': 'nuevo' },
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('modify sobre archivo inexistente falla', () => {
    const result = ws.execute(makeContract({
      target: 'no-existe.txt',
      operation: 'modify',
      expectedState: { 'no-existe.txt': 'contenido' },
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not exist');
  });

  it('create sobre archivo existente falla', () => {
    const result = ws.execute(makeContract({
      target: 'existing.txt',
      operation: 'create',
      allowedEffects: ['create'],
      expectedState: { 'existing.txt': 'contenido' },
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('operación sobre directorio falla', () => {
    const dir = path.join(tempDir, 'subdir');
    fs.mkdirSync(dir);
    const result = ws.execute(makeContract({
      target: 'subdir',
      operation: 'read',
      allowedEffects: ['read'],
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('not a regular file');
  });

  it('../ fuera del workspace falla', () => {
    const result = ws.execute(makeContract({
      target: '../outside.txt',
      operation: 'read',
      allowedEffects: ['read'],
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside');
  });

  it('ruta absoluta externa falla', () => {
    const externalFile = path.join(
      os.tmpdir(),
      `oc-external-${process.pid}-${Date.now()}.txt`,
    );
    try {
      fs.writeFileSync(externalFile, 'external', 'utf-8');
      const result = ws.execute(makeContract({
        target: externalFile,
        operation: 'read',
      }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    } finally {
      try { fs.unlinkSync(externalFile); } catch { /* ignore */ }
    }
  });

  it('carpeta con prefijo parecido al workspace no pasa la contención', () => {
    const similarDir = tempDir + '-copy';
    try {
      fs.mkdirSync(similarDir);
      const result = ws.execute(makeContract({
        target: path.relative(tempDir, similarDir),
        operation: 'read',
      }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    } finally {
      try { fs.rmSync(similarDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it.skipIf(!canSymlink)('symlink interno funciona', () => {
    const realFile = path.join(tempDir, 'real.txt');
    fs.writeFileSync(realFile, 'contenido real', 'utf-8');
    const linkPath = path.join(tempDir, 'internal-link.txt');
    fs.symlinkSync('real.txt', linkPath, 'file');

    const result = ws.execute(makeContract({
      target: 'internal-link.txt',
      operation: 'read',
      allowedEffects: ['read'],
    }));
    expect(result.success).toBe(true);
    expect(result.detail).toBe('contenido real');
  });

  it.skipIf(!canSymlink)('symlink externo es rechazado', () => {
    const symlinkTarget = path.join(os.tmpdir(), 'oc-symlink-target.txt');
    const symlinkPath = path.join(tempDir, 'evil-link.txt');
    try {
      fs.writeFileSync(symlinkTarget, 'target', 'utf-8');
      fs.symlinkSync(symlinkTarget, symlinkPath, 'file');

      const result = ws.execute(makeContract({
        target: 'evil-link.txt',
        operation: 'read',
        allowedEffects: ['read'],
      }));
      expect(result.success).toBe(false);
      expect(result.error).toContain('outside');
    } finally {
      try { fs.unlinkSync(symlinkTarget); } catch { /* ignore */ }
    }
  });

  it.skipIf(!canSymlink)('snapshot falla ante archivo symlink que apunta fuera', () => {
    const externalTarget = path.join(os.tmpdir(), `oc-ext-snap-${Date.now()}.txt`);
    const linkPath = path.join(tempDir, 'evil-link-snap.txt');
    try {
      fs.writeFileSync(externalTarget, 'external', 'utf-8');
      fs.symlinkSync(externalTarget, linkPath, 'file');
      expect(() => ws.snapshot()).toThrow('Snapshot blocked');
    } finally {
      try { fs.unlinkSync(externalTarget); } catch { /* ignore */ }
    }
  });

  it.skipIf(!canSymlink)('snapshot falla ante directorio symlink', () => {
    const externalDir = path.join(os.tmpdir(), `oc-ext-dir-${Date.now()}`);
    const linkPath = path.join(tempDir, 'evil-dir-link');
    try {
      fs.mkdirSync(externalDir);
      fs.symlinkSync(externalDir, linkPath, 'junction');
      expect(() => ws.snapshot()).toThrow('Snapshot blocked');
    } finally {
      try { fs.rmSync(externalDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  describe('snapshotObserved', () => {
    it('solo incluye rutas observadas', () => {
      const file1 = path.join(tempDir, 'a.txt');
      const file2 = path.join(tempDir, 'sub', 'b.txt');
      fs.mkdirSync(path.join(tempDir, 'sub'));
      fs.writeFileSync(file1, 'contenido a', 'utf-8');
      fs.writeFileSync(file2, 'contenido b', 'utf-8');

      const result = ws.snapshotObserved(['a.txt']);
      expect(Object.keys(result)).toEqual(['a.txt']);
      expect(result['a.txt']).toBe('contenido a');
    });

    it('ignora rutas que no existen', () => {
      const result = ws.snapshotObserved(['no-existe.txt', 'existing.txt']);
      expect(result['existing.txt']).toBe('original');
      expect(result['no-existe.txt']).toBeUndefined();
    });

    it('lanza error para ruta fuera del workspace', () => {
      expect(() => ws.snapshotObserved(['../outside.txt'])).toThrow('Snapshot blocked');
      expect(() => ws.snapshotObserved(['../outside.txt'])).toThrow('outside');
    });

    it.skipIf(!canSymlink)('rechaza symlink externo', () => {
      const externalTarget = path.join(os.tmpdir(), `oc-ext-snap-${Date.now()}.txt`);
      const linkPath = path.join(tempDir, 'evil-link-snap.txt');
      try {
        fs.writeFileSync(externalTarget, 'external', 'utf-8');
        fs.symlinkSync(externalTarget, linkPath, 'file');
        expect(() => ws.snapshotObserved(['evil-link-snap.txt'])).toThrow('Snapshot blocked');
      } finally {
        try { fs.unlinkSync(externalTarget); } catch { /* ignore */ }
      }
    });
  });
});