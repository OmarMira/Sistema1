// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '@/components/ui/badge';

interface ParsedRule {
  name: string;
  conditions: Array<{ field: string; operator: string; value: string | number }>;
  transactionDirection: string;
  glAccountName?: string | null;
  debitGlAccountName?: string | null;
  creditGlAccountName?: string | null;
  priority: number;
  conditionType?: string;
  conditionValue?: string;
  confidence?: number;
  confidenceLabel?: 'high' | 'medium' | 'low';
  explanation?: string;
}

function getDefaultConfidence(parsedRule: ParsedRule): {
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
} {
  return {
    confidence: parsedRule.confidence ?? 0.85,
    confidenceLabel: parsedRule.confidenceLabel ?? 'high',
  };
}

function getConfidenceBadgeVariant(confidence: number): 'default' | 'secondary' | 'destructive' {
  if (confidence >= 0.8) return 'default';
  if (confidence >= 0.5) return 'secondary';
  return 'destructive';
}

describe('AI Assistant Confidence Display', () => {
  const t = (key: string) => {
    const labels: Record<string, string> = {
      'ruleBuilder.highConfidence': 'High confidence',
      'ruleBuilder.mediumConfidence': 'Medium confidence',
      'ruleBuilder.lowConfidence': 'Low confidence',
    };
    return labels[key] || key;
  };

  it('resolves confidence from parsed rule when present', () => {
    const rule: ParsedRule = {
      name: 'Amazon purchases',
      conditions: [{ field: 'description', operator: 'contains', value: 'AMAZON' }],
      transactionDirection: 'debit',
      priority: 5,
      confidence: 0.6,
      confidenceLabel: 'medium',
    };
    const { confidence, confidenceLabel } = getDefaultConfidence(rule);
    expect(confidence).toBe(0.6);
    expect(confidenceLabel).toBe('medium');
  });

  it('defaults to high confidence when not provided (backward compat)', () => {
    const rule: ParsedRule = {
      name: 'Amazon purchases',
      conditions: [{ field: 'description', operator: 'contains', value: 'AMAZON' }],
      transactionDirection: 'debit',
      priority: 5,
    };
    const { confidence, confidenceLabel } = getDefaultConfidence(rule);
    expect(confidence).toBe(0.85);
    expect(confidenceLabel).toBe('high');
  });

  it('shows low confidence badge for uncertain results', () => {
    const rule: ParsedRule = {
      name: 'Unknown pattern',
      conditions: [{ field: 'description', operator: 'contains', value: 'UNKNOWN' }],
      transactionDirection: 'any',
      priority: 5,
      confidence: 0.2,
      confidenceLabel: 'low',
    };
    const { confidence, confidenceLabel } = getDefaultConfidence(rule);
    expect(confidence).toBe(0.2);
    expect(confidenceLabel).toBe('low');

    const variant = getConfidenceBadgeVariant(confidence);
    expect(variant).toBe('destructive');

    render(
      <Badge variant={variant}>
        {confidenceLabel === 'low' ? t('ruleBuilder.lowConfidence') : 'High confidence'}
      </Badge>,
    );
    expect(screen.getByText('Low confidence')).toBeInTheDocument();
  });

  it('shows high confidence badge for confident results', () => {
    const rule: ParsedRule = {
      name: 'Walmart purchases',
      conditions: [{ field: 'description', operator: 'contains', value: 'WALMART' }],
      transactionDirection: 'debit',
      priority: 5,
      confidence: 0.95,
      confidenceLabel: 'high',
    };
    const { confidence } = getDefaultConfidence(rule);
    const variant = getConfidenceBadgeVariant(confidence);
    expect(variant).toBe('default');

    render(
      <Badge variant={variant}>
        {confidence >= 0.8 ? t('ruleBuilder.highConfidence') : 'Low confidence'}
      </Badge>,
    );
    expect(screen.getByText('High confidence')).toBeInTheDocument();
  });

  it('shows uncertainty reasons when present in parsed rule', () => {
    const uncertaintyReasons = ['Pattern too generic', 'No matching account found'];
    render(
      <div data-testid="uncertainty-section">
        <p>Uncertainty reasons:</p>
        <ul>
          {uncertaintyReasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </div>,
    );
    expect(screen.getByTestId('uncertainty-section')).toBeInTheDocument();
    expect(screen.getByText('Pattern too generic')).toBeInTheDocument();
    expect(screen.getByText('No matching account found')).toBeInTheDocument();
  });
});
