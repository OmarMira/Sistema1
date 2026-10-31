import { promises as fs } from 'fs';
import { dirname, join, relative } from 'path';
import { DATA_ROOT } from '@/lib/config/paths';
import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';
import { withRuntimeOperation } from '../backup-maintenance.js';

let config: { logo: { maxSizeMB: number; allowedFormats: string[]; path: string } } = {
  logo: {
    maxSizeMB: 1,
    allowedFormats: ['image/png', 'image/jpeg', 'image/svg+xml'],
    path: 'public/uploads/logos',
  },
};

try {
  const configPath = join(process.cwd(), 'rules/upload-config.json');
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, 'utf-8')) as typeof config;
  }
} catch (err) {
  logger.warn('[LOGO] Config load failed, using defaults', { error: String(err) });
}

const imageTypes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' };
const installedName = /^\d{1,16}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpe?g|svg)$/i;

async function installedDirectory(): Promise<string> {
  if (!DATA_ROOT) throw new Error('Logo storage unavailable.');
  const directory = join(DATA_ROOT, 'uploads/logos');
  let existing = directory;
  for (;;) {
    try {
      const stat = await fs.lstat(existing);
      if (!stat.isDirectory() || stat.isSymbolicLink() || relative(existing, await fs.realpath(existing)) !== '') {
        throw new Error('Logo storage unavailable.');
      }
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing) throw error;
      existing = dirname(existing);
    }
  }
}

/** Trusted mapping shared by recovery; archive URLs never become arbitrary paths. */
export async function companyLogoArchiveTarget(url: string): Promise<string> {
  if (!url.startsWith('/uploads/logos/')) throw new Error('BACKUP_ASSET: unsupported logo URL');
  const filename = url.slice('/uploads/logos/'.length);
  if (!installedName.test(filename)) throw new Error('BACKUP_ASSET: unsupported logo filename');
  return join(DATA_ROOT ? await installedDirectory() : join(process.cwd(), config.logo.path), filename);
}

export async function loadInstalledLogo(filename: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  if (!DATA_ROOT || !installedName.test(filename)) return null;
  try {
    const file = join(await installedDirectory(), filename);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > config.logo.maxSizeMB * 1024 * 1024) return null;
    const bytes = await fs.readFile(file);
    if (bytes.length > config.logo.maxSizeMB * 1024 * 1024) return null;
    return { bytes: new Uint8Array(bytes), type: imageTypes[filename.split('.').pop()!.toLowerCase()] };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) return null;
    throw error;
  }
}

export function saveLogo(file: File): Promise<string> {
  return withRuntimeOperation(() => saveAdmittedLogo(file));
}

async function saveAdmittedLogo(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const sizeMB = buffer.length / (1024 * 1024);

  if (sizeMB > config.logo.maxSizeMB) {
    throw new Error(`El archivo de logo excede el límite de ${config.logo.maxSizeMB}MB`);
  }
  if (!config.logo.allowedFormats.includes(file.type)) {
    throw new Error('Formato de imagen no permitido. Utilice PNG, JPG o SVG.');
  }

  const ext = DATA_ROOT ? Object.keys(imageTypes).find(key => imageTypes[key] === file.type) : file.name.split('.').pop() || 'png';
  if (!ext) throw new Error('Formato de imagen no permitido. Utilice PNG, JPG o SVG.');
  const uploadDir = DATA_ROOT ? await installedDirectory() : join(process.cwd(), config.logo.path);
  await fs.mkdir(uploadDir, { recursive: true });
  if (DATA_ROOT) await installedDirectory();
  const filename = `${Date.now()}-${randomUUID()}.${ext}`;
  const filePath = join(uploadDir, filename);

  if (DATA_ROOT) await fs.writeFile(filePath, buffer, { flag: 'wx' });
  else await fs.writeFile(filePath, buffer);
  return `/uploads/logos/${filename}`;
}

export function deleteLogo(relativePath: string): Promise<void> {
  return withRuntimeOperation(() => deleteAdmittedLogo(relativePath));
}

async function deleteAdmittedLogo(relativePath: string): Promise<void> {
  if (!relativePath || !relativePath.startsWith('/uploads/logos/')) return;
  const filename = relativePath.slice('/uploads/logos/'.length);
  if (DATA_ROOT && !installedName.test(filename)) return;
  try {
    const fullPath = DATA_ROOT ? join(await installedDirectory(), filename) : join(process.cwd(), 'public', relativePath);
    await fs.unlink(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('[LOGO] Delete failed', { path: relativePath, error: String(err) });
    }
  }
}
