import { promises as fs } from 'fs';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';

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

export async function saveLogo(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const sizeMB = buffer.length / (1024 * 1024);

  if (sizeMB > config.logo.maxSizeMB) {
    throw new Error(`El archivo de logo excede el límite de ${config.logo.maxSizeMB}MB`);
  }
  if (!config.logo.allowedFormats.includes(file.type)) {
    throw new Error('Formato de imagen no permitido. Utilice PNG, JPG o SVG.');
  }

  const uploadDir = join(process.cwd(), config.logo.path);
  await fs.mkdir(uploadDir, { recursive: true });

  const ext = file.name.split('.').pop() || 'png';
  const filename = `${Date.now()}-${randomUUID()}.${ext}`;
  const filePath = join(uploadDir, filename);

  await fs.writeFile(filePath, buffer);
  return `/uploads/logos/${filename}`;
}

export async function deleteLogo(relativePath: string): Promise<void> {
  if (!relativePath || !relativePath.startsWith('/uploads/logos/')) return;
  const fullPath = join(process.cwd(), 'public', relativePath);
  try {
    await fs.unlink(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('[LOGO] Delete failed', { path: relativePath, error: String(err) });
    }
  }
}
