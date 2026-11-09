/**
 * S20/S3 continued — the portable recovery refusal codes must reach the operator
 * in the SELECTED locale.
 *
 * The first-install page (es by default) renders every recovery refusal through
 * `translateApiError`. A code that has no `errors.<CODE>` entry falls back to the
 * SERVER message, and every recovery refusal is written in English, so a Spanish
 * operator used to see English text for the whole workflow. These are exactly the
 * codes `src/lib/backup-recovery-auth.ts` and
 * `src/lib/backup-recovery-provenance.ts` answer with.
 *
 * Pinned here:
 *  (a) every recovery code used by the workflow exists in BOTH catalogs with a
 *      non-empty, locale-native string, so `translateApiError` can never fall
 *      back to a raw code or to the other language;
 *  (b) the shared translator (not a page-local map) resolves them, which is what
 *      the export/download surfaces and the first-install page both use;
 *  (c) `RECOVERY_PASSWORD_MISMATCH` stays OUT of the global catalog: it is the
 *      one code whose guidance is context-specific (the export flow really does
 *      answer a password-only mismatch with it), so `BootstrapPage` keeps mapping
 *      it locally (see recovery-credential-message.test.tsx).
 */
import { describe, expect, it } from 'vitest';
import es from '@/i18n/locales/es';
import en from '@/i18n/locales/en';
import { getTranslation, translations, type Locale } from '@/lib/i18n';
import { translateApiError } from '@/i18n/errors';

/** The refusal codes the portable recovery workflow answers with. */
const RECOVERY_CODES = [
  'RECOVERY_TOKEN_EXPIRED',
  'RECOVERY_TOKEN_USED',
  'RECOVERY_TOO_MANY_ATTEMPTS',
  'RECOVERY_MAIL_UNAVAILABLE',
  'RECOVERY_FILE_UNSUPPORTED',
  'RECOVERY_FORMAT_UNSUPPORTED',
  'RECOVERY_CHALLENGE_ROTATED',
  'RECOVERY_IDENTITY_REQUIRED',
  'RECOVERY_COMPANY_MISMATCH',
  'RECOVERY_OWNER_UNAVAILABLE',
  'RECOVERY_IN_PROGRESS',
  'RECOVERY_LOCAL_ACCOUNT_LOGIN_REQUIRED',
] as const;

/** Same translator shape the language store builds (miss → the key itself). */
function translatorFor(locale: Locale) {
  return (key: string) => getTranslation(translations[locale] as Record<string, unknown>, key, key);
}

const catalogs = { es, en } as const;
/** A Spanish string reads with Spanish function words and/or its own accents. */
const SPANISH_MARKERS =
  /[áéíóúñ¿¡]|\b(?:de|del|la|el|los|las|un|una|unos|que|con|para|sin|no|tu|tus|volv[eé]|intent[aá]|pod[eé]s|ten[eé]s|us[aá])\b/i;

describe('every portable recovery refusal code is translated (es + en)', () => {
  it.each(RECOVERY_CODES)('%s exists in both catalogs and is resolved by the shared translator', (code) => {
    const esText = (catalogs.es.errors as Record<string, string>)[code];
    const enText = (catalogs.en.errors as Record<string, string>)[code];

    expect(typeof esText, `es.errors.${code}`).toBe('string');
    expect(typeof enText, `en.errors.${code}`).toBe('string');
    expect(esText.trim().length, `es.errors.${code}`).toBeGreaterThan(0);
    expect(enText.trim().length, `en.errors.${code}`).toBeGreaterThan(0);

    // Locale-native: the two catalogs must not share the same sentence, and a
    // translated string must never degrade into the raw machine code.
    expect(esText, `es.errors.${code} is not Spanish`).not.toBe(enText);
    expect(esText).toMatch(SPANISH_MARKERS);
    expect(esText).not.toMatch(/RECOVERY_[A-Z_]+/);
    expect(enText).not.toMatch(/RECOVERY_[A-Z_]+/);

    // The shared translator prefers the locale catalog over the server message.
    const serverMessage = `${code}: english server text`;
    expect(translateApiError({ error: serverMessage, code }, translatorFor('es'))).toBe(esText);
    expect(translateApiError({ error: serverMessage, code }, translatorFor('en'))).toBe(enText);
  });

  it('keeps each message operationally meaningful instead of a generic failure', () => {
    const es_ = catalogs.es.errors as Record<string, string>;
    const en_ = catalogs.en.errors as Record<string, string>;

    // "Wait, then retry" for the two throttling answers.
    expect(es_.RECOVERY_TOO_MANY_ATTEMPTS).toMatch(/intentos/i);
    expect(en_.RECOVERY_TOO_MANY_ATTEMPTS).toMatch(/attempts/i);
    expect(es_.RECOVERY_IN_PROGRESS).toMatch(/recuperaci[oó]n/i);
    expect(en_.RECOVERY_IN_PROGRESS).toMatch(/recovery/i);

    // Token lifecycle: the remedy is a NEW code, not the same one again.
    expect(es_.RECOVERY_TOKEN_EXPIRED).toMatch(/venci[oó]|expir/i);
    expect(es_.RECOVERY_TOKEN_USED).toMatch(/us[oó]/i);
    expect(es_.RECOVERY_CHALLENGE_ROTATED).toMatch(/reemplaz|cambi/i);
    expect(es_.RECOVERY_TOKEN_EXPIRED).toMatch(/nuevo/i);

    // Legacy format: export a NEW file rather than retrying the same one.
    expect(es_.RECOVERY_FORMAT_UNSUPPORTED).toMatch(/nuevo|otra vez|volv/i);
    expect(en_.RECOVERY_FORMAT_UNSUPPORTED).toMatch(/export|new/i);

    // Mail is a hard block, not a warning.
    expect(es_.RECOVERY_MAIL_UNAVAILABLE).toMatch(/correo/i);
    expect(en_.RECOVERY_MAIL_UNAVAILABLE).toMatch(/email|mail/i);

    // Company mismatch names the company name (S20: never a password-only story).
    expect(es_.RECOVERY_COMPANY_MISMATCH).toMatch(/empresa/i);
    expect(en_.RECOVERY_COMPANY_MISMATCH).toMatch(/company name/i);

    // The unopenable-file code names the file, not a single derivation input.
    expect(es_.RECOVERY_FILE_UNSUPPORTED).toMatch(/archivo/i);
    expect(es_.RECOVERY_IDENTITY_REQUIRED).toMatch(/empresa|contrase[ñn]a/i);
  });

  it('keeps RECOVERY_PASSWORD_MISMATCH out of the global catalog (context-specific copy)', () => {
    // `BootstrapPage` maps this one code to `bootstrap.recoveryCredentialMismatch`
    // because the SOURCE-OWNER EXPORT flow answers a genuinely password-only
    // mismatch with the same code. A global entry would move that multi-input
    // guidance onto the export screen, where it would be false.
    expect(Object.keys(catalogs.es.errors)).not.toContain('RECOVERY_PASSWORD_MISMATCH');
    expect(Object.keys(catalogs.en.errors)).not.toContain('RECOVERY_PASSWORD_MISMATCH');
    expect(translateApiError(
      { error: 'RECOVERY_PASSWORD_MISMATCH: The password does not match the source owner account',
        code: 'RECOVERY_PASSWORD_MISMATCH' },
      translatorFor('es'),
    )).toBe('RECOVERY_PASSWORD_MISMATCH: The password does not match the source owner account');
  });
});
