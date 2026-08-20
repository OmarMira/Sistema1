import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'bootstrap-super-admin.mjs');
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const SCRIPTS: Record<string, string> = PKG.scripts ?? {};

const TENANT_ROLES = ['company_admin', 'employee', 'viewer'];
const ORIGINAL_ARGV = process.argv.slice();
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

type UserRow = { id: string; email: string; platformRole: string };

const mocks = vi.hoisted(() => ({
  findMany: { result: null as UserRow[] | null, error: null as unknown },
  update: { result: null as UserRow | null, error: null as unknown },
  calls: { findMany: [] as unknown[], update: [] as unknown[] },
  disconnectCalled: false,
}));

vi.mock('@prisma/client', () => ({
  Prisma: {},
  PrismaClient: class {
    user = {
      findMany: vi.fn(async (args: unknown) => {
        mocks.calls.findMany.push(args);
        if (mocks.findMany.error) throw mocks.findMany.error;
        return mocks.findMany.result ?? [];
      }),
      update: vi.fn(async (args: unknown) => {
        mocks.calls.update.push(args);
        if (mocks.update.error) throw mocks.update.error;
        return mocks.update.result ?? args;
      }),
    };
    async $disconnect() {
      mocks.disconnectCalled = true;
    }
  },
}));

beforeEach(() => {
  mocks.findMany.result = null;
  mocks.findMany.error = null;
  mocks.update.result = null;
  mocks.update.error = null;
  mocks.calls.findMany.length = 0;
  mocks.calls.update.length = 0;
  mocks.disconnectCalled = false;
  process.exitCode = undefined;
  process.env.DATABASE_URL = 'postgresql://p04c_test:invalid@127.0.0.1:1/accountexpress_test';
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  process.exitCode = undefined;
});

afterAll(() => {
  process.argv = ORIGINAL_ARGV;
});

async function executeScript(args: string[]): Promise<{ code: number; out: string }> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.argv = [process.execPath, SCRIPT_PATH, ...args];
  await import('../scripts/bootstrap-super-admin.mjs');
  await vi.waitFor(() => {
    expect(process.exitCode).not.toBeUndefined();
  });
  const out = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join(' ');
  return { code: process.exitCode as number, out };
}

function runSubprocess(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT_PATH, ...args],
      { cwd: process.cwd(), timeout: 30000 },
      (error, stdout, stderr) => {
        const code = (error as { code?: number } | null)?.code ?? 0;
        resolve({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

describe('P04-C bootstrap-super-admin contract (estático)', () => {
  it('existe el script local', () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
  });

  it('package.json expone bootstrap:super-admin apuntando al script local', () => {
    expect(SCRIPTS['bootstrap:super-admin']).toBe('node scripts/bootstrap-super-admin.mjs');
  });

  it('no está conectado a dev/start/build/postinstall/migrate/seed', () => {
    const hooks = ['dev', 'start', 'build', 'postinstall', 'migrate', 'db:migrate', 'seed'];
    for (const hook of hooks) {
      if (SCRIPTS[hook] !== undefined) {
        expect(SCRIPTS[hook]).not.toContain('bootstrap-super-admin');
      }
    }
  });

  it('requiere argumento de usuario (email) y lo usa como selector', () => {
    expect(SCRIPT).toContain('P04C_ARGUMENT_MISSING');
    expect(SCRIPT).toContain('P04C_ARGUMENT_MALFORMED');
    expect(SCRIPT).toContain('[^@\\s]+@[^@\\s]+');
    expect(SCRIPT).toContain('where: { email }');
  });

  it('requiere --confirm para ejecutar (sin confirmación, cero writes)', () => {
    expect(SCRIPT).toContain('--confirm');
    expect(SCRIPT).toContain('P04C_CONFIRM_REQUIRED');
  });

  it('solo permite target super_admin y nunca mapea roles tenant a super_admin', () => {
    expect(SCRIPT).toContain("const ALLOWED_TARGET = 'super_admin'");
    expect(SCRIPT).toContain("const PROMOTABLE_ROLE = 'user'");
    for (const tenant of TENANT_ROLES) {
      expect(SCRIPT).not.toMatch(new RegExp(`PROMOTABLE_ROLE\\s*=\\s*'${tenant}'`));
      expect(SCRIPT).not.toMatch(new RegExp(`ALLOWED_TARGET\\s*=\\s*'${tenant}'`));
    }
    expect(SCRIPT).toContain('tenant roles cannot be promoted');
    expect(SCRIPT).toContain('P04C_INVALID_ROLE');
  });

  it('no contiene password hardcodeada ni acepta password como argumento', () => {
    expect(SCRIPT).not.toMatch(/password\s*[:=]/i);
    expect(SCRIPT).not.toMatch(/\bpassword:/i);
    expect(SCRIPT).not.toContain('--password');
    expect(SCRIPT).toContain('P04C_UNKNOWN_FLAG');
  });

  it('no imprime DATABASE_URL ni contenido de .env ni secrets', () => {
    expect(SCRIPT).not.toMatch(/DATABASE_URL/);
    expect(SCRIPT).not.toMatch(/SESSION_SECRET/);
    expect(SCRIPT).not.toMatch(/BOOTSTRAP_SETUP_TOKEN/);
    expect(SCRIPT).not.toMatch(/process\.env/);
  });

  it('no crea usuarios ni memberships; solo actualiza platformRole', () => {
    expect(SCRIPT).not.toMatch(/\.user\.create/);
    expect(SCRIPT.toLowerCase()).not.toMatch(/companymember/i);
    expect(SCRIPT).toContain('prisma.user.update');
    expect(SCRIPT).toContain('data: { platformRole: ALLOWED_TARGET }');
  });

  it('contempla idempotencia (ya super_admin -> no-op exit 0)', () => {
    expect(SCRIPT).toContain('P04C_ALREADY_SUPER_ADMIN');
    expect(SCRIPT).toContain('no-op');
  });

  it('fail-closed ante rol inválido (exit != 0)', () => {
    expect(SCRIPT).toContain('P04C_INVALID_ROLE');
    expect(SCRIPT).toMatch(/return 6/);
    expect(SCRIPT).toContain('process.exitCode');
  });

  it('distingue fallo de conexión de fallo de operación', () => {
    expect(SCRIPT).toContain('P04C_DB_CONNECTION_FAILED');
    expect(SCRIPT).toContain('P04C_DB_OPERATION_FAILED');
    expect(SCRIPT).toContain('PrismaClientInitializationError');
    expect(SCRIPT).toMatch(/return 4/);
    expect(SCRIPT).toMatch(/return 7/);
  });

  it('--help no toca la base (se maneja antes de instanciar PrismaClient)', () => {
    const helpIdx = SCRIPT.indexOf('--help');
    const prismaIdx = SCRIPT.indexOf('new PrismaClient()');
    expect(helpIdx).toBeGreaterThan(-1);
    expect(prismaIdx).toBeGreaterThan(-1);
    expect(helpIdx).toBeLessThan(prismaIdx);
  });
});

describe('P04-C bootstrap-super-admin execution (Prisma mocked, sin DB real)', () => {
  it('user -> super_admin (exit 0, update solo de platformRole)', async () => {
    mocks.findMany.result = [{ id: 'u1', email: 'admin@example.com', platformRole: 'user' }];
    mocks.update.result = { id: 'u1', email: 'admin@example.com', platformRole: 'super_admin' };
    const { code, out } = await executeScript(['admin@example.com', '--confirm']);
    expect(code).toBe(0);
    expect(out).toContain('P04C_PROMOTED');
    expect(out).toContain('final=super_admin');
    expect(mocks.calls.update).toHaveLength(1);
    expect((mocks.calls.update[0] as { where: unknown; data: unknown }).where).toEqual({ id: 'u1' });
    expect((mocks.calls.update[0] as { where: unknown; data: unknown }).data).toEqual({
      platformRole: 'super_admin',
    });
    expect((mocks.calls.findMany[0] as { where: unknown }).where).toEqual({
      email: 'admin@example.com',
    });
    expect(mocks.disconnectCalled).toBe(true);
    expect(out).not.toMatch(/DATABASE_URL|SESSION_SECRET|BOOTSTRAP_SETUP_TOKEN/);
  });

  it('ya super_admin -> no-op exit 0 sin update', async () => {
    mocks.findMany.result = [{ id: 'u1', email: 'admin@example.com', platformRole: 'super_admin' }];
    const { code, out } = await executeScript(['admin@example.com', '--confirm']);
    expect(code).toBe(0);
    expect(out).toContain('P04C_ALREADY_SUPER_ADMIN');
    expect(mocks.calls.update).toHaveLength(0);
  });

  it('platformRole tenant -> fail-closed exit 6 sin update', async () => {
    mocks.findMany.result = [{ id: 'u1', email: 'x@example.com', platformRole: 'company_admin' }];
    const { code, out } = await executeScript(['x@example.com', '--confirm']);
    expect(code).toBe(6);
    expect(out).toContain('P04C_INVALID_ROLE');
    expect(mocks.calls.update).toHaveLength(0);
  });

  it('usuario inexistente -> exit 5 sin update', async () => {
    mocks.findMany.result = [];
    const { code, out } = await executeScript(['ghost@example.com', '--confirm']);
    expect(code).toBe(5);
    expect(out).toContain('P04C_USER_NOT_FOUND');
    expect(mocks.calls.update).toHaveLength(0);
  });

  it('más de un candidato -> exit 5 sin update', async () => {
    mocks.findMany.result = [
      { id: 'u1', email: 'dup@example.com', platformRole: 'user' },
      { id: 'u2', email: 'dup@example.com', platformRole: 'user' },
    ];
    const { code, out } = await executeScript(['dup@example.com', '--confirm']);
    expect(code).toBe(5);
    expect(out).toContain('P04C_MULTIPLE_CANDIDATES');
    expect(mocks.calls.update).toHaveLength(0);
  });

  it('fallo de conexión (P1001) -> exit 4 P04C_DB_CONNECTION_FAILED', async () => {
    mocks.findMany.error = Object.assign(new Error('connect refused'), { code: 'P1001' });
    const { code, out } = await executeScript(['a@example.com', '--confirm']);
    expect(code).toBe(4);
    expect(out).toContain('P04C_DB_CONNECTION_FAILED');
    expect(out).not.toContain('P04C_DB_OPERATION_FAILED');
    expect(out).not.toContain('connect refused');
  });

  it('error de operación (P2002 constraint) -> exit 7 P04C_DB_OPERATION_FAILED', async () => {
    mocks.findMany.error = Object.assign(new Error('unique violation'), { code: 'P2002' });
    const { code, out } = await executeScript(['a@example.com', '--confirm']);
    expect(code).toBe(7);
    expect(out).toContain('P04C_DB_OPERATION_FAILED');
    expect(out).not.toContain('P04C_DB_CONNECTION_FAILED');
    expect(out).not.toContain('unique violation');
  });

  it('error de operación en update (P2003) -> exit 7', async () => {
    mocks.findMany.result = [{ id: 'u1', email: 'a@example.com', platformRole: 'user' }];
    mocks.update.error = Object.assign(new Error('fk violation'), { code: 'P2003' });
    const { code, out } = await executeScript(['a@example.com', '--confirm']);
    expect(code).toBe(7);
    expect(out).toContain('P04C_DB_OPERATION_FAILED');
    expect(out).not.toContain('P04C_DB_CONNECTION_FAILED');
  });

  it('error desconocido -> exit 7, sin mensaje crudo', async () => {
    mocks.findMany.error = new Error('something unexpected');
    const { code, out } = await executeScript(['a@example.com', '--confirm']);
    expect(code).toBe(7);
    expect(out).toContain('P04C_DB_OPERATION_FAILED');
    expect(out).not.toContain('something unexpected');
  });
});

describe('P04-C bootstrap-super-admin argument/confirm (subproceso real, cero conexión DB)', () => {
  it('sin argumento -> exit 2 (P04C_ARGUMENT_MISSING)', async () => {
    const { code, out } = await runSubprocess([]);
    expect(code).toBe(2);
    expect(out).toContain('P04C_ARGUMENT_MISSING');
  });

  it('email mal formado -> exit 2 (P04C_ARGUMENT_MALFORMED)', async () => {
    const { code, out } = await runSubprocess(['not-an-email', '--confirm']);
    expect(code).toBe(2);
    expect(out).toContain('P04C_ARGUMENT_MALFORMED');
  });

  it('email válido sin --confirm -> exit 3, cero writes', async () => {
    const { code, out } = await runSubprocess(['admin@example.com']);
    expect(code).toBe(3);
    expect(out).toContain('P04C_CONFIRM_REQUIRED');
    expect(out).not.toContain('P04C_PROMOTED');
  });

  it('--help -> exit 0, cero conexión DB', async () => {
    const { code, out } = await runSubprocess(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('Usage');
  });
});