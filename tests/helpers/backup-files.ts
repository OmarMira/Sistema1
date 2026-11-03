import fs from 'fs';
import path from 'path';
import { BACKUP_DIR } from '@/lib/config/paths';

/**
 * Remove the runtime backup files a test created, together with their catalog
 * entries. Backups live in the runtime BACKUP_DIR (never in the repository
 * tree); a safety preimage published by a restore is a backup file too.
 */
export function cleanupBackupFiles(filenames: (string | undefined)[]): void {
  const names = filenames.filter((name): name is string => typeof name === 'string' && name.length > 0);
  for (const name of names) {
    const filePath = path.join(BACKUP_DIR, name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  const manifestPath = path.join(BACKUP_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { backups: { filename: string }[] };
    manifest.backups = manifest.backups.filter((entry) => !names.includes(entry.filename));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch {
    // A corrupt manifest is a pre-existing condition; cleanup must not mask it.
  }
}
