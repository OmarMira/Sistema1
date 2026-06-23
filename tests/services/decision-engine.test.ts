import { describe, it, expect } from 'vitest';
import { decide } from '@/lib/services/decision-engine';
import type { Signal } from '@/lib/types/reasoning';

function makeSignal(overrides: Partial<Signal>): Signal {
  return {
    source: 'unknown',
    role: null,
    glAccountCode: null,
    confidence: 0,
    reasoning: '',
    ...overrides,
  };
}

describe('decide', () => {
  it('returns the highest confidence signal when any signal >= 0.9', () => {
    const signals: Signal[] = [
      makeSignal({ source: 'entity_context', role: 'PROVEEDOR', glAccountCode: '6070', confidence: 0.95, reasoning: 'Context exists' }),
      makeSignal({ source: 'heuristic', role: 'PROVEEDOR', glAccountCode: '6070', confidence: 0.7, reasoning: 'Heuristic match' }),
      makeSignal({ source: 'ai', role: 'CLIENTE', glAccountCode: '4010', confidence: 0.5, reasoning: 'AI guess' }),
    ];
    const result = decide(signals);
    expect(result.selected).not.toBeNull();
    expect(result.selected!.source).toBe('entity_context');
    expect(result.confidence).toBe(0.95);
    expect(result.confidenceLabel).toBe('high');
  });

  it('uses heuristic when it has confidence >= 0.7 and is a specific match', () => {
    const signals: Signal[] = [
      makeSignal({ source: 'entity_context', role: null, confidence: 0, reasoning: 'No context' }),
      makeSignal({ source: 'heuristic', role: 'PROVEEDOR', glAccountCode: '6070', confidence: 0.7, reasoning: 'Keyword match', metadata: { matchedKeyword: 'proveedor' } }),
      makeSignal({ source: 'ai', role: 'CLIENTE', glAccountCode: '4010', confidence: 0.85, reasoning: 'AI suggestion' }),
    ];
    const result = decide(signals);
    expect(result.selected).not.toBeNull();
    expect(result.selected!.source).toBe('heuristic');
    expect(result.selected!.role).toBe('PROVEEDOR');
  });

  it('uses EntityContext when heuristic has no match and entityContext >= 0.7', () => {
    const signals: Signal[] = [
      makeSignal({ source: 'entity_context', role: 'PROVEEDOR', glAccountCode: '6070', confidence: 0.95, reasoning: 'Context exists' }),
      makeSignal({ source: 'heuristic', role: null, confidence: 0, reasoning: 'No match' }),
      makeSignal({ source: 'ai', role: 'CLIENTE', glAccountCode: '4010', confidence: 0.5, reasoning: 'Low conf' }),
    ];
    const result = decide(signals);
    expect(result.selected).not.toBeNull();
    expect(result.selected!.source).toBe('entity_context');
  });

  it('uses AI when it has confidence >= 0.7 and no other signal qualifies', () => {
    const signals: Signal[] = [
      makeSignal({ source: 'entity_context', role: null, confidence: 0, reasoning: 'No context' }),
      makeSignal({ source: 'heuristic', role: null, confidence: 0, reasoning: 'No match' }),
      makeSignal({ source: 'ai', role: 'PROVEEDOR', glAccountCode: '6070', confidence: 0.85, reasoning: 'AI suggestion' }),
    ];
    const result = decide(signals);
    expect(result.selected).not.toBeNull();
    expect(result.selected!.source).toBe('ai');
    expect(result.selected!.role).toBe('PROVEEDOR');
  });

  it('returns selected:null (SIN_CLASIFICAR) when all signals have confidence < 0.5', () => {
    const signals: Signal[] = [
      makeSignal({ source: 'entity_context', role: null, confidence: 0, reasoning: 'No context' }),
      makeSignal({ source: 'heuristic', role: null, confidence: 0, reasoning: 'No match' }),
      makeSignal({ source: 'ai', role: null, confidence: 0, reasoning: 'No AI' }),
    ];
    const result = decide(signals);
    expect(result.selected).toBeNull();
    expect(result.source).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.uncertaintyReasons.length).toBeGreaterThan(0);
  });

  it('sets confidenceLabel to medium when highest signal is >= 0.5 but < 0.8', () => {
    const signals: Signal[] = [
      makeSignal({ source: 'entity_context', role: null, confidence: 0, reasoning: 'No context' }),
      makeSignal({ source: 'heuristic', role: 'PROVEEDOR', glAccountCode: '6070', confidence: 0.7, reasoning: 'Keyword match', metadata: { matchedKeyword: 'proveedor' } }),
      makeSignal({ source: 'ai', role: null, confidence: 0, reasoning: 'No AI' }),
    ];
    const result = decide(signals);
    expect(result.selected).not.toBeNull();
    expect(result.confidence).toBe(0.7);
    expect(result.confidenceLabel).toBe('medium');
  });

  it('sets confidenceLabel to high when highest signal >= 0.8', () => {
    const signals: Signal[] = [
      makeSignal({ source: 'entity_context', role: 'PROVEEDOR', glAccountCode: '6070', confidence: 0.95, reasoning: 'Context' }),
    ];
    const result = decide(signals);
    expect(result.confidenceLabel).toBe('high');
  });

  it('sets confidenceLabel to low when highest signal < 0.5', () => {
    const signals: Signal[] = [
      makeSignal({ source: 'ai', role: 'PROVEEDOR', glAccountCode: '6070', confidence: 0.3, reasoning: 'Low AI' }),
    ];
    const result = decide(signals);
    expect(result.confidenceLabel).toBe('low');
  });

  it('uses highest signal >= 0.5 when no signal >= 0.7', () => {
    const signals: Signal[] = [
      makeSignal({ source: 'entity_context', role: 'PROVEEDOR', glAccountCode: '6070', confidence: 0.6, reasoning: 'Partial context' }),
      makeSignal({ source: 'heuristic', role: null, confidence: 0, reasoning: 'No match' }),
      makeSignal({ source: 'ai', role: null, confidence: 0, reasoning: 'No AI' }),
    ];
    const result = decide(signals);
    expect(result.selected).not.toBeNull();
    expect(result.selected!.source).toBe('entity_context');
    expect(result.confidenceLabel).toBe('medium');
  });

  it('returns selected:null for empty signals array', () => {
    const result = decide([]);
    expect(result.selected).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.confidenceLabel).toBe('low');
  });
});
