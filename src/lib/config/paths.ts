import path from 'path';
import fs from 'fs';

const invalidDataRoot = 'ACCOUNTEXPRESS_DATA_DIR must be an absolute directory separate from program files.';

function realLocation(input: string): string {
  let ancestor = path.resolve(input);
  const missing: string[] = [];
  while (!fs.existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(invalidDataRoot);
    ancestor = parent;
  }
  if (!fs.statSync(ancestor).isDirectory()) throw new Error(invalidDataRoot);
  return path.join(fs.realpathSync.native(ancestor), ...missing);
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function configuredDataRoot(): string | undefined {
  const value = process.env.ACCOUNTEXPRESS_DATA_DIR;
  if (!value) return undefined;
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(invalidDataRoot);
  if (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(value) || value.slice(3).split(/[\\/]/).filter(Boolean).some(part =>
    /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))) throw new Error(invalidDataRoot);
  const selected = path.resolve(value);
  if (selected === path.parse(selected).root) throw new Error(invalidDataRoot);
  const data = realLocation(selected), program = realLocation(process.cwd());
  if (data === path.parse(data).root || contains(data, program) || contains(program, data)) throw new Error(invalidDataRoot);
  return data;
}

// Optional installed-instance storage; unset keeps the original development paths.
export const DATA_ROOT = configuredDataRoot();
export const RUNTIME_DIR = DATA_ROOT ? path.join(DATA_ROOT, 'config') : path.join(process.cwd(), '.data');
export const BACKUP_DIR = DATA_ROOT ? path.join(DATA_ROOT, 'backups') : path.join(process.cwd(), 'db', 'backups');

// companyConfig remains included in the existing backup/restore contract.
export const RUNTIME_FILES = {
  companyConfig: path.join(RUNTIME_DIR, 'company-config.json'),
} as const;

export const LEGACY_FILES = {
  companyConfig: path.join(process.cwd(), 'rules', 'company-config.json'),
} as const;

export const DEFAULT_TEMPLATES = {
  companyConfig: path.join(process.cwd(), 'rules', 'defaults', 'company-config.default.json'),
} as const;
