import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Opt-in only. Resolve and reject the descriptor before Vitest imports db.ts.
function refuse(): never {
  throw new Error('COMPANY_RECOVERY_FIXTURE must name an absolute synthetic PostgreSQL 16 fixture manifest with a disjoint owned root and a password-free 127.0.0.1 test URL');
}
const manifestPath = process.env.COMPANY_RECOVERY_FIXTURE;
if (!manifestPath || !path.isAbsolute(manifestPath)) refuse();
let manifest: { root: string; port: number; databaseUrl: string; synthetic: boolean };
try {
  if (!fs.lstatSync(manifestPath!).isFile() || fs.lstatSync(manifestPath!).isSymbolicLink()) refuse();
  manifest = JSON.parse(fs.readFileSync(manifestPath!, 'utf8'));
} catch { refuse(); }
if (!manifest! || manifest.synthetic !== true || typeof manifest.root !== 'string' || !path.isAbsolute(manifest.root) ||
    !Number.isInteger(manifest.port) || manifest.port < 1 || manifest.port > 65535 ||
    typeof manifest.databaseUrl !== 'string') refuse();
// Exact spelling also excludes passwords, query/socket arguments, fragments,
// encoded authority/path changes and implicit/default ports.
if (manifest.databaseUrl !== `postgresql://postgres@127.0.0.1:${manifest.port}/accountexpress_test`) refuse();
const contains = (parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const sourceRoot = fs.realpathSync(fileURLToPath(new URL('.', import.meta.url)));
let root: string, pgdata: string;
try {
  root = fs.realpathSync(manifest.root);
  pgdata = fs.realpathSync(path.join(root, 'pgdata'));
  if (path.relative(root, path.resolve(manifest.root)) !== '' || root === path.parse(root).root ||
      path.relative(root, fs.realpathSync(path.dirname(manifestPath!))) !== '' ||
      path.relative(path.join(root, 'pgdata'), pgdata) !== '' || !fs.statSync(pgdata).isDirectory() ||
      contains(sourceRoot, root) || contains(root, sourceRoot) ||
      contains(fs.realpathSync(process.cwd()), root) || contains(root, fs.realpathSync(process.cwd()))) refuse();
} catch { refuse(); }
// No fixture provisioning, schema reset or writes here. The probe's first SQL
// verifies data_directory/database/host/port/version before any seed DML.
const dataDir = path.join(root!, `public-pg-${crypto.randomUUID()}`);
const env = {
  NODE_ENV: 'test', DATABASE_URL: manifest.databaseUrl,
  ACCOUNTEXPRESS_DATA_DIR: dataDir,
  COMPANY_RECOVERY_FIXTURE: manifestPath!,
  COMPANY_RECOVERY_VERIFIED_DESCRIPTOR: JSON.stringify({ root: root!, pgdata: pgdata!, port: manifest.port, databaseUrl: manifest.databaseUrl, dataDir }),
};
Object.assign(process.env, env);

export default defineConfig({
  envDir: false,
  cacheDir: path.join(dataDir, 'cache'),
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/backup-company/public-pg.integration.ts'],
    environment: 'node', env,
    setupFiles: [], globalSetup: [], cache: false,
    maxWorkers: 1, fileParallelism: false,
    testTimeout: 25000, hookTimeout: 25000,
  },
});
