// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { translations, getTranslation, type Locale } from '@/lib/i18n';

let locale: Locale = 'es';
const hydrate = vi.fn().mockResolvedValue(undefined);
const request = vi.fn();
vi.mock('@/store/auth-store', () => ({
  useAuthStore: () => ({ activeCompany: { id: 'demo-company', legalName: 'Demo Shop' }, hydrate }),
}));
vi.mock('@/store/language-store', () => ({
  useLanguageStore: (selector: (state: unknown) => unknown) => selector({
    t: (key: string) => getTranslation(translations[locale], key, key),
  }),
}));
vi.mock('framer-motion', () => ({
  motion: { div: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
}));
// Keep tests on the wizard's public form and request contract, without Radix layout APIs.
vi.mock('@/components/ui/select', () => ({
  Select: ({ children, value, onValueChange }: { children: ReactNode; value: string; onValueChange: (value: string) => void }) =>
    <select value={value} onChange={event => onValueChange(event.target.value)}>{children}</select>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => children,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => <option value={value}>{children}</option>,
}));
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard';

function control(id: string) {
  const field = document.getElementById(id);
  expect(field, id).not.toBeNull();
  return field!;
}
function next() { fireEvent.click(control('onboarding-next-btn')); }
function fiscal() {
  next();
  fireEvent.change(control('onboarding-fiscalStartYear'), { target: { value: '2026' } });
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '3' } });
}
function finishScreen() { fiscal(); next(); next(); next(); }

beforeEach(() => {
  vi.useFakeTimers(); locale = 'es'; vi.clearAllMocks();
  hydrate.mockResolvedValue(undefined);
  request.mockImplementation(() => { throw new Error('Unexpected request'); });
  vi.stubGlobal('fetch', request);
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Onboarding without a company-wide opening balance', () => {
  it.each(['es', 'en'] as const)('removes the balance step and explains per-account statement balances (%s)', language => {
    locale = language; render(<OnboardingWizard />);
    expect(screen.getByText(language === 'es' ? 'Paso 1 / 5' : 'Step 1 / 5')).toBeInTheDocument();
    finishScreen();
    expect(control('onboarding-complete-btn')).toBeInTheDocument();
    expect(document.querySelector('#onboarding-initialCashBalance')).toBeNull();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByText(language === 'es' ? /No necesitás buscar tus saldos ahora/ : /No need to look up your balances now/)).toBeInTheDocument();
    expect(screen.getByText(language === 'es' ? /cada cuenta bancaria/ : /each bank account/)).toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(control('onboarding-back-btn'));
    expect(document.querySelector('#onboarding-initialCashBalance')).toBeNull();
    next(); expect(control('onboarding-complete-btn')).toBeInTheDocument();
  });

  it('preserves fiscal validation and back navigation without making requests', () => {
    render(<OnboardingWizard />); next(); next();
    expect(screen.getByText('El año y el mes de inicio fiscal son obligatorios.')).toBeInTheDocument();
    expect(control('onboarding-fiscalStartYear')).toBeInTheDocument();
    fireEvent.change(control('onboarding-fiscalStartYear'), { target: { value: '2026' } });
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '3' } }); next();
    fireEvent.click(control('onboarding-back-btn'));
    expect(control('onboarding-fiscalStartYear')).toHaveValue(2026);
    expect(screen.getAllByRole('combobox')[0]).toHaveValue('3');
    expect(request).not.toHaveBeenCalled();
  });

  it('submits existing setup fields without an opening balance and hydrates only on success', async () => {
    request.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    render(<OnboardingWizard />); finishScreen();
    await act(async () => { fireEvent.click(control('onboarding-complete-btn')); });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0];
    expect(url).toBe('/api/onboarding/complete'); expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({
      companyId: 'demo-company', legalName: 'Demo Shop', currency: 'USD',
      fiscalYearStartMonth: 3, fiscalYearStartYear: 2026, periodType: 'CALENDAR',
    });
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it('retains setup choices and the retry button after a failed completion', async () => {
    request.mockResolvedValue({ ok: false, json: async () => ({ error: 'Demo failure' }) });
    render(<OnboardingWizard />); finishScreen();
    await act(async () => { fireEvent.click(control('onboarding-complete-btn')); });
    expect(screen.getByText('Demo failure')).toBeInTheDocument();
    expect(control('onboarding-complete-btn')).not.toBeDisabled();
    expect(hydrate).not.toHaveBeenCalled();
    expect(JSON.parse(request.mock.calls[0][1].body)).not.toHaveProperty('initialCashBalance');
  });
});
