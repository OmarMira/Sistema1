import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSnapshot, sealSnapshot } from '@/lib/backup-format';
import { validateRestoreSource, validateRestoreDestination } from '@/lib/backup-validation';
import {
  COMPANY_ID, auditRow, localText, makeSnapshot, withEnv,
} from './helpers';

/**
 * The portable path is opt-in. Everything the authenticated replacement already
 * does must keep working exactly as before, and no new reader may accept a
 * weaker file just because bootstrap now has a portable mode.
 */
describe('previous authenticated replacement is unaffected', () => {
  it('keeps the default reader verifying the local seal and full source validation', () => {
    const text = localText(makeSnapshot());
    expect(parseSnapshot(text).manifest.companyId).toBe(COMPANY_ID);
    const source = validateRestoreSource(COMPANY_ID, text);
    expect(source.snapshot.manifest.version).toBe('2.1.0');
    expect(source.tables.Company).toHaveLength(1);
  });

  it('keeps refusing a foreign-keyed backup through the authenticated path', () => {
    const text = withEnv({ SESSION_SECRET: 'another-installation-secret' }, () => localText(makeSnapshot()));
    expect(() => validateRestoreSource(COMPANY_ID, text)).toThrow(/checksum/i);
  });

  it('keeps the portable reader strictly opt-in and authenticated', () => {
    const text = localText(makeSnapshot());
    // No authenticated digest: the portable reader refuses instead of skipping
    // the seal, so it can never be used as a blanket bypass.
    expect(() => validateRestoreSource(COMPANY_ID, text, { recovery: 'portable' }))
      .toThrow(/PORTABLE_RECOVERY_UNAUTHENTICATED/);
    const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    expect(validateRestoreSource(COMPANY_ID, text, {
      recovery: 'portable', authenticatedDigest: digest,
    }).tables.Company).toHaveLength(1);
  });

  it('still requires the destination company to exist before any replacement', () => {
    const text = localText(makeSnapshot());
    const source = validateRestoreSource(COMPANY_ID, text);
    expect(() => validateRestoreDestination(source.tables, { ...source.tables }, COMPANY_ID))
      .not.toThrow();
    expect(() => validateRestoreDestination(source.tables, {
      ...source.tables,
      Company: [{ ...source.tables.Company[0], id: 'other-company' }],
    }, COMPANY_ID)).toThrow(/RESTORE_IDENTITY/);
  });

  it('keeps the seal contract identical for a locally stored snapshot', () => {
    const snapshot = makeSnapshot();
    sealSnapshot(snapshot);
    expect(parseSnapshot(JSON.stringify(snapshot)).manifest.integrity?.algorithm).toBe('hmac-sha256');
    const tampered = JSON.parse(JSON.stringify(snapshot)) as { data: { company: Array<{ legalName: string }> } };
    tampered.data.company[0].legalName = 'Otro nombre';
    expect(() => parseSnapshot(JSON.stringify(tampered))).toThrow(/checksum/i);
  });
});
