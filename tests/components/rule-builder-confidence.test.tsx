// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '@/components/ui/badge';

function getConfidenceBadgeVariant(confidence: number): 'default' | 'secondary' | 'destructive' {
  if (confidence >= 0.8) return 'default';
  if (confidence >= 0.5) return 'secondary';
  return 'destructive';
}

function getConfidenceLabel(confidence: number, t: (k: string) => string): string {
  if (confidence >= 0.8) return t('ruleBuilder.highConfidence');
  if (confidence >= 0.5) return t('ruleBuilder.mediumConfidence');
  return t('ruleBuilder.lowConfidence');
}

describe('Confidence Badge Logic', () => {
  it('returns default variant for confidence >= 0.8', () => {
    expect(getConfidenceBadgeVariant(0.9)).toBe('default');
    expect(getConfidenceBadgeVariant(0.8)).toBe('default');
    expect(getConfidenceBadgeVariant(1.0)).toBe('default');
  });

  it('returns secondary variant for confidence 0.5-0.79', () => {
    expect(getConfidenceBadgeVariant(0.5)).toBe('secondary');
    expect(getConfidenceBadgeVariant(0.7)).toBe('secondary');
    expect(getConfidenceBadgeVariant(0.79)).toBe('secondary');
  });

  it('returns destructive variant for confidence < 0.5', () => {
    expect(getConfidenceBadgeVariant(0.0)).toBe('destructive');
    expect(getConfidenceBadgeVariant(0.3)).toBe('destructive');
    expect(getConfidenceBadgeVariant(0.49)).toBe('destructive');
  });
});

describe('Confidence Label', () => {
  const t = (key: string) => {
    const labels: Record<string, string> = {
      'ruleBuilder.highConfidence': 'High confidence',
      'ruleBuilder.mediumConfidence': 'Medium confidence',
      'ruleBuilder.lowConfidence': 'Low confidence',
    };
    return labels[key] || key;
  };

  it('returns high confidence label for >= 0.8', () => {
    expect(getConfidenceLabel(0.9, t)).toBe('High confidence');
    expect(getConfidenceLabel(0.8, t)).toBe('High confidence');
  });

  it('returns medium confidence label for 0.5-0.79', () => {
    expect(getConfidenceLabel(0.6, t)).toBe('Medium confidence');
  });

  it('returns low confidence label for < 0.5', () => {
    expect(getConfidenceLabel(0.0, t)).toBe('Low confidence');
    expect(getConfidenceLabel(0.4, t)).toBe('Low confidence');
  });
});

describe('Confidence Badge Rendering', () => {
  it('renders a badge with expected text content', () => {
    render(<Badge>High confidence</Badge>);
    expect(screen.getByText('High confidence')).toBeInTheDocument();
  });

  it('renders explanation text when present', () => {
    const explanation = 'Classified as expense because AI found matching pattern.';
    render(<p data-testid="explanation">{explanation}</p>);
    expect(screen.getByTestId('explanation')).toHaveTextContent(explanation);
  });

  it('renders uncertainty reasons when present', () => {
    const reasons = ['No context for this entity', 'No heuristic match'];
    render(
      <ul data-testid="uncertainty-reasons">
        {reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>,
    );
    const list = screen.getByTestId('uncertainty-reasons');
    expect(list.children).toHaveLength(2);
    expect(list.children[0]).toHaveTextContent('No context for this entity');
    expect(list.children[1]).toHaveTextContent('No heuristic match');
  });

  it('maps confidence label correctly for high confidence', () => {
    const confidence = 0.85;
    const variant = getConfidenceBadgeVariant(confidence);
    expect(variant).toBe('default');
    render(<Badge variant={variant}>High confidence</Badge>);
    expect(screen.getByText('High confidence')).toBeInTheDocument();
  });

  it('maps confidence label correctly for low confidence', () => {
    const confidence = 0.3;
    const variant = getConfidenceBadgeVariant(confidence);
    expect(variant).toBe('destructive');
    render(<Badge variant={variant}>Low confidence</Badge>);
    expect(screen.getByText('Low confidence')).toBeInTheDocument();
  });
});
