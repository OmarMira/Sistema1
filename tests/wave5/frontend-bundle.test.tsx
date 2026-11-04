// @vitest-environment jsdom
/**
 * S7 (Wave 5) — frontend bundle. This file pins the four behaviours T6 owns:
 *
 *  (1) auth-store revalidates the PERSISTED activeCompany / adminSelectedCompanyId
 *      against the company list returned by /api/auth/me on hydration. The server
 *      stays the authority: a company the user no longer owns is cleared (never
 *      silently trusted), a valid one is refreshed with no visible change, and an
 *      unauthenticated response leaves the store untouched.
 *  (2) the InstallationWizard copy lives in the shared i18n locales
 *      (`installation.*`) with byte-identical Spanish/English wording, and the
 *      component renders whatever locale the language store currently holds —
 *      including the pre-hydration default (es) — without leaking raw keys.
 *  (3) OnboardingWizard / InstallationWizard labels point at their controls
 *      (`label[for]` ↔ element `id`), the same useId/aria pattern the password
 *      fields already follow.
 *  (4) the remaining hardcoded Spanish strings in ReportExportModal,
 *      BudgetVarianceReport and FiscalPeriodsTab are routed through t() with new
 *      keys present in BOTH locales (parity: one language can never silently miss
 *      a key).
 */
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

import es from '@/i18n/locales/es';
import en from '@/i18n/locales/en';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore, type Company, type User } from '@/store/auth-store';
import { InstallationWizard } from '@/components/onboarding/InstallationWizard';
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard';

// The wizard styles live in a CSS module; jsdom does not need the stylesheet and the
// Vite CSS pipeline is not part of what this file verifies.
vi.mock('@/components/onboarding/InstallationWizard.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}));
vi.mock('@/components/spa/ThemeToggle', () => ({
  ThemeToggle: () => <button type="button">theme</button>,
}));
vi.mock('@/components/spa/LanguageSelector', () => ({
  LanguageSelector: () => <span>language</span>,
}));
vi.mock('framer-motion', () => ({
  motion: { div: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
}));
// Radix Select needs layout APIs jsdom does not provide; the wizard contract under
// test is the label/control association, so the trigger keeps its own props.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));

function resolve(dictionary: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dictionary);
}

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ─── (2) + (4) locale parity and wording ─────────────────────────────

/**
 * The exact Spanish wording the InstallationWizard used to carry inline. The
 * relocation into the locales must not rephrase a single character.
 */
const INSTALLATION_ES: Record<string, string> = {
  title: 'Asistente de instalación',
  intro: 'Un paso a la vez, sin conocimientos técnicos.',
  'steps.welcome': 'Bienvenida',
  'steps.business': 'Tus datos',
  'steps.accounting': 'Inicio contable',
  'steps.email': 'Correo',
  'steps.review': 'Revisión',
  welcome: 'Todo comienza por acá',
  welcomeBody:
    'Vamos a preparar tu empresa y confirmar tu correo antes de crear el acceso al sistema.',
  local:
    'La aplicación y tus datos contables quedan en esta PC. Solo la confirmación y recuperación de acceso utilizan el servicio de correo.',
  business: 'Nombre legal de tu empresa',
  currency: 'Moneda de trabajo',
  bank: 'Los saldos bancarios se incorporan al importar cada estado de cuenta. No se interpreta un saldo faltante como cero.',
  fiscal: '¿Cuándo empieza tu ejercicio contable?',
  year: 'Año de inicio del ejercicio',
  month: 'Mes de inicio del ejercicio',
  period: 'Tipo de período contable',
  calendar: 'Calendario natural',
  custom: 'Meses personalizados',
  weeks: 'Semanas 52/53',
  admin: 'Tu acceso al sistema',
  first: 'Nombre',
  last: 'Apellido',
  email: 'Correo electrónico',
  password: 'Contraseña',
  confirm: 'Confirmar contraseña',
  passwordHelp: 'Usá al menos 8 caracteres. La contraseña no se guarda en este navegador.',
  review: 'Revisá tus datos',
  before:
    'Primero confirmaremos el correo. La empresa y el acceso se crearán solo cuando se acepte el código.',
  code: 'Código de verificación',
  delivered: 'El servicio aceptó el envío. Revisá tu bandeja de entrada y correo no deseado.',
  mailFailed:
    'No se pudo enviar el correo. Revisá la configuración de correo antes de reintentar.',
  resendNote: 'Se solicitó un nuevo código. Esto no confirma que el correo haya llegado.',
  start: 'Comenzar',
  next: 'Continuar',
  back: 'Volver',
  reviewButton: 'Revisar',
  send: 'Enviar código',
  verify: 'Verificar y completar',
  resend: 'Solicitar otro código',
  retry: 'Reintentar configuración',
  busy: 'Procesando…',
  error: 'No se pudo completar la operación. Revisá los datos e intentá nuevamente.',
  showPassword: 'Mostrar contraseña',
  hidePassword: 'Ocultar contraseña',
  showConfirmation: 'Mostrar confirmación de contraseña',
  hideConfirmation: 'Ocultar confirmación de contraseña',
  mismatch: 'Las contraseñas no coinciden.',
  complete: 'Configuración completada',
  ready: 'Los datos guardados fueron confirmados por el sistema.',
};

/** Keys added by this task outside the installation namespace. */
const ADDED_KEYS = [
  'reports.exportModalDescription',
  'reports.reportType',
  'reports.reportTypePlaceholder',
  'reports.incomeStatementPL',
  'reports.format',
  'reports.formatPlaceholder',
  'reports.formatCsv',
  'reports.formatPrint',
  'reports.internalUseOnly',
  'reports.draftDisclaimer',
  'reports.exporting',
  'reports.exportReport',
  'budget.varianceTitle',
  'budget.budgetLabel',
  'budget.actualLabel',
  'budget.varianceLabel',
  'settings.periods.closingAccountPlaceholder',
  'settings.periods.periodNamePlaceholder',
  'settings.periods.lockWarning',
];

describe('S7 (2) — installation copy lives in the i18n locales', () => {
  it('keeps the Spanish wording byte-identical to the retired inline copy', () => {
    for (const [key, expected] of Object.entries(INSTALLATION_ES)) {
      expect(resolve(es, `installation.${key}`), `installation.${key}`).toBe(expected);
    }
  });

  it('has the exact same installation.* key shape in both locales (no silent gap)', () => {
    expect(flattenKeys(es.installation).sort()).toEqual(flattenKeys(en.installation).sort());
  });

  it('never ships an empty or copied-over string in either locale', () => {
    for (const locale of [es, en] as const) {
      for (const key of flattenKeys(locale.installation)) {
        const value = resolve(locale, `installation.${key}`);
        expect(typeof value, `installation.${key}`).toBe('string');
        expect((value as string).trim().length, `installation.${key}`).toBeGreaterThan(0);
      }
    }
    // The English side must actually be English, not a duplicate of the Spanish.
    expect(en.installation.title).toBe('Installation assistant');
    expect(en.installation.start).toBe('Start');
    expect(en.installation.mismatch).toBe('Passwords do not match.');
    expect(en.installation.showPassword).toBe('Show password');
  });
});

describe('S7 (4) — hardcoded Spanish is routed through t()', () => {
  it.each(ADDED_KEYS)('%s resolves to a non-empty string in es and en', (key) => {
    for (const locale of [es, en] as const) {
      const value = resolve(locale, key);
      expect(typeof value, `${key} [${locale === es ? 'es' : 'en'}]`).toBe('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the original Spanish wording for the moved strings', () => {
    expect(es.reports.reportType).toBe('Reporte');
    expect(es.reports.reportTypePlaceholder).toBe('Seleccionar reporte');
    expect(es.reports.incomeStatementPL).toBe('Estado de Resultados (P&L)');
    expect(es.reports.format).toBe('Formato');
    expect(es.reports.formatPlaceholder).toBe('Seleccionar formato');
    expect(es.reports.formatCsv).toBe('CSV (Con hash SHA-256)');
    expect(es.reports.formatPrint).toBe('Imprimir / Guardar como PDF');
    expect(es.reports.internalUseOnly).toBe('USO INTERNO ÚNICAMENTE');
    expect(es.reports.exporting).toBe('Exportando...');
    expect(es.reports.exportReport).toBe('Exportar Reporte');
    expect(es.budget.varianceTitle).toBe('Análisis de Varianza: {period}');
    expect(es.budget.budgetLabel).toBe('Presupuesto');
    expect(es.budget.actualLabel).toBe('Real');
    expect(es.budget.varianceLabel).toBe('Varianza');
    expect(es.settings.periods.closingAccountPlaceholder).toBe('Ej. 3000');
    expect(es.settings.periods.periodNamePlaceholder).toBe('Ej., Enero 2025');
    expect(es.settings.periods.lockWarning).toBe(
      'ADVERTENCIA: Esta acción es irreversible. No se podrá volver a abrir este período.',
    );
  });

  it('no longer carries the Spanish literals inline in the components', () => {
    const files: Array<[string, string[]]> = [
      [
        'src/components/reports/ReportExportModal.tsx',
        ['USO INTERNO ÚNICAMENTE', 'Exportar Reporte', 'Seleccionar formato'],
      ],
      [
        'src/components/budget/BudgetVarianceReport.tsx',
        ['Análisis de Varianza', 'Presupuesto', 'Varianza'],
      ],
      [
        'src/components/spa/settings/FiscalPeriodsTab.tsx',
        ['Ej. 3000', 'Ej., Enero 2025', 'No se podrá volver a abrir este período'],
      ],
    ];
    for (const [file, literals] of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      for (const literal of literals) expect(source, `${file}: ${literal}`).not.toContain(literal);
    }
  });
});

describe('S7 (2) — InstallationWizard renders the copy for the selected locale', () => {
  beforeEach(() => {
    act(() => useLanguageStore.getState().setLanguage('es'));
  });

  it('uses Spanish before/without hydration (the pre-hydration default)', () => {
    render(<InstallationWizard onBack={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Asistente de instalación' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comenzar' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('installation.');
  });

  it('follows the language store when the locale changes', () => {
    render(<InstallationWizard onBack={() => {}} />);
    act(() => useLanguageStore.getState().setLanguage('en'));
    expect(screen.getByRole('heading', { name: 'Installation assistant' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    act(() => useLanguageStore.getState().setLanguage('es'));
    expect(screen.getByRole('button', { name: 'Comenzar' })).toBeInTheDocument();
  });
});

// ─── (3) a11y label associations ─────────────────────────────────────

function expectEveryLabelToResolve(context: string) {
  const labels = Array.from(document.querySelectorAll('label[for]'));
  expect(labels.length, `${context}: no label[for] rendered`).toBeGreaterThan(0);
  for (const label of labels) {
    const target = label.getAttribute('for') as string;
    expect(document.getElementById(target), `${context}: label[for="${target}"]`).not.toBeNull();
  }
}

describe('S7 (3) — onboarding labels point at their controls', () => {
  it('links every OnboardingWizard label to an element id', () => {
    render(<OnboardingWizard />);
    expectEveryLabelToResolve('OnboardingWizard step 1');
    const legalNameLabel = document.querySelector('label[for="onboarding-legalName"]');
    expect(legalNameLabel).not.toBeNull();
    expect(legalNameLabel?.textContent).toContain('Nombre Legal de la Empresa');
    expect(document.getElementById('onboarding-currency')).not.toBeNull();
  });

  it('links InstallationWizard labels on the data and access steps', () => {
    render(<InstallationWizard onBack={() => {}} />);
    // Step 0 (welcome) has no fields; step 1 is the business data step.
    act(() => {
      screen.getByRole('button', { name: 'Comenzar' }).click();
    });
    expectEveryLabelToResolve('InstallationWizard step 1');
    expect(document.getElementById('installation-business')).not.toBeNull();
    act(() => {
      screen.getByRole('button', { name: 'Continuar' }).click();
    });
    expectEveryLabelToResolve('InstallationWizard step 2');
    act(() => {
      screen.getByRole('button', { name: 'Continuar' }).click();
    });
    expectEveryLabelToResolve('InstallationWizard step 3');
    expectEveryLabelToResolve('InstallationWizard step 3');
  });
});

// ─── (1) auth-store revalidation on hydration ────────────────────────

const SERVER_USER: User = {
  id: 'user-1',
  email: 'ana@example.com',
  firstName: 'Ana',
  lastName: 'Perez',
  role: 'user',
};

function company(id: string, legalName: string): Company {
  return { id, legalName, taxId: null, isOnboardingComplete: true, role: 'company_admin' };
}

function stubMe(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('S7 (1) — hydration keeps the server as the company authority', () => {
  beforeEach(() => {
    useLanguageStore.getState().setLanguage('es');
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      activeCompany: null,
      currentView: 'landing',
      adminSelectedCompanyId: null,
    });
  });

  it('clears a persisted active company the server no longer grants', async () => {
    useAuthStore.setState({
      activeCompany: company('company-deleted', 'Old Company'),
      adminSelectedCompanyId: 'company-deleted',
      currentView: 'dashboard',
    });
    stubMe({ user: SERVER_USER, companies: [company('company-owned', 'Owned Company')] });

    await act(async () => {
      await useAuthStore.getState().hydrate();
    });

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.activeCompany).toBeNull();
    expect(state.adminSelectedCompanyId).toBeNull();
    expect(state.currentView).toBe('select-company');
  });

  it('keeps a valid company, refreshing it from the server with no visible change', async () => {
    useAuthStore.setState({
      activeCompany: { ...company('company-owned', 'Stale Legal Name'), isOnboardingComplete: false },
      adminSelectedCompanyId: 'company-owned',
      currentView: 'dashboard',
    });
    stubMe({ user: SERVER_USER, companies: [company('company-owned', 'Owned Company')] });

    await act(async () => {
      await useAuthStore.getState().hydrate();
    });

    const state = useAuthStore.getState();
    expect(state.activeCompany?.id).toBe('company-owned');
    expect(state.activeCompany?.legalName).toBe('Owned Company');
    expect(state.adminSelectedCompanyId).toBe('company-owned');
    expect(state.currentView).toBe('dashboard');
  });

  it('leaves the store untouched when the session is not authenticated', async () => {
    const persisted = { ...company('company-owned', 'Owned Company') };
    useAuthStore.setState({
      activeCompany: persisted,
      adminSelectedCompanyId: 'company-owned',
      currentView: 'dashboard',
    });
    stubMe({ error: 'Unauthorized' }, false);

    await act(async () => {
      await useAuthStore.getState().hydrate();
    });

    const state = useAuthStore.getState();
    expect(state.activeCompany?.id).toBe('company-owned');
    expect(state.adminSelectedCompanyId).toBe('company-owned');
    expect(state.currentView).toBe('dashboard');
    expect(state.isAuthenticated).toBe(false);
  });
});
