import { describe, it, expect } from 'vitest';
import { generateExplanation, generateUncertaintyReasons } from '@/lib/services/reasoning-service';
import type { Signal, DecisionResult } from '@/lib/types/reasoning';

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

function makeResult(overrides: Partial<DecisionResult>): DecisionResult {
  return {
    selected: null,
    allSignals: [],
    confidence: 0,
    confidenceLabel: 'low',
    explanation: '',
    uncertaintyReasons: [],
    source: 'unknown',
    ...overrides,
  };
}

describe('generateExplanation', () => {
  it('generates EntityContext template for entity_context signal', () => {
    const result = makeResult({
      selected: makeSignal({ source: 'entity_context', role: 'PROVEEDOR', glAccountCode: '6070', confidence: 0.95, reasoning: 'Context exists' }),
      source: 'entity_context',
      confidence: 0.95,
      confidenceLabel: 'high',
    });
    const explanation = generateExplanation(result, 'es');
    expect(explanation).toContain('PROVEEDOR');
    expect(explanation).toContain('95');
    expect(explanation).toContain('contexto previo');
  });

  it('generates heuristic template for heuristic signal', () => {
    const result = makeResult({
      selected: makeSignal({ source: 'heuristic', role: 'PROVEEDOR', glAccountCode: '6070', confidence: 0.9, reasoning: 'Keyword match', metadata: { matchedKeyword: 'proveedor' } }),
      source: 'heuristic',
      confidence: 0.9,
      confidenceLabel: 'high',
    });
    const explanation = generateExplanation(result, 'es');
    expect(explanation).toContain('PROVEEDOR');
    expect(explanation).toContain('90');
    expect(explanation).toContain('proveedor');
    expect(explanation).toContain('patrón conocido');
  });

  it('generates AI template for ai signal', () => {
    const result = makeResult({
      selected: makeSignal({ source: 'ai', role: 'CLIENTE', glAccountCode: '4010', confidence: 0.85, reasoning: 'AI suggestion' }),
      source: 'ai',
      confidence: 0.85,
      confidenceLabel: 'high',
    });
    const explanation = generateExplanation(result, 'es');
    expect(explanation).toContain('CLIENTE');
    expect(explanation).toContain('85');
    expect(explanation).toContain('asistente inteligente');
  });

  it('generates SIN_CLASIFICAR template when selected is null', () => {
    const result = makeResult({
      selected: null,
      allSignals: [
        makeSignal({ source: 'entity_context', role: null, confidence: 0, reasoning: '' }),
        makeSignal({ source: 'heuristic', role: null, confidence: 0, reasoning: '' }),
        makeSignal({ source: 'ai', role: null, confidence: 0, reasoning: '' }),
      ],
      confidence: 0,
      confidenceLabel: 'low',
      source: 'unknown',
      uncertaintyReasons: [
        'No hay un contexto previo para esta entidad',
        'La descripción del usuario no coincide con patrones conocidos',
      ],
    });
    const explanation = generateExplanation(result, 'es');
    expect(explanation).toContain('No se pudo clasificar con certeza');
    expect(explanation).toContain('No hay un contexto previo');
    expect(explanation).toContain('Revisión manual requerida');
  });

  it('uses English template when locale is en', () => {
    const result = makeResult({
      selected: makeSignal({ source: 'entity_context', role: 'PROVEEDOR', glAccountCode: '6070', confidence: 0.95, reasoning: 'Context exists' }),
      source: 'entity_context',
      confidence: 0.95,
      confidenceLabel: 'high',
    });
    const explanation = generateExplanation(result, 'en');
    expect(explanation).toContain('PROVEEDOR');
    expect(explanation).toContain('95');
    expect(explanation).toContain('previous context');
  });
});

describe('generateUncertaintyReasons', () => {
  it('reports missing entity context when entity_context signal has confidence 0', () => {
    const signals: Signal[] = [
      makeSignal({ source: 'entity_context', role: null, confidence: 0, reasoning: '' }),
    ];
    const reasons = generateUncertaintyReasons(signals, 'es');
    expect(reasons).toContain('No hay un contexto previo para esta entidad');
  });

  it('reports missing heuristic when heuristic signal has confidence 0', () => {
    const signals: Signal[] = [
      makeSignal({ source: 'entity_context', role: 'PROVEEDOR', confidence: 0.95, reasoning: 'Has context' }),
      makeSignal({ source: 'heuristic', role: null, confidence: 0, reasoning: '' }),
    ];
    const reasons = generateUncertaintyReasons(signals, 'es');
    expect(reasons).toContain('La descripción del usuario no coincide con patrones conocidos');
  });

  it('reports missing AI when ai signal has confidence 0', () => {
    const signals: Signal[] = [
      makeSignal({ source: 'ai', role: null, confidence: 0, reasoning: '' }),
    ];
    const reasons = generateUncertaintyReasons(signals, 'es');
    expect(reasons).toContain('El asistente inteligente no pudo determinar la clasificación');
  });

  it('returns empty array when all signals have confidence > 0', () => {
    const signals: Signal[] = [
      makeSignal({ source: 'entity_context', role: 'PROVEEDOR', confidence: 0.95, reasoning: 'Has context' }),
      makeSignal({ source: 'heuristic', role: 'PROVEEDOR', confidence: 0.9, reasoning: 'Keyword match' }),
      makeSignal({ source: 'ai', role: 'PROVEEDOR', confidence: 0.85, reasoning: 'AI' }),
    ];
    const reasons = generateUncertaintyReasons(signals, 'es');
    expect(reasons).toEqual([]);
  });

  it('handles empty signals array', () => {
    const reasons = generateUncertaintyReasons([], 'es');
    expect(reasons).toContain('No hay un contexto previo para esta entidad');
    expect(reasons).toContain('La descripción del usuario no coincide con patrones conocidos');
    expect(reasons).toContain('El asistente inteligente no pudo determinar la clasificación');
  });
});
