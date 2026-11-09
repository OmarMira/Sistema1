// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * S23 — "Restaurar desde backup" on the company administration page.
 *
 * The reported situation (L82) is an owner with NO company after a machine
 * change: the page must expose the owner-verified portable door, accept the SAME
 * encrypted container as the initial page, and show the restored company without
 * a manual reload. The door is the installation owner's: an account that is not
 * a global super administrator must not even see it (no promotion).
 */
const mockLangState = { t: (key: string) => key, language: 'es' };
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector?: (state: typeof mockLangState) => unknown) =>
    selector ? selector(mockLangState) : mockLangState,
}));

const mockAuthState = {
  user: { id: 'owner-1', email: 'owner@example.test', role: 'super_admin' as 'super_admin' | 'user' },
  activeCompany: null,
  currentView: 'admin-companies',
  setCurrentView: vi.fn(),
  setAdminSelectedCompanyId: vi.fn(),
};
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector?: (state: typeof mockAuthState) => unknown) =>
    selector ? selector(mockAuthState) : mockAuthState,
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: { children?: ReactNode }) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMocks }));

import AdminCompaniesPage from '@/components/spa/admin/AdminCompaniesPage';
import es from '@/i18n/locales/es';
import en from '@/i18n/locales/en';

const PORTABLE_TEXT = JSON.stringify({
  format: 'accountexpress-portable-recovery',
  version: 3,
  kdf: { algorithm: 'scrypt', N: 16384, r: 8, p: 1, salt: 'c2FsdA==' },
  binding: { iv: 'aXY=', tag: 'dGFn', ciphertext: 'Y3Q=' },
  cipher: { name: 'aes-256-gcm', salt: 'c2FsdA==', iv: 'aXY=', tag: 'dGFn' },
  ciphertext: 'Y3Q=',
});

function respond(payload: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 400, json: async () => payload } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockLangState.t = (key: string) => key;
  mockLangState.language = 'es';
  mockAuthState.user = { id: 'owner-1', email: 'owner@example.test', role: 'super_admin' };
  fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url) === '/api/admin/companies') return respond({ companies: [] });
    return respond({ stage: 'challenge_sent', expiresAt: '2026-02-01T12:15:00.000Z' });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function choosePortableFile() {
  const input = screen.getByTestId('admin-restore-file-input');
  const file = new File([PORTABLE_TEXT], 'recovery.json', { type: 'application/json' });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

describe('AdminCompaniesPage — portable owner door (S23)', () => {
  it('exposes the door on a zero-company installation', async () => {
    render(<AdminCompaniesPage />);

    expect(await screen.findByText('adminCompanies.noCompanies')).toBeInTheDocument();
    expect(screen.getByText('adminCompanies.restoreBackupZeroHint')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'adminCompanies.restoreBackupTitle' }),
    ).toBeInTheDocument();
  });

  it('does not expose the door to an account that is not the installation owner', async () => {
    mockAuthState.user = { id: 'user-1', email: 'contador@example.test', role: 'user' };
    render(<AdminCompaniesPage />);

    expect(await screen.findByText('adminCompanies.noCompanies')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'adminCompanies.restoreBackupTitle' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('adminCompanies.restoreBackupZeroHint')).not.toBeInTheDocument();
  });

  it('runs the two-stage owner flow and reloads the company list afterwards', async () => {
    render(<AdminCompaniesPage />);
    await screen.findByText('adminCompanies.noCompanies');

    choosePortableFile();

    // Stage 1: the operator confirms the sealed inputs before any code is sent.
    const email = await screen.findByLabelText('adminCompanies.restoreOwnerEmailLabel');
    expect(email).toHaveValue('owner@example.test');
    fireEvent.change(screen.getByLabelText('adminCompanies.restoreCompanyNameLabel'), {
      target: { value: 'LQ & OM LLC' },
    });
    fireEvent.change(screen.getByLabelText('adminCompanies.restoreOwnerPasswordLabel'), {
      target: { value: 'clave-propietario-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'adminCompanies.restoreSendCode' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) =>
        String(url) === '/api/backup/restore?mode=portable&door=admin')).toBe(true);
    });
    const [, init] = fetchMock.mock.calls.find(([url]) =>
      String(url) === '/api/backup/restore?mode=portable&door=admin')!;
    const form = (init as RequestInit).body as FormData;
    expect(form.get('ownerEmail')).toBe('owner@example.test');
    expect(form.get('companyName')).toBe('LQ & OM LLC');
    expect(form.get('token')).toBeNull();

    // Stage 2: the emailed code completes the restore.
    const token = await screen.findByLabelText('adminCompanies.restoreCodeLabel');
    fireEvent.change(token, { target: { value: 'a'.repeat(64) } });
    fireEvent.click(screen.getByRole('button', { name: 'adminCompanies.restoreConfirm' }));

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith('adminCompanies.restoreSuccess'));
    // A successful restore opens the existing refreshed company selector.
    await waitFor(() => expect(mockAuthState.setCurrentView).toHaveBeenCalledWith('select-company'));
    // The restored company must appear without a reload.
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/admin/companies')).toHaveLength(2);
    });
  });

  it('shows a single inline notice when the installation already has that company', async () => {
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/admin/companies') return respond({ companies: [] });
      return respond({ error: 'already here', code: 'RECOVERY_COMPANY_EXISTS' }, false);
    });
    render(<AdminCompaniesPage />);
    await screen.findByText('adminCompanies.noCompanies');

    choosePortableFile();
    fireEvent.change(await screen.findByLabelText('adminCompanies.restoreCompanyNameLabel'), {
      target: { value: 'LQ & OM LLC' },
    });
    fireEvent.change(screen.getByLabelText('adminCompanies.restoreOwnerPasswordLabel'), {
      target: { value: 'clave-propietario-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'adminCompanies.restoreSendCode' }));

    const notices = await screen.findAllByRole('alert');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toHaveTextContent('adminCompanies.restoreCompanyExists');
    // One notice only: no toast repeats the same refusal.
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it.each([
    ['es', es, 'No se pudo abrir el respaldo. Verificá el correo del propietario, el nombre de la empresa tal como figura en el respaldo y la contraseña original. Si los datos son correctos, el archivo podría estar incompleto o dañado.'],
    ['en', en, 'The backup could not be opened. Check the owner email, the company name as recorded in the backup, and the original password. If these details are correct, the file may be incomplete or damaged.'],
  ] as const)('shows a plain credential rejection in %s without advancing the restore', async (language, locale, expected) => {
    mockLangState.language = language;
    mockLangState.t = (key: string) => {
      const prefix = 'adminCompanies.';
      const value = key.startsWith(prefix)
        ? (locale.adminCompanies as Record<string, unknown>)[key.slice(prefix.length)]
        : undefined;
      return typeof value === 'string' ? value : key;
    };
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/admin/companies') return respond({ companies: [] });
      return respond({
        code: 'RECOVERY_PASSWORD_MISMATCH',
        error: 'RECOVERY_PASSWORD_MISMATCH: Recovery file could not be opened. AES-256-GCM.',
      }, false);
    });
    render(<AdminCompaniesPage />);
    await screen.findByText(locale.adminCompanies.noCompanies);
    choosePortableFile();
    fireEvent.change(await screen.findByLabelText(locale.adminCompanies.restoreCompanyNameLabel), {
      target: { value: 'Wrong company' },
    });
    fireEvent.change(screen.getByLabelText(locale.adminCompanies.restoreOwnerPasswordLabel), {
      target: { value: 'wrong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: locale.adminCompanies.restoreSendCode }));

    const notices = await screen.findAllByRole('alert');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toHaveTextContent(expected);
    expect(notices[0]).not.toHaveTextContent(/RECOVERY_PASSWORD_MISMATCH|AES-256-GCM/);
    expect(screen.queryByLabelText(locale.adminCompanies.restoreCodeLabel)).not.toBeInTheDocument();
    expect(mockAuthState.setCurrentView).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('mode=portable'))).toHaveLength(1);
  });

  it('refuses a file that is not the owner container without leaving the page', async () => {
    render(<AdminCompaniesPage />);
    await screen.findByText('adminCompanies.noCompanies');

    const input = screen.getByTestId('admin-restore-file-input');
    fireEvent.change(input, {
      target: { files: [new File([JSON.stringify({ manifest: {}, data: {} })], 'interno.json')] },
    });

    const notices = await screen.findAllByRole('alert');
    expect(notices[0]).toHaveTextContent('adminCompanies.restoreFileUnsupported');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('mode=portable'))).toBe(false);
  });
});
