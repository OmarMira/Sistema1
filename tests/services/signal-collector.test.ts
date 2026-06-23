import { describe, it, expect } from 'vitest';
import {
  collectEntityContextSignal,
  collectHeuristicSignal,
  collectAISignal,
  collectSignals,
} from '@/lib/services/signal-collector';
import type { Signal } from '@/lib/types/reasoning';

const mockHeuristicRules = [
  { keywords: ['proveedor', 'contratista', 'vendor'], role: 'PROVEEDOR', glAccountCode: '6070', direction: 'any' },
  { keywords: ['socio', 'dueño', 'partner'], role: 'SOCIO', glAccountCode: '3010', direction: 'any' },
  { keywords: ['cliente', 'customer'], role: 'CLIENTE', glAccountCode: '4010', direction: 'any' },
];

describe('collectEntityContextSignal', () => {
  it('returns Signal with confidence 0.95 when context has role and glAccount', () => {
    const ctx = {
      role: 'PROVEEDOR',
      glAccountId: 'gla_1',
      glAccount: { code: '6070', name: 'Costo de Ventas' },
    };
    const signal = collectEntityContextSignal(ctx);
    expect(signal.source).toBe('entity_context');
    expect(signal.role).toBe('PROVEEDOR');
    expect(signal.glAccountCode).toBe('6070');
    expect(signal.confidence).toBe(0.95);
    expect(signal.reasoning).toBeTruthy();
  });

  it('returns Signal with confidence 0.75 when context has role but no glAccount', () => {
    const ctx = {
      role: 'CLIENTE',
      glAccountId: null,
      glAccount: null,
    };
    const signal = collectEntityContextSignal(ctx);
    expect(signal.source).toBe('entity_context');
    expect(signal.role).toBe('CLIENTE');
    expect(signal.glAccountCode).toBeNull();
    expect(signal.confidence).toBe(0.75);
  });

  it('returns Signal with confidence 0.0 when context is null', () => {
    const signal = collectEntityContextSignal(null);
    expect(signal.source).toBe('entity_context');
    expect(signal.role).toBeNull();
    expect(signal.glAccountCode).toBeNull();
    expect(signal.confidence).toBe(0.0);
  });
});

describe('collectHeuristicSignal', () => {
  it('returns HeuristicSignal with confidence >= 0.7 on keyword match', () => {
    const signal = collectHeuristicSignal('pago a proveedor por servicios', { heuristics: mockHeuristicRules });
    expect(signal.source).toBe('heuristic');
    expect(signal.role).toBe('PROVEEDOR');
    expect(signal.glAccountCode).toBe('6070');
    expect(signal.confidence).toBeGreaterThanOrEqual(0.7);
    expect(signal.metadata).toBeDefined();
  });

  it('returns Signal with confidence 0.0 when no keyword matches', () => {
    const signal = collectHeuristicSignal('transaccion sin clasificar', { heuristics: mockHeuristicRules });
    expect(signal.source).toBe('heuristic');
    expect(signal.role).toBeNull();
    expect(signal.glAccountCode).toBeNull();
    expect(signal.confidence).toBe(0.0);
  });

  it('matches exact entity name with confidence 0.9', () => {
    const signal = collectHeuristicSignal('socio', { heuristics: mockHeuristicRules });
    expect(signal.source).toBe('heuristic');
    expect(signal.role).toBe('SOCIO');
    expect(signal.confidence).toBe(0.9);
  });
});

describe('collectAISignal', () => {
  it('returns AISignal with confidence 0.85 when AI returns role and glAccountCode', () => {
    const signal = collectAISignal({ role: 'PROVEEDOR', glAccountCode: '6070' });
    expect(signal.source).toBe('ai');
    expect(signal.role).toBe('PROVEEDOR');
    expect(signal.glAccountCode).toBe('6070');
    expect(signal.confidence).toBe(0.85);
  });

  it('returns AISignal with confidence 0.6 when AI returns only role', () => {
    const signal = collectAISignal({ role: 'PROVEEDOR' });
    expect(signal.source).toBe('ai');
    expect(signal.role).toBe('PROVEEDOR');
    expect(signal.glAccountCode).toBeNull();
    expect(signal.confidence).toBe(0.6);
  });

  it('returns Signal with confidence 0.0 when AI response is null', () => {
    const signal = collectAISignal(null);
    expect(signal.source).toBe('ai');
    expect(signal.role).toBeNull();
    expect(signal.glAccountCode).toBeNull();
    expect(signal.confidence).toBe(0.0);
  });
});

describe('collectSignals', () => {
  it('returns all 3 signals regardless of confidence', () => {
    const signals = collectSignals({
      entityContext: null,
      userInput: 'unknown transaction',
      direction: 'mixed',
      assistantConfig: { heuristics: mockHeuristicRules },
      aiResponse: null,
    });
    expect(signals).toHaveLength(3);
    const sources = signals.map((s: Signal) => s.source);
    expect(sources).toContain('entity_context');
    expect(sources).toContain('heuristic');
    expect(sources).toContain('ai');
  });

  it('includes high-confidence entity context signal when available', () => {
    const signals = collectSignals({
      entityContext: { role: 'PROVEEDOR', glAccountId: 'gla_1', glAccount: { code: '6070', name: 'Costo de Ventas' } },
      userInput: 'pago a proveedor',
      direction: 'debit',
      assistantConfig: { heuristics: mockHeuristicRules },
      aiResponse: null,
    });
    const entitySignal = signals.find((s: Signal) => s.source === 'entity_context');
    expect(entitySignal).toBeDefined();
    expect(entitySignal!.confidence).toBe(0.95);
  });
});
