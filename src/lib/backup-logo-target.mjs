import path from 'node:path';

const generatedName = /^\d{1,16}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpe?g|svg)$/i;
/** Paths derive from trusted application configuration, never archive paths. */
export function resolveCompanyLogoTarget(url, dataRoot, developmentDirectory) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/logos/')) throw new Error('BACKUP_ASSET: unsupported logo URL');
  const filename = url.slice('/uploads/logos/'.length);
  if (!generatedName.test(filename)) throw new Error('BACKUP_ASSET: unsupported logo filename');
  return path.join(dataRoot ? path.join(dataRoot, 'uploads/logos') : path.join(process.cwd(), developmentDirectory), filename);
}
