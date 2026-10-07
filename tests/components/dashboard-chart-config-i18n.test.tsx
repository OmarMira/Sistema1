// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import { balanceChartConfig, cashFlowChartConfig } from '@/components/dashboard/DashboardPageBlocks';
import { useLanguageStore } from '@/store/language-store';

// Both chart configs live on the same dashboard page: labels must follow the
// active language instead of one config being English and the other Spanish.
describe('dashboard chart config localization', () => {
  afterEach(() => {
    useLanguageStore.getState().setLanguage('es');
  });

  it('uses Spanish labels for both configs when the language is es', () => {
    const t = useLanguageStore.getState().t;

    expect(balanceChartConfig(t).asset?.label).toBe('Activos');
    expect(balanceChartConfig(t).liability?.label).toBe('Pasivos');
    expect(balanceChartConfig(t).revenue?.label).toBe('Ingresos');
    expect(cashFlowChartConfig(t).income?.label).toBe('Ingresos');
    expect(cashFlowChartConfig(t).expenses?.label).toBe('Gastos');
  });

  it('uses English labels for both configs when the language is en', () => {
    useLanguageStore.getState().setLanguage('en');
    const t = useLanguageStore.getState().t;

    expect(balanceChartConfig(t).asset?.label).toBe('Assets');
    expect(balanceChartConfig(t).liability?.label).toBe('Liabilities');
    expect(cashFlowChartConfig(t).income?.label).toBe('Income');
    expect(cashFlowChartConfig(t).expenses?.label).toBe('Expenses');
  });
});
