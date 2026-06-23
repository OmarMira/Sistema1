import { describe, it, expect } from 'vitest';
import { validateLlmOutput } from '@/lib/llm-output-validator';

describe('llm-output-validator', () => {
  it('debe pasar si todos los montos existen textualmente en el PDF', () => {
    const rawText = `
Bank of America Statement
Date Description Amount
03/03 Zelle payment from RODRIGO OCHOA 1,100.00
03/10 Zelle payment to LQ&OM LLC -1,000.00
Ending balance 23,140.73
`;

    const transactions = [
      { amount: '1,100.00', description: 'Zelle payment from RODRIGO OCHOA' },
      { amount: '-1,000.00', description: 'Zelle payment to LQ&OM LLC' },
    ];

    const errors = validateLlmOutput(rawText, transactions);
    expect(errors).toHaveLength(0);
  });

  it('debe rechazar si un monto fue inventado (no está en el PDF)', () => {
    const rawText = `
Bank of America Statement
03/03 Zelle payment from RODRIGO OCHOA 1,100.00
03/10 Zelle payment to LQ&OM LLC -1,000.00
`;

    const transactions = [
      { amount: '1,100.00', description: 'Zelle payment from RODRIGO OCHOA' },
      { amount: '9,999.99', description: 'Hallucinated charge' },
    ];

    const errors = validateLlmOutput(rawText, transactions);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('9,999.99');
    expect(errors[0]).toContain('hallucination');
  });

  it('debe pasar si no hay transacciones (empty array)', () => {
    const errors = validateLlmOutput('some text', []);
    expect(errors).toHaveLength(0);
  });

  it('debe pasar si no hay campos monetaryos en la transaccion', () => {
    const rawText = 'Some text';
    const transactions = [{ description: 'just a note' }];
    const errors = validateLlmOutput(rawText, transactions);
    expect(errors).toHaveLength(0);
  });

  it('debe ignorar referencias cortas (no son montos)', () => {
    const rawText = 'Some text';
    const transactions = [{ reference: 'ab', description: 'short ref' }];
    const errors = validateLlmOutput(rawText, transactions);
    expect(errors).toHaveLength(0);
  });
});
