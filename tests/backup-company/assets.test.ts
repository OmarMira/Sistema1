import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ target: '' }));
vi.mock('@/lib/uploads/logo-service', () => ({ companyLogoArchiveTarget: async () => state.target }));
import { captureCompanyLogo, validateCompanyLogo, planCompanyLogo } from '@/lib/backup-assets';
it('captures exact logo bytes, validates identity/integrity, and maps a journal preimage', async () => {
  const root = path.resolve('tests/backup-company/.scratch/asset-' + crypto.randomUUID());
  fs.mkdirSync(root, { recursive: true }); state.target = path.join(root, 'logo.png');
  fs.writeFileSync(state.target, Buffer.from([137,80,78,71,0,255,1]));
  const url = '/uploads/logos/1234567890123-' + crypto.randomUUID() + '.png';
  const image = await captureCompanyLogo(url);
  expect(image!.base64).toBe(fs.readFileSync(state.target).toString('base64'));
  expect(() => validateCompanyLogo(url, image)).not.toThrow();
  expect(() => validateCompanyLogo('/other', image)).toThrow();
  expect(() => validateCompanyLogo(url, { ...image!, base64: 'AAAA' })).toThrow();
  fs.writeFileSync(state.target, 'new destination');
  const plan = await planCompanyLogo(url, image);
  expect(plan!.file.before).toBe(Buffer.from('new destination').toString('base64'));
  expect(plan!.file.after).toBe(image!.base64);
  expect(plan!.target).toBe(state.target);
});
it('requires actual bytes for any non-null source logo instead of guessing legacy assets', () => {
  expect(() => validateCompanyLogo('/uploads/logos/missing.png', undefined)).toThrow('BACKUP_ASSET');
  expect(() => validateCompanyLogo(null, null)).not.toThrow();
});
