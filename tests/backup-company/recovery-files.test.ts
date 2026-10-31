import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { reconcileRecoveryFiles, companyConfigImage } from '@/lib/backup-recovery-files';
import { createRecoveryJournal } from '@/lib/backup-recovery-journal';

const bytes = (text: string) => Buffer.from(text).toString('base64');
function fixture() {
  const root = path.resolve('tests/backup-company/.scratch/files-' + crypto.randomUUID());
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, 'config.json');
  const journal = { operationId: crypto.randomUUID(), companyId: 'tenant', checksum: 'a'.repeat(64),
    files: [{ key: 'company-config', before: bytes('before Ñ'), after: bytes('after 中文') }] };
  createRecoveryJournal(path.join(root, 'journal'), journal);
  fs.writeFileSync(target, Buffer.from(journal.files[0].before!, 'base64'));
  return { root, target, journal };
}
it('reconciles committed intent and retries idempotently, then undoes with absent receipt', () => {
  const { target, journal } = fixture();
  const targets = { 'company-config': target };
  expect(reconcileRecoveryFiles(journal, targets, 'committed')).toBe('complete');
  expect(fs.readFileSync(target, 'utf8')).toBe('after 中文');
  expect(reconcileRecoveryFiles(journal, targets, 'committed')).toBe('complete');
  expect(reconcileRecoveryFiles(journal, targets, 'absent')).toBe('aborted');
  expect(fs.readFileSync(target, 'utf8')).toBe('before Ñ');
});
it('never changes bytes for unknown receipts or divergent destinations', () => {
  const { target, journal } = fixture();
  expect(reconcileRecoveryFiles(journal, { 'company-config': target }, 'unknown')).toBe('blocked');
  expect(fs.readFileSync(target, 'utf8')).toBe('before Ñ');
  fs.writeFileSync(target, 'newer edit');
  expect(reconcileRecoveryFiles(journal, { 'company-config': target }, 'committed')).toBe('blocked');
  expect(fs.readFileSync(target, 'utf8')).toBe('newer edit');
});
it('restores absence and preflights every target before changing any file', () => {
  const { root, target, journal } = fixture();
  const second = path.join(root, 'second');
  journal.files.push({ key: 'logo', before: null, after: bytes('new logo') });
  fs.writeFileSync(second, 'unrelated');
  expect(reconcileRecoveryFiles(journal, { 'company-config': target, logo: second }, 'committed')).toBe('blocked');
  expect(fs.readFileSync(target, 'utf8')).toBe('before Ñ');
  fs.unlinkSync(second);
  expect(reconcileRecoveryFiles(journal, { 'company-config': target, logo: second }, 'committed')).toBe('complete');
  expect(fs.readFileSync(second, 'utf8')).toBe('new logo');
  expect(reconcileRecoveryFiles(journal, { 'company-config': target, logo: second }, 'absent')).toBe('aborted');
  expect(fs.existsSync(second)).toBe(false);
});
it('updates only the selected company and preserves other companies/global fields', () => {
  const source = bytes(JSON.stringify({ global: { theme: 'dark' }, companies: { tenant: { currency: 'USD' }, other: { currency: 'EUR' } } }));
  const changed = JSON.parse(Buffer.from(companyConfigImage(source, 'tenant', { currency: 'ARS' }), 'base64').toString('utf8'));
  expect(changed).toEqual({ global: { theme: 'dark' }, companies: { tenant: { currency: 'ARS' }, other: { currency: 'EUR' } } });
  expect(Object.hasOwn(JSON.parse(Buffer.from(companyConfigImage(source, 'tenant', null), 'base64').toString('utf8')).companies, 'tenant')).toBe(false);
});
