// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ReportExportModal } from '@/components/reports/ReportExportModal';

afterEach(cleanup);

function currentUtcMonthRange() {
  const now = new Date();
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10),
    end: now.toISOString().slice(0, 10),
  };
}

describe('ReportExportModal default export window', () => {
  it('opens on the current UTC calendar month instead of a hardcoded 2025 window', () => {
    render(<ReportExportModal isOpen onClose={() => {}} companyId="c1" />);

    const { start, end } = currentUtcMonthRange();
    expect(screen.getByLabelText('Desde')).toHaveValue(start);
    expect(screen.getByLabelText('Hasta')).toHaveValue(end);

    // Guard against the dead 5-month 2025 window coming back.
    expect(start).not.toBe('2025-01-01');
    expect(end).not.toBe('2025-05-31');
    expect(start.slice(0, 7)).toBe(end.slice(0, 7));
  });

  it('renders the localized modal title instead of the hardcoded literal', () => {
    render(<ReportExportModal isOpen onClose={() => {}} companyId="c1" />);

    expect(screen.getByText('Exportar Reportes Financieros')).toBeInTheDocument();
  });
});
