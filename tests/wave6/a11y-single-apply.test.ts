// @vitest-environment jsdom
/**
 * Wave 6 — T6 (S11) + T7 (S9).
 *
 * S11 — a11y sweep of the app shell and the dashboard. The spec's scope is
 *       aria/label correctness for the interactive elements the operator
 *       actually meets: named icon-only controls, table headers scoped to their
 *       column, dialogs that announce themselves, live/status regions for
 *       loading and failure, and keyboard-reachable "card acts as button"
 *       targets. Colour contrast and keyboard-only navigation flows are
 *       explicitly OUT of scope (spec S11).
 *
 *       Every assertion below goes through the public interface a screen reader
 *       sees (roles, computed accessible names, live-region attributes) and not
 *       through internal component state.
 *
 *       NOTE — this file is `.ts` (per the task's exact path), so element trees
 *       are built with `createElement` instead of JSX.
 *
 * S9 — single-apply CONFIRM consistency is NOT implemented, by decision.
 *      Single-rule apply (`POST /api/bank-rules/[id] { action: 'apply' }`) is
 *      classification-only per ADR-013 and that contract is pinned by
 *      tests/integration/bre013-classification-rollback-49.test.ts ("creates a
 *      durable record without journal; journalEntryId stays null"). The apply-all
 *      CONFIRM draft path is the review mechanism for batch operations; single-rule
 *      apply deliberately creates no journal entry, so there is no silent posting
 *      to convert into a draft. S9 is closed as a documented design decision (same
 *      pattern as the S10 non-goals) — do NOT add journal-entry creation here.
 */
import '@testing-library/jest-dom/vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import {
  AdminStatCards,
  RecentTransactionsTable,
} from '@/components/dashboard/DashboardPageBlocks';
import { HelpModal } from '@/components/dashboard/DashboardBlocks';
import { LoadingState } from '@/components/dashboard/DashboardStates';
import { FinancialDashboard } from '@/components/dashboard/FinancialDashboard';
import { AppShell } from '@/components/spa/AppShell';
import { SidebarNav } from '@/components/app/SidebarNav';
import { DesktopNavItems } from '@/components/app/DesktopNavItems';

// ─── Shared fixtures ────────────────────────────────────────────────────────

const t = (key: string) => key;

/** Dotted-key translator over a locale catalog (same shape as the store). */
function translator(dt: Record<string, string>): Record<string, string> {
  return new Proxy(dt, { get: (target, key) => target[String(key)] ?? String(key) });
}

const transactions = [
  {
    id: 'tx-1',
    date: '2025-06-15',
    description: 'Proveedor ACME',
    amount: -1200.5,
    glAccount: { name: 'Gastos generales' },
    isReconciled: true,
  },
];

const helpDialogText = translator({
  requiredFileStructure: 'Estructura requerida',
  supportedFormatHelpDesc: 'Formato soportado',
  columnHeader: 'Columna',
  typeHeader: 'Tipo',
  descriptionHeader: 'Descripción',
  supportedFormatHelpFootnote: 'Nota',
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useLanguageStore.getState().setLanguage('es');
});

// ─── S11: dashboard tables ─────────────────────────────────────────────────

describe('S11 — dashboard tables expose their column structure', () => {
  it('marks every recent-transactions header as a scoped column header', () => {
    render(createElement(RecentTransactionsTable, { t, loading: false, transactions }));

    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(4);
    for (const header of headers) {
      expect(header).toHaveAttribute('scope', 'col');
    }
  });

  it('scopes the file-structure table headers of the help dialog', () => {
    render(
      createElement(HelpModal, {
        open: true,
        language: 'es',
        dt: helpDialogText,
        onClose: () => {},
      }),
    );

    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(3);
    for (const header of headers) {
      expect(header).toHaveAttribute('scope', 'col');
    }
  });
});

// ─── S11: dialogs ──────────────────────────────────────────────────────────

describe('S11 — the help overlay announces itself as a dialog', () => {
  it('is a modal dialog with an accessible name taken from its heading', () => {
    render(
      createElement(HelpModal, {
        open: true,
        language: 'es',
        dt: helpDialogText,
        onClose: () => {},
      }),
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Estructura requerida');
  });

  it('gives the icon-only close control a real accessible name', () => {
    const onClose = vi.fn();
    render(
      createElement(HelpModal, {
        open: true,
        language: 'es',
        dt: helpDialogText,
        onClose,
      }),
    );

    const close = screen.getByRole('button', { name: /cerrar|close/i });
    // The accessible name is the label, never the bare "×" glyph on screen.
    expect(close).toHaveAccessibleName('Cerrar ayuda');
    expect(close).not.toHaveAccessibleName('×');

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ─── S11: live regions ─────────────────────────────────────────────────────

describe('S11 — loading and failure are announced', () => {
  it('exposes the loading state as a polite live status region', () => {
    render(createElement(LoadingState, { mounted: true, loadingText: 'Cargando movimientos' }));

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Cargando movimientos');
  });

  it('exposes the financial dashboard loading state as a status region', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})) as unknown as typeof fetch,
    );

    render(createElement(FinancialDashboard, { companyId: 'company-1' }));

    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('exposes a financial dashboard failure as an alert', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) } as unknown as Response),
    );

    render(createElement(FinancialDashboard, { companyId: 'company-1' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/error/i);
  });
});

// ─── S11: cards that behave as buttons ─────────────────────────────────────

describe('S11 — cards that act as buttons are reachable and named', () => {
  it('exposes each clickable admin stat card as a keyboard-activatable button', () => {
    const onNavigate = vi.fn();

    render(
      createElement(AdminStatCards, {
        t: (key: string) => key,
        loading: false,
        stats: { companiesCount: 2, usersCount: 3, logsCount: 4, systemLoad: null },
        onNavigate,
      }),
    );

    const cards = screen.getAllByRole('button');
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card).toHaveAttribute('tabindex', '0');
      expect(card).toHaveAccessibleName(/\w/);
    }

    fireEvent.keyDown(cards[0], { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('admin-companies');

    fireEvent.keyDown(cards[1], { key: ' ' });
    expect(onNavigate).toHaveBeenCalledWith('admin-users');
  });
});

// ─── S11: app shell ────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));

vi.mock('@/components/spa/AIAssistantModal', () => ({ AIAssistantModal: () => null }));
vi.mock('@/components/spa/LanguageSelector', () => ({ LanguageSelector: () => null }));
vi.mock('@/components/spa/ThemeToggle', () => ({ ThemeToggle: () => null }));

/** React Query provider for the components that read nav entitlements. */
function withQueryClient(node: ReactNode): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, node);
}

const ENTITLEMENTS = [
  { moduleKey: 'accounting', enabled: true },
  { moduleKey: 'banking', enabled: true },
];

function stubEntitlements(companyId = 'company-1') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ companyId, entitlements: ENTITLEMENTS }),
      }) as unknown as Response,
    ) as unknown as typeof fetch,
  );
}

const shell: ReactElement = createElement(AppShell);
const renderShell = () => render(withQueryClient(shell));

describe('S11 — app shell landmarks and icon-only controls', () => {
  beforeEach(() => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        email: 'owner@example.com',
        firstName: 'Omar',
        lastName: 'Mira',
      } as never,
      activeCompany: null,
      currentView: 'dashboard',
      sidebarOpen: true,
      isProcessing: false,
    });
  });

  it('offers a skip link that targets the main content region', () => {
    renderShell();

    const skip = screen.getByRole('link', { name: /contenido principal|main content/i });
    expect(skip).toHaveAttribute('href', '#main-content');

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
  });

  it('names the icon-only navigation trigger and the avatar menu trigger', () => {
    renderShell();

    expect(screen.getByRole('button', { name: /abrir men|open navigation/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /menú de usuario|user menu/i })).toBeInTheDocument();
  });

  it('renders the sidebar as a labelled navigation landmark', () => {
    renderShell();

    expect(screen.getByRole('navigation', { name: 'Navegación principal' })).toBeInTheDocument();
  });

  it('marks the current view in the sidebar navigation with aria-current=page', async () => {
    const t = useLanguageStore.getState().t;
    useAuthStore.setState({
      activeCompany: {
        id: 'company-1',
        legalName: 'Company One',
        taxId: null,
        isOnboardingComplete: true,
      } as never,
      currentView: 'dashboard',
    });
    stubEntitlements('company-1');

    render(withQueryClient(shell));

    const nav = screen.getByRole('navigation', { name: 'Navegación principal' });
    const current = await within(nav).findByRole('button', { name: t('dashboard.title') });
    expect(current).toHaveAttribute('aria-current', 'page');

    const other = await within(nav).findByRole('button', { name: t('journal.title') });
    expect(other).not.toHaveAttribute('aria-current');
  });

  it('announces the global processing overlay as a live status region', () => {
    useAuthStore.setState({ isProcessing: true, processingMessage: 'Procesando...' });

    renderShell();

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });
});

// ─── S11: sidebar navigation (mobile drawer + collapsed desktop rail) ──────

describe('S11 — sidebar navigation exposes the current page', () => {
  beforeEach(() => {
    const t = useLanguageStore.getState().t;
    void t;
    useAuthStore.setState({
      user: null as never,
      activeCompany: {
        id: 'company-1',
        legalName: 'Company One',
        taxId: null,
        isOnboardingComplete: true,
      } as never,
      currentView: 'dashboard',
      sidebarOpen: true,
      isProcessing: false,
    });
    stubEntitlements('company-1');
  });

  it('labels the mobile drawer nav and marks only the active item as the current page', async () => {
    const t = useLanguageStore.getState().t;

    render(withQueryClient(createElement(SidebarNav, {})));

    const nav = screen.getByRole('navigation', { name: 'Navegación principal' });
    const current = await within(nav).findByRole('button', { name: t('dashboard.title') });
    expect(current).toHaveAttribute('aria-current', 'page');

    const other = await within(nav).findByRole('button', { name: t('journal.title') });
    expect(other).not.toHaveAttribute('aria-current');
  });

  it('gives every collapsed desktop rail item an accessible name', async () => {
    const t = useLanguageStore.getState().t;

    render(withQueryClient(createElement(DesktopNavItems, { collapsed: true })));

    const items = await screen.findAllByRole('button');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item).toHaveAccessibleName(/\w/);
    }

    const current = await screen.findByRole('button', { name: t('dashboard.title') });
    expect(current).toHaveAttribute('aria-current', 'page');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: t('journal.title') })).not.toHaveAttribute(
        'aria-current',
      );
    });
  });
});
