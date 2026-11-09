// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import es from '@/i18n/locales/es';
import en from '@/i18n/locales/en';
import { getTranslation, translations } from '@/lib/i18n';

/**
 * T28 (L62) — ONE professional notice per failed recovery attempt.
 *
 * The operator's real opening screen showed the localized credential guidance
 * TWICE for a single failed attempt (screenshot 20A0DEDB): once as the persistent
 * inline banner and once as a toast with the identical text.
 *
 * The inline banner is the primary display — it stays on screen, it is announced
 * by `role="alert"`, and this page renders outside the AppShell. Reporting the
 * same message as a toast as well is a duplicate notice, not extra information.
 *
 * Pinned here through the REAL `BootstrapPage` with real locale catalogs:
 *  (a) each failed attempt shows exactly ONE visible copy of the message, as the
 *      inline banner, and never also a toast;
 *  (b) an error that is NOT rendered inline (the page leaves the restore form)
 *      still toasts — the correction must not create silent failures.
 */

const mockLanguage = vi.hoisted(() => ({ language: 'es' as 'es' | 'en' }));
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const authMocks = vi.hoisted(() => ({
  login: vi.fn(),
  setCurrentView: vi.fn(),
  setActiveCompany: vi.fn(),
}));

vi.mock('@/store/language-store', async () => {
  const { getTranslation: translate, translations: catalogs } = await import('@/lib/i18n');
  const state = {
    get language() {
      return mockLanguage.language;
    },
    setLanguage: () => {},
    t: (key: string) => translate(catalogs[mockLanguage.language] as Record<string, unknown>, key, key),
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

function bootstrapText(locale: 'es' | 'en', key: string): string {
  return ((locale === 'es' ? es : en) as unknown as {
    bootstrap: Record<string, string>;
  }).bootstrap[key];
}

const SYNTHETIC_EMAIL = 'owner@example.test';
const SYNTHETIC_PASSWORD = 'synthetic-owner-password-1';
const SYNTHETIC_COMPANY = 'Compania Origen S.A.';
const SYNTHETIC_TOKEN = 'synthetic-token-000000';
const CREDENTIAL_RESPONSE = {
  error: 'RECOVERY_PASSWORD_MISMATCH: Recovery file could not be opened',
  code: 'RECOVERY_PASSWORD_MISMATCH',
};
const NOT_EMPTY_RESPONSE = {
  error: 'DB_NOT_EMPTY: This installation already contains companies',
  code: 'DB_NOT_EMPTY',
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
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** Open the real first-install recovery form and fill every sealed input. */
function openRecoveryForm(locale: 'es' | 'en') {
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
}

/** Drive stage 1 to `challenge_sent`, i.e. to the token input. */
async function reachTokenStage(locale: 'es' | 'en') {
  openRecoveryForm(locale);
  fetchMock.mockResolvedValueOnce(respond(200, { stage: 'challenge_sent' }));
  fireEvent.click(screen.getByRole('button', { name: bootstrapText(locale, 'sendToken') }));
  const tokenInput = await waitFor(() => screen.getByLabelText(bootstrapText(locale, 'tokenLabel')));
  fireEvent.change(tokenInput, { target: { value: SYNTHETIC_TOKEN } });
}

/** Exact, visible copies of one message in the rendered page text. */
function visibleCopies(message: string): number {
  const text = document.body.textContent ?? '';
  return message.length === 0 ? 0 : text.split(message).length - 1;
}

describe('a failed recovery attempt shows exactly one notice (T28/S20)', () => {
  it('shows the credential guidance ONCE, inline, and suppresses the duplicate toast (ES)', async () => {
    openRecoveryForm('es');
    fetchMock.mockResolvedValueOnce(respond(400, CREDENTIAL_RESPONSE));
    fireEvent.click(screen.getByRole('button', { name: bootstrapText('es', 'sendToken') }));

    const alert = await waitFor(() => screen.getByTestId('bootstrap-restore-error'));
    const expected = bootstrapText('es', 'recoveryCredentialMismatch');

    expect(alert.textContent).toBe(expected);
    // ONE visible copy: the persistent, screen-reader-announced banner.
    expect(screen.getAllByTestId('bootstrap-restore-error')).toHaveLength(1);
    expect(visibleCopies(expected)).toBe(1);
    // …and NOT the same notice again as a toast.
    expect(toastMocks.error).not.toHaveBeenCalled();
    // Nothing successful was claimed either.
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it('shows the credential guidance ONCE for the token stage too (EN)', async () => {
    await reachTokenStage('en');
    toastMocks.error.mockClear();
    fetchMock.mockResolvedValueOnce(respond(400, CREDENTIAL_RESPONSE));
    fireEvent.click(screen.getByRole('button', { name: bootstrapText('en', 'completeRestore') }));

    const alert = await waitFor(() => screen.getByTestId('bootstrap-restore-error'));
    const expected = bootstrapText('en', 'recoveryCredentialMismatch');

    expect(alert.textContent).toBe(expected);
    expect(visibleCopies(expected)).toBe(1);
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it('keeps an unrelated server refusal on ONE inline notice as well (ES)', async () => {
    const serverMessage = 'RECOVERY_RESTORE_REFUSED: the destination refused the payload';
    openRecoveryForm('es');
    fetchMock.mockResolvedValueOnce(respond(400, {
      error: serverMessage, code: 'RECOVERY_RESTORE_REFUSED',
    }));
    fireEvent.click(screen.getByRole('button', { name: bootstrapText('es', 'sendToken') }));

    const alert = await waitFor(() => screen.getByTestId('bootstrap-restore-error'));
    expect(alert.textContent).toBe(serverMessage);
    expect(visibleCopies(serverMessage)).toBe(1);
    expect(toastMocks.error).not.toHaveBeenCalled();
    // The context-specific translation behaviour is untouched by this correction.
    expect(alert.textContent).not.toBe(bootstrapText('es', 'recoveryCredentialMismatch'));
  });

  it('still toasts an error that has NO inline banner', async () => {
    await reachTokenStage('es');
    toastMocks.error.mockClear();
    fetchMock.mockResolvedValueOnce(respond(409, NOT_EMPTY_RESPONSE));
    fireEvent.click(screen.getByRole('button', { name: bootstrapText('es', 'completeRestore') }));

    // The page leaves the restore form, so nothing is rendered inline: the single
    // notice must be the toast. One requirement is not allowed to create silence.
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('bootstrap-restore-error')).toBeNull();
    const [first] = toastMocks.error.mock.calls[0] as [string, { description?: string }?];
    expect(first).toContain('DB_NOT_EMPTY');
  });
});
