// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// jsdom implements no ResizeObserver; Radix tooltips measure their content with
// one. Same inline stub the other component suites use.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
import type { ReactNode } from 'react';

/**
 * S24 — Configuración → Respaldos del Sistema accepts the portable container.
 *
 * The reported sequence (L82) was a portable file sent through the internal
 * snapshot path and refused by the format validator with "Missing manifest".
 * The tab now detects the OUTER envelope of the file, collects the owner inputs
 * and the emailed code, warns BEFORE the first stage that this door replaces the
 * ACTIVE company only, and reports a refusal as ONE inline notice.
 */
const mockLangState = { t: (key: string) => key, language: 'es' };
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector?: (state: typeof mockLangState) => unknown) =>
    selector ? selector(mockLangState) : mockLangState,
}));

const mockAuthState = {
  activeCompany: { id: 'tenant', legalName: 'LQ & OM LLC' },
  user: { id: 'owner-1', email: 'owner@example.test' },
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
const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMocks }));
vi.mock('@/lib/backup-download', () => ({ downloadBackup: vi.fn() }));

import { BackupTab, PORTABLE_RECOVERY_FORMAT, isPortableRecoveryFile } from '@/components/spa/settings/BackupTab';
import { PORTABLE_FORMAT } from '@/lib/backup-portable';

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
  fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).startsWith('/api/backup?')) return respond({ backups: [], unreadable: [] });
    return respond({ stage: 'challenge_sent', expiresAt: '2026-02-01T12:15:00.000Z' });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function choosePortableFile() {
  const input = screen.getByTestId('restore-file-input');
  fireEvent.change(input, {
    target: { files: [new File([PORTABLE_TEXT], 'recovery.json', { type: 'application/json' })] },
  });
}

describe('BackupTab — portable container detection', () => {
  it('pins the client literal to the server format constant', () => {
    expect(PORTABLE_RECOVERY_FORMAT).toBe(PORTABLE_FORMAT);
    expect(isPortableRecoveryFile(PORTABLE_TEXT)).toBe(true);
    expect(isPortableRecoveryFile(JSON.stringify({ manifest: {}, data: {} }))).toBe(false);
    expect(isPortableRecoveryFile('not json')).toBe(false);
  });

  it('shows the owner panel with the pre-stage-1 company notice', async () => {
    render(<BackupTab />);

    choosePortableFile();

    expect(await screen.findByText('settings.backup.portableDetected')).toBeInTheDocument();
    const notice = screen.getByText('settings.backup.portableActiveCompanyNotice', { exact: false });
    expect(notice).toHaveTextContent('LQ & OM LLC');
    // Nothing was sent before the operator confirms the sealed inputs.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('mode=portable'))).toBe(false);
  });
});

describe('BackupTab — portable owner flow (S24)', () => {
  it('sends the file plus the owner inputs to the settings door', async () => {
    render(<BackupTab />);
    choosePortableFile();

    const email = await screen.findByLabelText('settings.backup.portableOwnerEmailLabel');
    expect(email).toHaveValue('owner@example.test');
    const company = screen.getByLabelText('settings.backup.portableCompanyNameLabel');
    expect(company).toHaveValue('LQ & OM LLC');
    fireEvent.change(screen.getByLabelText('settings.backup.portableOwnerPasswordLabel'), {
      target: { value: 'clave-propietario-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.backup.portableSendCode' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) =>
        String(url) === '/api/backup/restore?mode=portable&door=settings&companyId=tenant')).toBe(true);
    });
    const [, init] = fetchMock.mock.calls.find(([url]) =>
      String(url) === '/api/backup/restore?mode=portable&door=settings&companyId=tenant')!;
    const form = (init as RequestInit).body as FormData;
    expect(form.get('ownerEmail')).toBe('owner@example.test');
    expect(form.get('companyName')).toBe('LQ & OM LLC');
    expect(form.get('password')).toBe('clave-propietario-1');
    expect(form.get('token')).toBeNull();
    expect(form.get('file')).toBeInstanceOf(File);

    // Stage 2 asks for the emailed code.
    expect(await screen.findByLabelText('settings.backup.portableCodeLabel')).toBeInTheDocument();
    expect(screen.getByText('settings.backup.portableCodeSent')).toBeInTheDocument();
  });

  it('reports a company mismatch as ONE inline notice, naming the situation', async () => {
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('/api/backup?')) return respond({ backups: [], unreadable: [] });
      return respond({ error: 'different company', code: 'RECOVERY_ACTIVE_COMPANY_MISMATCH' }, false);
    });
    render(<BackupTab />);
    choosePortableFile();

    fireEvent.change(await screen.findByLabelText('settings.backup.portableOwnerPasswordLabel'), {
      target: { value: 'clave-propietario-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.backup.portableSendCode' }));

    const notices = await screen.findAllByRole('alert');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toHaveTextContent('settings.backup.portableActiveCompanyMismatch');
    // Single notice: no toast repeats the same refusal, and no code was requested.
    expect(toastMocks.error).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('settings.backup.portableCodeLabel')).not.toBeInTheDocument();
  });

  it('keeps the internal snapshot path untouched for a non-portable file', async () => {
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('/api/backup?')) return respond({ backups: [], unreadable: [] });
      return respond({ restoredCounts: { company: 1 } });
    });
    render(<BackupTab />);

    fireEvent.change(screen.getByTestId('restore-file-input'), {
      target: { files: [new File([JSON.stringify({ manifest: {}, data: {} })], 'interno.json')] },
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/backup/restore')).toBe(true);
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('mode=portable'))).toBe(false);
    expect(screen.queryByText('settings.backup.portableDetected')).not.toBeInTheDocument();
  });
});

describe('backup history row tooltip', () => {
  it('states the company once, plus who created it, when, and where it is stored', async () => {
    const createdAt = '2026-11-09T21:03:22.000Z';
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('/api/backup?')) {
        return respond({
          backups: [{
            id: 'b1', filename: 'tenant_1.json', size: 32768, createdAt,
            companyInfo: { id: 'tenant', legalName: 'LQ & OM LLC' },
            destination: 'C:\instalacion\db\backups',
            createdBy: 'user-1',
            createdByName: 'Ana Perez',
            recordCounts: { company: 1 },
          }],
          unreadable: [],
        });
      }
      return respond({});
    });

    render(<BackupTab />);
    const row = await screen.findByLabelText(/settings.backup.tooltipCompany/);
    const summary = row.getAttribute('aria-label') ?? '';

    // The three facts the row must name.
    expect(summary).toContain('settings.backup.tooltipCompany: LQ & OM LLC');
    expect(summary).toContain('settings.backup.tooltipCreatedBy: Ana Perez');
    expect(summary).toContain('C:\instalacion\db\backups');
    // Exact time, seconds included, so two backups of the same minute differ.
    expect(summary).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    // The company is named ONCE: the duplicated line was the reported defect.
    expect(summary.split('LQ & OM LLC')).toHaveLength(2);
  });

  it('says the creator is unavailable instead of inventing one', async () => {
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).startsWith('/api/backup?')) {
        return respond({
          backups: [{
            id: 'b2', filename: 'tenant_2.json', size: 1024, createdAt: '2026-11-09T20:00:00.000Z',
            companyInfo: { id: 'tenant', legalName: 'LQ & OM LLC' },
            recordCounts: { company: 1 },
          }],
          unreadable: [],
        });
      }
      return respond({});
    });

    render(<BackupTab />);
    const row = await screen.findByLabelText(/settings.backup.tooltipCompany/);
    const summary = row.getAttribute('aria-label') ?? '';
    expect(summary).toContain('settings.backup.tooltipCreatedBy: settings.backup.tooltipCreatedByUnknown');
    expect(summary).toContain('settings.backup.tooltipWhere: settings.backup.tooltipWhereUnknown');
  });
});
