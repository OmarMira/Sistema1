// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StatCard } from '@/components/dashboard/DashboardPageBlocks';

const icon = <span data-testid="card-icon" />;

function renderCard(props: Partial<Parameters<typeof StatCard>[0]> = {}) {
  return render(
    <StatCard title="Total de Activos" value="$1.000" icon={icon} iconBg="bg-emerald-100" {...props} />,
  );
}

describe('StatCard — real deltas only', () => {
  it('renders no delta row when nothing was measured (no hardcoded percentage)', () => {
    renderCard();
    expect(screen.queryByText(/vs período anterior/)).toBeNull();
    expect(screen.queryByText(/12\.5%/)).toBeNull();
    expect(screen.queryByText(/vs last period/)).toBeNull();
  });

  it('renders a signed percentage with the comparison label when a delta exists', () => {
    renderCard({ delta: 8 });
    expect(screen.getByText('+8%')).toBeInTheDocument();
    expect(screen.getByText('vs período anterior')).toBeInTheDocument();
  });

  it('colors the delta by polarity: increase good vs increase bad', () => {
    const { rerender } = renderCard({ delta: -5, deltaUpIsGood: false });
    expect(screen.getByText('-5%').className).toContain('text-emerald-600');

    rerender(
      <StatCard
        title="Total de Activos"
        value="$1.000"
        icon={icon}
        iconBg="bg-emerald-100"
        delta={-5}
        deltaUpIsGood
      />,
    );
    expect(screen.getByText('-5%').className).toContain('text-rose-600');
  });

  it('hides the row for a zero delta instead of implying movement', () => {
    renderCard({ delta: 0 });
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.queryByText(/12\.5%/)).toBeNull();
  });
});
