import crypto from 'node:crypto';
export const companyLogoRecoveryTarget = async (url: string) =>
  (await import('./uploads/logo-service')).companyLogoArchiveTarget(url);
import { recoveryFileImage } from './backup-recovery-files';
export interface CompanyLogoImage { url: string; base64: string; sha256: string }
const maximum = 10 * 1024 * 1024;
export function validateCompanyLogo(url: unknown, image: unknown): asserts image is CompanyLogoImage | null {
  if (url === null || url === undefined || url === '') {
    if (image !== undefined && image !== null) throw new Error('BACKUP_ASSET: unowned logo bytes');
    return;
  }
  const candidate = image as CompanyLogoImage | undefined;
  if (typeof url !== 'string' || !candidate || candidate.url !== url || typeof candidate.base64 !== 'string' ||
      candidate.base64.length > Math.ceil(maximum / 3) * 4 || typeof candidate.sha256 !== 'string') throw new Error('BACKUP_ASSET: missing or invalid logo bytes');
  const bytes = Buffer.from(candidate.base64, 'base64');
  if (bytes.length > maximum || bytes.toString('base64') !== candidate.base64 ||
      crypto.createHash('sha256').update(bytes).digest('hex') !== candidate.sha256) throw new Error('BACKUP_ASSET: invalid logo integrity');
}
export async function captureCompanyLogo(url: unknown): Promise<CompanyLogoImage | null> {
  if (!url) return null;
  if (typeof url !== 'string') throw new Error('BACKUP_ASSET: invalid logo URL');
  const base64 = recoveryFileImage(await companyLogoRecoveryTarget(url));
  if (base64 === null) throw new Error('BACKUP_ASSET: referenced logo file missing');
  const image = { url, base64, sha256: crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex') };
  validateCompanyLogo(url, image);
  return image;
}
export async function planCompanyLogo(url: unknown, image: unknown) {
  validateCompanyLogo(url, image);
  if (!image) return null;
  const target = await companyLogoRecoveryTarget(image.url);
  return { target, file: { key: 'company-logo', before: recoveryFileImage(target), after: image.base64 } };
}
