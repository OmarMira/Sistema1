// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

/**
 * S23g — app-level error boundaries.
 *
 * The route boundary renders before the language store rehydrates, so it must
 * be i18n-neutral: plain, readable copy in both languages, no translation keys
 * (a raw key reaching the user is exactly what S23g forbids), and a working
 * reset handler.
 */

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import AppError from '@/app/error';
import GlobalError from '@/app/global-error';
import { logger } from '@/lib/logger';

afterEach(() => cleanup());

describe('S23g — src/app/error.tsx', () => {
  it('renders human copy (no raw i18n keys) and resets on demand', () => {
    const reset = vi.fn();
    const error = Object.assign(new Error('boom'), { digest: 'abc123' });

    render(<AppError error={error} reset={reset} />);

    expect(screen.getByText(/Algo salió mal/)).toBeInTheDocument();
    expect(screen.getByText(/Something went wrong/)).toBeInTheDocument();
    // No dotted translation key leaked into the DOM.
    expect(document.body.textContent).not.toMatch(/\b[a-z][a-zA-Z]*(\.[a-zA-Z]+){2,}\b/);

    fireEvent.click(screen.getByRole('button', { name: /Reintentar · Try again/ }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('logs the captured error with its digest', () => {
    render(<AppError error={Object.assign(new Error('boom'), { digest: 'digest-1' })} reset={vi.fn()} />);

    expect(logger.error).toHaveBeenCalledWith(
      'Route error boundary caught an error:',
      expect.objectContaining({ digest: 'digest-1' }),
    );
  });
});

describe('S23g — src/app/global-error.tsx', () => {
  it('renders a full document with a working reset handler', () => {
    const reset = vi.fn();

    render(<GlobalError error={new Error('root boom')} reset={reset} />);

    expect(screen.getByText(/Ocurrió un error inesperado/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b[a-z][a-zA-Z]*(\.[a-zA-Z]+){2,}\b/);

    fireEvent.click(screen.getByRole('button', { name: /Reintentar/ }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
