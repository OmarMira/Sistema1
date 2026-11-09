// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import es from '@/i18n/locales/es';
import en from '@/i18n/locales/en';
import { translateApiError } from '@/i18n/errors';
import { getTranslation, translations } from '@/lib/i18n';

/**
 * S20 — the reported wrong-company recovery attempt rendered the raw server
 * string ("RECOVERY_PASSWORD_MISMATCH: … password or file does not match"): an
 * English, password-only explanation for a mistake that was in the COMPANY NAME.
 *
 * The portable file is sealed with AES-256-GCM over the owner password, the
 * owner email and the exact company name, so open() cannot say WHICH of them
 * failed. The UI must therefore explain all three derivation inputs together
 * with the file integrity, in the selected locale, and must never imply that the
 * password alone was wrong — without turning every 400 into a credential error.
 *
 * These tests drive the REAL `BootstrapPage` with a real API response body
 * (`{ error, code }`, code `RECOVERY_PASSWORD_MISMATCH`, the compatibility code
 * the route keeps returning). No static copy assertion and no ambient globals:
 * the translator is built from the real locale catalogs for the selected locale.
 */

const mockLanguage = vi.hoisted(() => ({ language: 'es' as 'es' | 'en' }));
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const authMocks = vi.hoisted(() => ({
  login: vi.fn(),
  setCurrentView: vi.fn(),
  setActiveCompany: vi.fn(),
}));

vi.mock('@/store/language-store', async () => {
  const { getTranslation, translations } = await import('@/lib/i18n');
  const state = {
    get language() {
      return mockLanguage.language;
    },
    setLanguage: () => {},
    // Exactly the store's translator: real catalog, dotted key, humanized miss.
    t: (key: string) =>
      getTranslation(translations[mockLanguage.language] as Record<string, unknown>, key, key),
  };
  return {
    useLanguageStore: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
  };
});

vi.mock('@/store/auth-store', () => {
  const state = {
    user: null,
    activeCompany: null,
    isAuthenticated: false,
    login: authMocks.login,
    setCurrentView: authMocks.setCurrentView,
    setActiveCompany: authMocks.setActiveCompany,
  };
  const useAuthStore = Object.assign(
    (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
    { getState: () => state },
  );
  return { useAuthStore };
});

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: { children?: ReactNode }) => <div {...props}>{children}</div>,
  },
}));
vi.mock('sonner', () => ({ toast: toastMocks, Toaster: () => null }));
vi.mock('@/components/spa/ThemeToggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/spa/LanguageSelector', () => ({ LanguageSelector: () => null }));
vi.mock('@/components/onboarding/InstallationWizard', () => ({ InstallationWizard: () => null }));

import { BootstrapPage } from '@/components/spa/BootstrapPage';

/** Locale parity is asserted elsewhere; this is only a relaxed read for the test. */
function dict(locale: 'es' | 'en') {
  return (locale === 'es' ? es : en) as unknown as Record<string, Record<string, string> | string>;
}

function bootstrapText(locale: 'es' | 'en', key: string): string {
  return (dict(locale).bootstrap as Record<string, string>)[key];
}

/** Shared `errors.<CODE>` catalog entry for the selected locale. */
function errorText(locale: 'es' | 'en', code: string): string {
  return (dict(locale).errors as Record<string, string>)[code];
}

/** The store's translator shape: real catalog for the selected locale. */
function translatorFor(locale: 'es' | 'en') {
  return (key: string) => getTranslation(translations[locale] as Record<string, unknown>, key, key);
}

const SYNTHETIC_EMAIL = 'owner@example.test';
const SYNTHETIC_PASSWORD = 'synthetic-owner-password-1';
const SYNTHETIC_COMPANY = 'Compania Origen S.A.';
/** What a wrong-company attempt actually gets back from /api/bootstrap/restore. */
const WRONG_COMPANY_RESPONSE = {
  error:
    'RECOVERY_PASSWORD_MISMATCH: Recovery file could not be opened: password or file does not match',
  code: 'RECOVERY_PASSWORD_MISMATCH',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  toastMocks.success.mockClear();
  toastMocks.error.mockClear();
  authMocks.login.mockClear();
  authMocks.setCurrentView.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Fill the real first-install recovery form and submit stage 1. */
async function submitRecovery(locale: 'es' | 'en', status: number, body: unknown): Promise<string> {
  mockLanguage.language = locale;
  render(<BootstrapPage />);

  fireEvent.click(screen.getByText(bootstrapText(locale, 'restoreBackup')));

  const fileInput = document.getElementById('bootstrap-file-input') as HTMLInputElement;
  expect(fileInput).toBeTruthy();
  fireEvent.change(fileInput, {
    target: {
      files: [new File(['{"format":"synthetic-portable"}'], 'synthetic-portable-backup.json', {
        type: 'application/json',
      })],
    },
  });
  fireEvent.change(screen.getByLabelText(bootstrapText(locale, 'ownerEmailLabel')), {
    target: { value: SYNTHETIC_EMAIL },
  });
  fireEvent.change(screen.getByLabelText(bootstrapText(locale, 'ownerPasswordLabel')), {
    target: { value: SYNTHETIC_PASSWORD },
  });
  fireEvent.change(screen.getByLabelText(bootstrapText(locale, 'companyNameLabel')), {
    target: { value: SYNTHETIC_COMPANY },
  });

  fetchMock.mockResolvedValueOnce(respond(status, body));
  fireEvent.click(screen.getByRole('button', { name: bootstrapText(locale, 'sendToken') }));

  const alert = await waitFor(() => screen.getByTestId('bootstrap-restore-error'));
  return alert.textContent ?? '';
}

describe('recovery credential copy is scoped to the recovery form, not to the code', () => {
  /**
   * The SOURCE-OWNER EXPORT flow (src/lib/backup.ts `resolvePortableSourceOwner`
   * callers) throws the SAME code for a genuinely password-only mismatch, and
   * other screens render it through the shared `translateApiError`. That global
   * path must keep its pre-existing fallback: the server message, untouched.
   */
  const LEGACY_EXPORT_MESSAGE =
    'RECOVERY_PASSWORD_MISMATCH: The password does not match the source owner account';

  it('keeps the shared translator on the legacy export server message', () => {
    for (const locale of ['es', 'en'] as const) {
      const translated = translateApiError(
        { error: LEGACY_EXPORT_MESSAGE, code: 'RECOVERY_PASSWORD_MISMATCH' },
        translatorFor(locale),
      );
      expect(translated).toBe(LEGACY_EXPORT_MESSAGE);
      expect(translated).not.toBe(bootstrapText(locale, 'recoveryCredentialMismatch'));
      expect(translated).not.toMatch(/company name|nombre exacto de la empresa/i);
    }
    // Guard against re-registering the multi-input guidance as a global code.
    expect(Object.keys(es.errors)).not.toContain('RECOVERY_PASSWORD_MISMATCH');
    expect(Object.keys(en.errors)).not.toContain('RECOVERY_PASSWORD_MISMATCH');
  });
});

describe('bootstrap recovery credential failure copy (S20)', () => {
  it('explains every bound input plus the file in Spanish, without pretending it knows', async () => {
    const rendered = await submitRecovery('es', 400, WRONG_COMPANY_RESPONSE);
    const expected = bootstrapText('es', 'recoveryCredentialMismatch');

    expect(rendered).toBe(expected);
    // The three derivation inputs and the file integrity are all named, which is
    // what the mistaken-company report asked for.
    expect(rendered).toMatch(/contraseña/i);
    expect(rendered).toMatch(/email/i);
    expect(rendered).toMatch(/empresa/i);
    expect(rendered).toMatch(/archivo/i);
    // Cryptographic ambiguity is preserved instead of blamed on the password.
    expect(rendered).toMatch(/no se puede (saber|identificar)/i);
    expect(rendered).not.toMatch(/solo la contraseña|únicamente la contraseña|contraseña incorrecta/i);
    // No raw code dump and no English server string.
    expect(rendered).not.toContain('RECOVERY_PASSWORD_MISMATCH');
    expect(rendered).not.toContain('password or file does not match');
    // T28 (L62) changed this pinned expectation on purpose: the operator saw this
    // exact guidance TWICE for one failed attempt (toast + inline banner, identical
    // text). The inline alert above is now the single notice, so the old "both
    // surfaces carry the same copy" contract is replaced by "exactly one notice".
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it('explains every bound input plus the file in English', async () => {
    const rendered = await submitRecovery('en', 400, WRONG_COMPANY_RESPONSE);
    const expected = bootstrapText('en', 'recoveryCredentialMismatch');

    expect(rendered).toBe(expected);
    expect(rendered).toMatch(/password/i);
    expect(rendered).toMatch(/email/i);
    expect(rendered).toMatch(/company name/i);
    expect(rendered).toMatch(/file/i);
    expect(rendered).toMatch(/cannot be identified|can't be identified/i);
    expect(rendered).not.toMatch(/password is incorrect|wrong password/i);
    expect(rendered).not.toContain('RECOVERY_PASSWORD_MISMATCH');
    expect(rendered).not.toContain('password or file does not match');
    expect(rendered).not.toBe(bootstrapText('es', 'recoveryCredentialMismatch'));
  });

  it('keeps the server message for another 400 code (no blanket credential copy)', async () => {
    // Re-pinned for F6/T27: `RECOVERY_COMPANY_MISMATCH` USED to be untranslated
    // and this case used it to prove that an unrelated 400 never receives the
    // credential copy. F6 adds the recovery refusal codes to the shared catalog
    // (a Spanish operator must not read English refusals), so that code is now
    // locale-native by design. The intent is preserved with a refusal that still
    // has no catalog entry, and the company-mismatch expectation is pinned below.
    const serverMessage = 'RECOVERY_RESTORE_REFUSED: the destination refused the payload';
    const rendered = await submitRecovery('es', 400, {
      error: serverMessage,
      code: 'RECOVERY_RESTORE_REFUSED',
    });

    expect(rendered).toBe(serverMessage);
    expect(rendered).not.toBe(bootstrapText('es', 'recoveryCredentialMismatch'));
    expect(rendered).not.toContain('archivo');
  });

  it('renders the localized company-mismatch refusal instead of the English server message', async () => {
    const serverMessage = 'The company name does not match the company recorded in this backup.';
    const rendered = await submitRecovery('es', 400, {
      error: serverMessage,
      code: 'RECOVERY_COMPANY_MISMATCH',
    });

    expect(rendered).toBe(errorText('es', 'RECOVERY_COMPANY_MISMATCH'));
    expect(rendered).not.toBe(serverMessage);
    // Still never the multi-input credential guidance: that one stays scoped to
    // `RECOVERY_PASSWORD_MISMATCH`.
    expect(rendered).not.toBe(bootstrapText('es', 'recoveryCredentialMismatch'));
  });

  it('keeps a code-less 400 on the server message', async () => {
    const serverMessage = 'No se pudo leer el formulario enviado.';
    const rendered = await submitRecovery('en', 400, { error: serverMessage });

    expect(rendered).toBe(serverMessage);
  });
});
