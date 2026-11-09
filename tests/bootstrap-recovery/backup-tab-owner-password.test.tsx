// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * Create-UI contract for the reported incident (T10 / S14): the operator's
 * screenshot showed a "Create Backup" button with NO password field, while the
 * route requires the owner password (400 RECOVERY_PASSWORD_REQUIRED). These
 * tests pin the current component contract: it asks for the exact current owner
 * password, sends it unchanged, and surfaces preserved-but-unreadable backups
 * instead of hiding them behind an empty history.
 */
const mockLangState = { t: (key: string) => key, language: 'es' };
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector?: (state: typeof mockLangState) => unknown) =>
    selector ? selector(mockLangState) : mockLangState,
}));

const mockAuthState = {
  activeCompany: { id: 'tenant', legalName: 'Mi Empresa S.A.' },
  user: { id: 'admin-tenant' },
  isAuthenticated: true,
};
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector?: (state: typeof mockAuthState) => unknown) =>
    selector ? selector(mockAuthState) : mockAuthState,
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: { children?: ReactNode }) => <div {...props}>{children}</div>,
  },
}));
vi.mock('sonner', () => ({ toast: toastMocks }));
vi.mock('@/lib/backup-download', () => ({ downloadBackup: vi.fn() }));

import { BackupTab } from '@/components/spa/settings/BackupTab';

const readable = {
  id: 'record-1',
  filename: 'tenant_ok.json',
  size: 2048,
  createdAt: '2026-01-05T10:00:00.000Z',
  companyInfo: { id: 'tenant', legalName: 'Mi Empresa S.A.' },
  recordCounts: { company: 1 },
};

function respond(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  toastMocks.success.mockClear();
  toastMocks.error.mockClear();
  toastMocks.warning.mockClear();
  fetchMock = vi.fn(async () => respond({ backups: [], unreadable: [] }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function createButton() {
  return screen.getByRole('button', { name: 'settings.backup.createBackup' });
}

describe('BackupTab — owner password', () => {
  it('asks for the current owner password and blocks an empty submission', async () => {
    render(<BackupTab />);

    const input = await screen.findByPlaceholderText('settings.backup.recoveryPasswordLabel');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByText('settings.backup.recoveryPasswordHint')).toBeInTheDocument();

    const button = createButton();
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
  });

  it('sends the typed owner password unchanged', async () => {
    const password = '  Ñandú clave 1  ';
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('/api/backup?')) return respond({ backups: [readable], unreadable: [] });
      return respond({
        id: 'record-2',
        filename: 'tenant_new.json',
        recoveryFilename: 'tenant_new_recovery.json',
        size: 1,
        recordCounts: { company: 1 },
        data: '',
      });
    });
    render(<BackupTab />);

    const input = await screen.findByPlaceholderText('settings.backup.recoveryPasswordLabel');
    fireEvent.change(input, { target: { value: password } });
    fireEvent.click(createButton());

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) =>
        String(url) === '/api/backup' && (init as RequestInit | undefined)?.method === 'POST')).toBe(true);
    });
    const [, init] = fetchMock.mock.calls.find(([url, config]) =>
      String(url) === '/api/backup' && (config as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ companyId: 'tenant', password });
  });
});

describe('BackupTab — creation with an unverified catalog', () => {
  it('surfaces the storage warning of a created-but-unmaintained backup', async () => {
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('/api/backup?')) return respond({ backups: [], unreadable: [] });
      return respond({
        id: 'record-3',
        filename: 'tenant_new.json',
        recoveryFilename: 'tenant_new_recovery.json',
        size: 1,
        recordCounts: { company: 1 },
        data: '',
        recoveryProtected: true,
        catalogWarning: {
          code: 'BACKUP_CATALOG_UNVERIFIED',
          message: 'catalog and retention were skipped',
        },
      });
    });
    render(<BackupTab />);

    fireEvent.change(await screen.findByPlaceholderText('settings.backup.recoveryPasswordLabel'), {
      target: { value: 'clave-duena-1' },
    });
    fireEvent.click(createButton());

    await waitFor(() => expect(toastMocks.warning).toHaveBeenCalledTimes(1));
    expect(toastMocks.warning).toHaveBeenCalledWith('settings.backup.catalogUnverifiedTitle', {
      description: 'settings.backup.catalogUnverifiedDesc',
    });
    // The backup itself is still reported as created.
    expect(toastMocks.success).toHaveBeenCalledWith('settings.backup.backupCreated', expect.anything());
  });
});

describe('BackupTab — unreadable backup files', () => {
  it('surfaces a same-company unreadable backup next to the readable history', async () => {
    fetchMock.mockImplementation(async () => respond({
      backups: [readable],
      unreadable: [{
        filename: 'tenant_danado.json',
        error: 'Backup file tenant_danado.json could not be decrypted: the ciphertext failed authentication',
      }],
    }));
    render(<BackupTab />);

    expect(await screen.findByText('settings.backup.unreadableBackupsTitle')).toBeInTheDocument();
    expect(screen.getByText('settings.backup.unreadableBackupsDesc')).toBeInTheDocument();
    expect(screen.getByText('tenant_danado.json')).toBeInTheDocument();
    expect(screen.getByText('Mi Empresa S.A.')).toBeInTheDocument();
  });

  it('shows no integrity warning for a clean catalog', async () => {
    render(<BackupTab />);

    expect(await screen.findByText('settings.backup.noBackups')).toBeInTheDocument();
    expect(screen.queryByText('settings.backup.unreadableBackupsTitle')).not.toBeInTheDocument();
  });
});
