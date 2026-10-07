// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ViewErrorBoundary } from '@/components/app/ViewErrorBoundary';
import { useLanguageStore } from '@/store/language-store';

let shouldThrow = false;

function Bomb() {
  if (shouldThrow) {
    throw new Error('view render exploded');
  }
  return <div data-testid="view-ok">view content</div>;
}

describe('ViewErrorBoundary — keeps the rest of the shell alive', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    shouldThrow = true;
    useLanguageStore.getState().setLanguage('es');
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders the fallback with the i18n copy and recovers when retry succeeds', () => {
    render(
      <ViewErrorBoundary>
        <Bomb />
      </ViewErrorBoundary>,
    );

    expect(screen.getByText('Error al mostrar esta vista')).toBeInTheDocument();
    expect(
      screen.getByText('Ocurrió un fallo al renderizar. Los demás módulos siguen operativos.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('view-ok')).toBeNull();

    expect(
      consoleErrorSpy.mock.calls.some((args: unknown[]) =>
        String(args[0]).includes('ViewErrorBoundary caught an error:'),
      ),
    ).toBe(true);

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));

    expect(screen.getByTestId('view-ok')).toBeInTheDocument();
    expect(screen.queryByText('Error al mostrar esta vista')).toBeNull();
  });
});
